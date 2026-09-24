import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
  createTestEmployee,
} from "./helpers.js";
import { computeExpectedCash } from "../utils/salePayments.js";
import { postShiftSalaryAdvance } from "../services/advanceRequestService.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function startShift(app, token, db, opening) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  const shiftId = unwrap(res.body).shift_id;
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shiftId]);
  return db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
}

async function endToPending(app, token, shiftId) {
  const res = await request(app).post(`/api/v1/shifts/${shiftId}/end`).set(authHeader(token)).send({});
  expect(res.status).toBe(200);
  return unwrap(res.body);
}

async function snapshotBooks(db, shiftId, productId, employeeId) {
  const product = await db.get("SELECT stock FROM products WHERE id = ?", [productId]);
  const sales = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(CASE WHEN payment_method = 'visa' THEN total ELSE 0 END),0) AS visa
     FROM transactions WHERE shift_id = ?`,
    [shiftId]
  );
  const profit = await db.get(
    `SELECT COALESCE(SUM(ti.gross_profit),0) AS p
     FROM transaction_items ti
     JOIN transactions t ON t.id = ti.transaction_id
     WHERE t.shift_id = ?`,
    [shiftId]
  );
  const ledger = await db.all(
    "SELECT * FROM employee_ledger_entries WHERE employee_id = ? AND purpose = 'salary_advance'",
    [employeeId]
  );
  const opex = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
  return {
    stock: Number(product.stock),
    saleCount: Number(sales.n),
    saleTotal: Number(sales.total),
    visa: Number(sales.visa),
    profit: Number(profit.p),
    ledgerCount: ledger.length,
    opex: Number(opex.n),
  };
}

describe("office count-dialog salary advance", () => {
  let ctx;
  let adminToken;
  let adminId;
  let cashierToken;
  let cashierId;
  let otherToken;
  let employeeId;
  let otherEmployeeId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    adminId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"])).id;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"])).id;
    const otherHash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["till-adv", otherHash]
    );
    otherToken = (await login(ctx.app, "till-adv", "cashpass123", "pos")).body.token;
    employeeId = (await createTestEmployee(ctx.db, { name: "سامي العد" })).id;
    otherEmployeeId = (await createTestEmployee(ctx.db, { name: "ليلى" })).id;
    await createTestEmployee(ctx.db, { name: "خالد", active: 0 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("lookup is directory fields only and cashiers cannot use the office route", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/shifts/employee-options?q=سامي")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    const row = rows.find((r) => r.id === employeeId);
    expect(row).toEqual({
      id: employeeId,
      name: "سامي العد",
      employee_no: employeeId,
      display_name: "سامي العد",
    });
    expect(row).not.toHaveProperty("salary");
    expect(row).not.toHaveProperty("hourly_rate");
    expect(rows.some((r) => r.name === "خالد")).toBe(false);

    const cashierLookup = await request(ctx.app)
      .get("/api/v1/shifts/employee-options")
      .set(authHeader(cashierToken));
    expect(cashierLookup.status).toBe(403);

    const shift = await startShift(ctx.app, cashierToken, ctx.db, 77.5);
    await endToPending(ctx.app, cashierToken, shift.id);
    const cashierPost = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(cashierToken))
      .send({
        employee_id: employeeId,
        amount: 20,
        idempotency_key: "office-adv-cashier-forbid",
      });
    expect(cashierPost.status).toBe(403);
  });

  test("records 20 against expected 77.50 once and keeps sales books unchanged", async () => {
    const shift = await ctx.db.get(
      "SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [
      "2026-09-20",
      shift.id,
    ]);
    const before = await snapshotBooks(ctx.db, shift.id, ctx.productId, employeeId);
    expect(await computeExpectedCash(ctx.db, shift.id, 77.5)).toBe(77.5);

    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: employeeId,
        amount: 20,
        notes: "سلف منسية",
        idempotency_key: "office-adv-20-aaaaaaa",
      });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    expect(body.replayed).toBe(false);
    expect(Number(body.amount)).toBe(20);
    expect(Number(body.expected_cash)).toBe(57.5);
    expect(Number(body.shift_id)).toBe(shift.id);
    expect(Number(body.recorded_by_id)).toBe(adminId);
    expect(body.recorded_by_name).toBe("testadmin");
    expect(body.employee_name).toBe("سامي العد");

    expect(await computeExpectedCash(ctx.db, shift.id, 77.5)).toBe(57.5);
    const after = await snapshotBooks(ctx.db, shift.id, ctx.productId, employeeId);
    expect(after.ledgerCount).toBe(before.ledgerCount + 1);
    expect(after.opex).toBe(before.opex + 1);
    expect(after.stock).toBe(before.stock);
    expect(after.saleCount).toBe(before.saleCount);
    expect(after.saleTotal).toBe(before.saleTotal);
    expect(after.visa).toBe(before.visa);
    expect(after.profit).toBe(before.profit);

    const requestRow = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [
      body.request_id,
    ]);
    expect(requestRow.status).toBe("approved");
    expect(requestRow.decision_source).toBe("shift_count");
    expect(Number(requestRow.cashier_id)).toBe(cashierId);
    expect(Number(requestRow.manager_id)).toBe(adminId);
    expect(Number(requestRow.shift_id)).toBe(shift.id);
    expect(requestRow.telegram_message_id).toBeFalsy();

    const ledger = await ctx.db.get(
      "SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?",
      [body.request_id]
    );
    expect(ledger.purpose).toBe("salary_advance");
    expect(Number(ledger.amount)).toBe(20);
    expect(ledger.occurred_on).toBe("2026-09-20");
    expect(Number(ledger.created_by)).toBe(adminId);

    const moves = await ctx.db.all(
      "SELECT * FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'advance'",
      [shift.id]
    );
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].amount)).toBe(-20);
    expect(Number(moves[0].advance_request_id)).toBe(body.request_id);

    const liveShift = await ctx.db.get("SELECT cashier_id, status FROM cashier_shifts WHERE id = ?", [
      shift.id,
    ]);
    expect(Number(liveShift.cashier_id)).toBe(cashierId);
    expect(liveShift.status).toBe("pending_count");

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(Number(detail.summary.expected)).toBe(57.5);
    expect(Number(detail.summary.advances_total)).toBe(20);
    expect(detail.advances).toHaveLength(1);
    expect(detail.shift.status).toBe("pending_count");
  });

  test("replays the same key, rejects a changed payload, and accepts a second key", async () => {
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    const first = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: employeeId,
        amount: 5,
        notes: "إعادة",
        idempotency_key: "office-adv-replay-bbbb",
      });
    expect(first.status).toBe(201);
    const replay = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: employeeId,
        amount: 5,
        notes: "إعادة",
        idempotency_key: "office-adv-replay-bbbb",
      });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).replayed).toBe(true);
    expect(unwrap(replay.body).request_id).toBe(unwrap(first.body).request_id);

    const mismatch = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: otherEmployeeId,
        amount: 6,
        notes: "إعادة",
        idempotency_key: "office-adv-replay-bbbb",
      });
    expect(mismatch.status).toBe(409);

    const second = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: employeeId,
        amount: 5,
        notes: "سلف ثانية",
        idempotency_key: "office-adv-second-cccc",
      });
    expect(second.status).toBe(201);
    expect(unwrap(second.body).request_id).not.toBe(unwrap(first.body).request_id);
    expect(
      Number(
        (
          await ctx.db.get(
            "SELECT COUNT(*) AS n FROM advance_requests WHERE shift_id = ? AND status = 'approved'",
            [shift.id]
          )
        ).n
      )
    ).toBe(3);
  });

  test("rejects an open shift, a closed shift, and another cashier's shift", async () => {
    const open = await startShift(ctx.app, otherToken, ctx.db, 40);
    const onOpen = await request(ctx.app)
      .post(`/api/v1/shifts/${open.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: otherEmployeeId,
        amount: 1,
        idempotency_key: "office-adv-open-dddddd",
      });
    expect(onOpen.status).toBe(400);
    expect(onOpen.body.code || unwrap(onOpen.body)?.code).toBe("NOT_PENDING");

    await endToPending(ctx.app, otherToken, open.id);
    const selected = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    const paySelected = await request(ctx.app)
      .post(`/api/v1/shifts/${selected.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: otherEmployeeId,
        amount: 2,
        idempotency_key: "office-adv-selected-eeee",
      });
    expect(paySelected.status).toBe(201);
    expect(
      Number(
        (
          await ctx.db.get(
            "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'advance'",
            [open.id]
          )
        ).n
      )
    ).toBe(0);

    const recon = await request(ctx.app)
      .post(`/api/v1/shifts/${open.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: 40 });
    expect([200, 202]).toContain(recon.status);

    const onClosed = await request(ctx.app)
      .post(`/api/v1/shifts/${open.id}/advances`)
      .set(authHeader(adminToken))
      .send({
        employee_id: otherEmployeeId,
        amount: 1,
        idempotency_key: "office-adv-closed-ffff",
      });
    expect(onClosed.status).toBe(400);
    expect(onClosed.body.code || unwrap(onClosed.body)?.code).toBe("SHIFT_CLOSED");
    expect(
      Number(
        (await ctx.db.get("SELECT COUNT(*) AS n FROM advance_requests WHERE idempotency_key = ?", [
          "office-adv-closed-ffff",
        ])).n
      )
    ).toBe(0);
  });

  test("accountant without payroll or shift_audit is rejected", async () => {
    await createAccountantUser(ctx.db, {
      username: "acct-audit-only",
      password: "acctpass123",
      permissions: { shift_audit: true },
    });
    const auditOnly = (await login(ctx.app, "acct-audit-only", "acctpass123")).body.token;
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'pending_count' ORDER BY id DESC LIMIT 1"
    );
    const noPayroll = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(auditOnly))
      .send({
        employee_id: employeeId,
        amount: 1,
        idempotency_key: "office-adv-acct-gggggg",
      });
    expect(noPayroll.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "acct-no-audit-adv",
      password: "acctpass123",
      permissions: { shift_audit: false, advance_approvals: true, employee_payroll: true },
    });
    const noAudit = (await login(ctx.app, "acct-no-audit-adv", "acctpass123")).body.token;
    const blocked = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/advances`)
      .set(authHeader(noAudit))
      .send({
        employee_id: employeeId,
        amount: 1,
        idempotency_key: "office-adv-acct2-hhhh",
      });
    expect(blocked.status).toBe(403);
  });

  test("concurrent post and reconcile stay consistent", async () => {
    const shift = await startShift(ctx.app, otherToken, ctx.db, 77.5);
    await endToPending(ctx.app, otherToken, shift.id);
    const [pay, close] = await Promise.all([
      request(ctx.app).post(`/api/v1/shifts/${shift.id}/advances`).set(authHeader(adminToken)).send({
        employee_id: otherEmployeeId,
        amount: 20,
        idempotency_key: "office-adv-race-iiiiii",
      }),
      request(ctx.app)
        .post(`/api/v1/shifts/${shift.id}/reconcile`)
        .set(authHeader(adminToken))
        .send({ closing_cash: 77.5 }),
    ]);
    expect([200, 201, 400].includes(pay.status)).toBe(true);
    expect([200, 202, 400].includes(close.status)).toBe(true);
    const requests = await ctx.db.all("SELECT id FROM advance_requests WHERE idempotency_key = ?", [
      "office-adv-race-iiiiii",
    ]);
    const moves = await ctx.db.all(
      "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'advance'",
      [shift.id]
    );
    const closed = await ctx.db.get("SELECT expected_cash, status FROM cashier_shifts WHERE id = ?", [
      shift.id,
    ]);
    if (pay.status === 201 || pay.status === 200) {
      expect(requests).toHaveLength(1);
      expect(moves).toHaveLength(1);
      if (closed.status === "closed") {
        expect(Number(closed.expected_cash)).toBe(57.5);
      }
    } else {
      expect(requests).toHaveLength(0);
      expect(moves).toHaveLength(0);
      if (closed.status === "closed") {
        expect(Number(closed.expected_cash)).toBe(77.5);
      }
    }
  });

  test("rolls back the request when the movement insert fails", async () => {
    const shift = await ctx.db.get(
      "SELECT * FROM cashier_shifts WHERE status = 'pending_count' ORDER BY id DESC LIMIT 1"
    );
    expect(shift).toBeTruthy();
    const beforeRequests = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM advance_requests")).n);
    const beforeLedger = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n);
    const beforeOpex = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n);
    const originalRun = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (...args) => {
      if (
        typeof args[0] === "string" &&
        args[0].includes("movement_type") &&
        args[0].includes("advance")
      ) {
        throw new Error("forced movement failure");
      }
      return originalRun(...args);
    };
    const admin = await ctx.db.get("SELECT * FROM users WHERE id = ?", [adminId]);
    await expect(
      postShiftSalaryAdvance(ctx.db, {
        shiftId: shift.id,
        userId: adminId,
        user: { ...admin, role: "admin" },
        employeeId,
        amount: 3,
        idempotencyKey: "office-adv-rollback-jjjj",
      })
    ).rejects.toThrow(/forced movement failure/);
    ctx.db.run = originalRun;
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM advance_requests")).n)).toBe(
      beforeRequests
    );
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n)).toBe(
      beforeLedger
    );
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)).toBe(
      beforeOpex
    );
    expect((await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shift.id])).status).toBe(
      "pending_count"
    );
  });
});
