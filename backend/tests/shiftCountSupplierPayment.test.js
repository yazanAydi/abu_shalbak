import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
} from "./helpers.js";
import { computeExpectedCash } from "../utils/salePayments.js";
import { postShiftSupplierPayment } from "../services/posSupplierPaymentService.js";

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

async function snapshotBooks(db, shiftId, productId, supplierId) {
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
  const supplier = await db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
  const opex = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
  return {
    stock: Number(product.stock),
    saleCount: Number(sales.n),
    saleTotal: Number(sales.total),
    visa: Number(sales.visa),
    profit: Number(profit.p),
    supplierBalance: Number(supplier.balance),
    opex: Number(opex.n),
  };
}

describe("office count-dialog supplier payment", () => {
  let ctx;
  let adminToken;
  let adminId;
  let cashierToken;
  let cashierId;
  let otherToken;
  let supplierId;
  let otherSupplierId;

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
      ["till-b", otherHash]
    );
    otherToken = (await login(ctx.app, "till-b", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد العد', 'S-CNT-1', 200, 200)`
    );
    supplierId = sup.lastID;
    const otherSup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد آخر', 'S-CNT-2', 80, 80)`
    );
    otherSupplierId = otherSup.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("lookup is id/name only and cashiers cannot use the office route", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/shifts/supplier-options?q=العد")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    const row = rows.find((r) => r.id === supplierId);
    expect(row).toEqual({ id: supplierId, name: "مورد العد" });
    expect(row).not.toHaveProperty("balance");

    const cashierLookup = await request(ctx.app)
      .get("/api/v1/shifts/supplier-options")
      .set(authHeader(cashierToken));
    expect(cashierLookup.status).toBe(403);

    const shift = await startShift(ctx.app, cashierToken, ctx.db, 77.5);
    await endToPending(ctx.app, cashierToken, shift.id);
    const cashierPost = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 20,
        idempotency_key: "office-cnt-cashier-forbid",
      });
    expect(cashierPost.status).toBe(403);
  });

  test("records 20 against expected 77.50 once and keeps books otherwise unchanged", async () => {
    const shift = await ctx.db.get(
      "SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [
      "2026-09-20",
      shift.id,
    ]);
    const before = await snapshotBooks(ctx.db, shift.id, ctx.productId, supplierId);
    expect(await computeExpectedCash(ctx.db, shift.id, 77.5)).toBe(77.5);

    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 20,
        notes: "دفعة منسية",
        idempotency_key: "office-cnt-20-aaaaaaa",
      });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    expect(body.replayed).toBe(false);
    expect(Number(body.amount)).toBe(20);
    expect(Number(body.expected_cash)).toBe(57.5);
    expect(Number(body.shift_id)).toBe(shift.id);
    expect(Number(body.recorded_by_id)).toBe(adminId);
    expect(body.recorded_by_name).toBe("testadmin");

    const expected = await computeExpectedCash(ctx.db, shift.id, 77.5);
    expect(expected).toBe(57.5);
    const after = await snapshotBooks(ctx.db, shift.id, ctx.productId, supplierId);
    expect(after.supplierBalance).toBe(180);
    expect(after.stock).toBe(before.stock);
    expect(after.saleCount).toBe(before.saleCount);
    expect(after.saleTotal).toBe(before.saleTotal);
    expect(after.visa).toBe(before.visa);
    expect(after.profit).toBe(before.profit);
    expect(after.opex).toBe(before.opex);

    const vouchers = await ctx.db.all(
      "SELECT * FROM vouchers WHERE shift_id = ? AND voucher_type = 'payment'",
      [shift.id]
    );
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].voucher_date).toBe("2026-09-20");
    expect(Number(vouchers[0].recorded_by_id)).toBe(adminId);
    expect(Number(vouchers[0].shift_id)).toBe(shift.id);
    const liveShift = await ctx.db.get("SELECT cashier_id, status FROM cashier_shifts WHERE id = ?", [
      shift.id,
    ]);
    expect(Number(liveShift.cashier_id)).toBe(cashierId);
    expect(liveShift.status).toBe("pending_count");

    const moves = await ctx.db.all(
      "SELECT * FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
      [shift.id]
    );
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].amount)).toBe(-20);
    expect(Number(moves[0].voucher_id)).toBe(vouchers[0].id);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM supplier_payments WHERE supplier_id = ?", [supplierId])).n)
    ).toBe(0);

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(Number(detail.summary.expected)).toBe(57.5);
    expect(Number(detail.summary.supplier_payments_total)).toBe(20);
    expect(detail.supplier_payments).toHaveLength(1);
    expect(detail.shift.status).toBe("pending_count");

    const ledger = unwrap(
      (await request(ctx.app).get(`/api/v1/suppliers/${supplierId}/ledger`).set(authHeader(adminToken))).body
    );
    const payEvents = (ledger.events || []).filter((row) => row.ev_type === "payment");
    expect(payEvents).toHaveLength(1);
    expect(Number(payEvents[0].debit)).toBe(20);
  });

  test("replays the same key, rejects a changed payload, and accepts a second key", async () => {
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    const first = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        notes: "إعادة",
        idempotency_key: "office-cnt-replay-bbbb",
      });
    expect(first.status).toBe(201);
    const replay = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        notes: "إعادة",
        idempotency_key: "office-cnt-replay-bbbb",
      });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).replayed).toBe(true);
    expect(unwrap(replay.body).voucher_id).toBe(unwrap(first.body).voucher_id);

    const mismatch = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: otherSupplierId,
        amount: 6,
        notes: "إعادة",
        idempotency_key: "office-cnt-replay-bbbb",
      });
    expect(mismatch.status).toBe(409);

    const second = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        notes: "دفعة ثانية",
        idempotency_key: "office-cnt-second-cccc",
      });
    expect(second.status).toBe(201);
    expect(unwrap(second.body).voucher_id).not.toBe(unwrap(first.body).voucher_id);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers WHERE shift_id = ?", [shift.id])).n)
    ).toBe(3);
  });

  test("rejects an open shift, a closed shift, and another cashier's shift", async () => {
    const open = await startShift(ctx.app, otherToken, ctx.db, 40);
    const onOpen = await request(ctx.app)
      .post(`/api/v1/shifts/${open.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: otherSupplierId,
        amount: 1,
        idempotency_key: "office-cnt-open-dddddd",
      });
    expect(onOpen.status).toBe(400);
    expect(onOpen.body.code || unwrap(onOpen.body)?.code).toBe("NOT_PENDING");

    await endToPending(ctx.app, otherToken, open.id);
    const otherShift = open;
    const selected = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'pending_count' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    const paySelected = await request(ctx.app)
      .post(`/api/v1/shifts/${selected.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: otherSupplierId,
        amount: 2,
        idempotency_key: "office-cnt-selected-eeee",
      });
    expect(paySelected.status).toBe(201);
    expect(
      Number(
        (
          await ctx.db.get(
            "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
            [otherShift.id]
          )
        ).n
      )
    ).toBe(0);

    const recon = await request(ctx.app)
      .post(`/api/v1/shifts/${otherShift.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: 40 });
    expect([200, 202]).toContain(recon.status);

    const onClosed = await request(ctx.app)
      .post(`/api/v1/shifts/${otherShift.id}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: otherSupplierId,
        amount: 1,
        idempotency_key: "office-cnt-closed-ffff",
      });
    expect(onClosed.status).toBe(400);
    expect(onClosed.body.code || unwrap(onClosed.body)?.code).toBe("SHIFT_CLOSED");
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers WHERE idempotency_key = ?", ["office-cnt-closed-ffff"])).n)
    ).toBe(0);
  });

  test("accountant without shift_audit is rejected", async () => {
    await createAccountantUser(ctx.db, {
      username: "acct-no-audit",
      password: "acctpass123",
      permissions: { shift_audit: false },
    });
    const token = (await login(ctx.app, "acct-no-audit", "acctpass123")).body.token;
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'pending_count' ORDER BY id DESC LIMIT 1"
    );
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/supplier-payments`)
      .set(authHeader(token))
      .send({
        supplier_id: supplierId,
        amount: 1,
        idempotency_key: "office-cnt-acct-gggggg",
      });
    expect(res.status).toBe(403);
  });

  test("concurrent post and reconcile stay consistent", async () => {
    const shift = await startShift(ctx.app, otherToken, ctx.db, 77.5);
    await endToPending(ctx.app, otherToken, shift.id);
    const [pay, close] = await Promise.all([
      request(ctx.app).post(`/api/v1/shifts/${shift.id}/supplier-payments`).set(authHeader(adminToken)).send({
        supplier_id: otherSupplierId,
        amount: 20,
        idempotency_key: "office-cnt-race-hhhhhh",
      }),
      request(ctx.app)
        .post(`/api/v1/shifts/${shift.id}/reconcile`)
        .set(authHeader(adminToken))
        .send({ closing_cash: 77.5 }),
    ]);
    expect([200, 201, 400].includes(pay.status)).toBe(true);
    expect([200, 202, 400].includes(close.status)).toBe(true);
    const vouchers = await ctx.db.all("SELECT id FROM vouchers WHERE idempotency_key = ?", [
      "office-cnt-race-hhhhhh",
    ]);
    const moves = await ctx.db.all(
      "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
      [shift.id]
    );
    const closed = await ctx.db.get("SELECT expected_cash, status FROM cashier_shifts WHERE id = ?", [
      shift.id,
    ]);
    if (pay.status === 201 || pay.status === 200) {
      expect(vouchers).toHaveLength(1);
      expect(moves).toHaveLength(1);
      if (closed.status === "closed") {
        expect(Number(closed.expected_cash)).toBe(57.5);
      }
    } else {
      expect(vouchers).toHaveLength(0);
      expect(moves).toHaveLength(0);
      if (closed.status === "closed") {
        expect(Number(closed.expected_cash)).toBe(77.5);
      }
    }
  });

  test("rolls back the voucher when the movement insert fails", async () => {
    const shift = await ctx.db.get(
      "SELECT * FROM cashier_shifts WHERE status = 'pending_count' ORDER BY id DESC LIMIT 1"
    );
    expect(shift).toBeTruthy();
    const beforeBalance = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );
    const beforeVouchers = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n);
    const originalRun = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (...args) => {
      if (typeof args[0] === "string" && args[0].includes("supplier_payment")) {
        throw new Error("forced movement failure");
      }
      return originalRun(...args);
    };
    await expect(
      postShiftSupplierPayment(ctx.db, {
        shiftId: shift.id,
        userId: adminId,
        supplierId,
        amount: 3,
        idempotencyKey: "office-cnt-rollback-iiii",
      })
    ).rejects.toThrow(/forced movement failure/);
    ctx.db.run = originalRun;
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n)).toBe(beforeVouchers);
    expect(
      Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)
    ).toBe(beforeBalance);
    expect((await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shift.id])).status).toBe(
      "pending_count"
    );
  });
});
