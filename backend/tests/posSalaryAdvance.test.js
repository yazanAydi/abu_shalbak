import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createTestEmployee,
  createAccountantUser,
  configureTelegramApprover,
} from "./helpers.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";
import { listPosEmployeeDirectory } from "../services/employeeService.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function startShiftWithCash(app, token, db, opening = 500) {
  await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  const shift = await db.get(
    "SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
  );
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shift.id]);
  return shift;
}

describe("POS salary advance (employee_id + payment service)", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let adminId;

  beforeAll(async () => {
    ctx = await createTestContext();
    await configureTelegramApprover(ctx.db);
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const admin = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    adminId = admin.id;
    cashierId = cashier.id;
    await startShiftWithCash(ctx.app, cashierToken, ctx.db, 800);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("POS lookup returns only id, name, employee_no, display_name", async () => {
    const a = await createTestEmployee(ctx.db, { name: "سامي" });
    const b = await createTestEmployee(ctx.db, { name: "سامي" });
    await createTestEmployee(ctx.db, { name: "خالد", active: 0 });

    const res = await request(ctx.app)
      .get("/api/v1/pos/employees")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    expect(Array.isArray(rows)).toBe(true);
    const sami = rows.filter((r) => r.name === "سامي");
    expect(sami).toHaveLength(2);
    expect(sami.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    for (const row of sami) {
      expect(row.display_name).toBe(`سامي · رقم ${row.id}`);
      expect(row.employee_no).toBe(row.id);
      expect(row).not.toHaveProperty("hourly_rate");
      expect(row).not.toHaveProperty("salary");
      expect(row).not.toHaveProperty("balance");
      expect(Object.keys(row).sort()).toEqual(["display_name", "employee_no", "id", "name"]);
    }
    expect(rows.some((r) => r.name === "خالد")).toBe(false);

    const office = await request(ctx.app)
      .get("/api/v1/employees")
      .set(authHeader(cashierToken));
    expect(office.status).toBe(403);
  });

  test("listPosEmployeeDirectory disambiguates duplicate names only", () => {
    const rows = listPosEmployeeDirectory([
      { id: 1, name: "منى" },
      { id: 2, name: "ليلى" },
      { id: 3, name: "منى" },
    ]);
    expect(rows.find((r) => r.id === 1).display_name).toBe("منى · رقم 1");
    expect(rows.find((r) => r.id === 2).display_name).toBe("ليلى");
    expect(rows.find((r) => r.id === 3).display_name).toBe("منى · رقم 3");
  });

  test("create requires employee_id and rejects free-text name", async () => {
    const named = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_name: "أحمد", amount: 20 });
    expect(named.status).toBe(400);

    const missing = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ amount: 20 });
    expect(missing.status).toBe(400);
    expect(unwrap(missing.body).error || missing.body.error).toMatch(/اختر الموظف/);

    const unknown = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: 999999, amount: 20 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code || unwrap(unknown.body).code).toBe("EMPLOYEE_NOT_FOUND");
  });

  test("pending and rejected requests have no financial effect", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "معلّق" });
    const beforeExp = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const beforeLed = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries");
    const beforeMov = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'"
    );

    const createRes = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 35, notes: "قيد المراجعة" });
    expect(createRes.status).toBe(201);
    const requestId = unwrap(createRes.body).request_id;
    const pending = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    expect(pending.status).toBe("pending");
    expect(Number(pending.employee_id)).toBe(emp.id);
    expect(pending.employee_name).toBe("معلّق");

    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(beforeExp.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(beforeLed.n);
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n
    ).toBe(beforeMov.n);

    const rejectRes = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", review_notes: "لا" });
    expect(rejectRes.status).toBe(200);

    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(beforeExp.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(beforeLed.n);
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n
    ).toBe(beforeMov.n);
    expect(
      await ctx.db.get("SELECT * FROM employee_ledger_entries WHERE employee_id = ?", [emp.id])
    ).toBeUndefined();
  });

  test("approving employee A credits only A; duplicate approve does not post twice", async () => {
    const empA = await createTestEmployee(ctx.db, { name: "عامل أ" });
    const empB = await createTestEmployee(ctx.db, { name: "عامل ب" });

    const createA = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: empA.id, amount: 60, notes: "سلفة أ" });
    expect(createA.status).toBe(201);
    const idA = unwrap(createA.body).request_id;

    const approve = await request(ctx.app)
      .put(`/api/v1/advance-requests/${idA}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);
    const approved = unwrap(approve.body).request;
    expect(Number(approved.employee_id)).toBe(empA.id);
    expect(approved.status).toBe("approved");

    const ledgersA = await ctx.db.all(
      "SELECT * FROM employee_ledger_entries WHERE employee_id = ?",
      [empA.id]
    );
    const ledgersB = await ctx.db.all(
      "SELECT * FROM employee_ledger_entries WHERE employee_id = ?",
      [empB.id]
    );
    expect(ledgersA).toHaveLength(1);
    expect(ledgersB).toHaveLength(0);
    expect(ledgersA[0].purpose).toBe("salary_advance");
    expect(ledgersA[0].entry_type).toBe("salary_payment");
    expect(Number(ledgersA[0].amount)).toBe(60);
    expect(Number(ledgersA[0].advance_request_id)).toBe(idA);

    const exp = await ctx.db.get("SELECT * FROM operating_expenses WHERE id = ?", [
      ledgersA[0].operating_expense_id,
    ]);
    expect(exp).toBeTruthy();
    expect(Number(exp.amount)).toBe(60);
    expect(exp.source).toBe("employee_payment");
    expect(Number(exp.source_id)).toBe(ledgersA[0].id);
    expect(exp.category).toBe("salaries");

    const movements = await ctx.db.all(
      "SELECT * FROM shift_cash_movements WHERE advance_request_id = ?",
      [idA]
    );
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].amount)).toBe(-60);
    expect(movements[0].movement_type).toBe("advance");

    const stmtA = await request(ctx.app)
      .get(`/api/v1/employees/${empA.id}/statement`)
      .set(authHeader(adminToken));
    expect(stmtA.status).toBe(200);
    const movesA = unwrap(stmtA.body).movements;
    expect(movesA.some((m) => m.kind_label === "سلفة على الراتب" && m.amount === 60)).toBe(true);

    const stmtB = await request(ctx.app)
      .get(`/api/v1/employees/${empB.id}/statement`)
      .set(authHeader(adminToken));
    expect(unwrap(stmtB.body).movements).toHaveLength(0);

    const retry = await request(ctx.app)
      .put(`/api/v1/advance-requests/${idA}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(retry.status).toBe(400);
    expect(retry.body.code || unwrap(retry.body).code).toBe("NOT_PENDING");

    expect(
      (await ctx.db.all("SELECT * FROM employee_ledger_entries WHERE employee_id = ?", [empA.id])).length
    ).toBe(1);
    expect(
      (await ctx.db.all("SELECT * FROM operating_expenses WHERE source = 'employee_payment' AND source_id = ?", [
        ledgersA[0].id,
      ])).length
    ).toBe(1);
    expect(
      (await ctx.db.all("SELECT * FROM shift_cash_movements WHERE advance_request_id = ?", [idA])).length
    ).toBe(1);

    const del = await request(ctx.app)
      .delete(`/api/v1/expenses/${exp.id}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(409);
  });

  test("linked approve requires advance_approvals and employee_payroll", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "محاسبي" });
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 22 });
    const requestId = unwrap(created.body).request_id;

    const onlyAdvance = {
      ...defaultAccountantPermissions(),
      advance_approvals: true,
      employee_payroll: false,
    };
    const acct = await createAccountantUser(ctx.db, {
      username: "acct-advance-only",
      permissions: onlyAdvance,
    });
    const acctLogin = await login(ctx.app, acct.username, acct.password);
    const deny = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(acctLogin.body.token))
      .send({ status: "approved" });
    expect(deny.status).toBe(403);
    expect(deny.body.code || unwrap(deny.body).code).toBe("PAYROLL_APPROVAL_REQUIRED");
    expect(
      (await ctx.db.get("SELECT status FROM advance_requests WHERE id = ?", [requestId])).status
    ).toBe("pending");
    expect(
      await ctx.db.get("SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?", [requestId])
    ).toBeUndefined();

    const both = {
      ...defaultAccountantPermissions(),
      advance_approvals: true,
      employee_payroll: true,
    };
    const acct2 = await createAccountantUser(ctx.db, {
      username: "acct-both-keys",
      permissions: both,
    });
    const acct2Login = await login(ctx.app, acct2.username, acct2.password);
    const ok = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(acct2Login.body.token))
      .send({ status: "approved" });
    expect(ok.status).toBe(200);
    const row = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("approved");
    expect(Number(row.employee_id)).toBe(emp.id);
    expect(Number(row.manager_id)).toBe(acct2.id);
  });

  test("historical free-text request stays unlinked and till-only", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, status)
       VALUES (?, (SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1), ?, ?, 'pending')`,
      [cashierId, "سجل قديم بدون موظف", 18]
    );
    const histId = ins.lastID;
    const hist = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [histId]);
    expect(hist.employee_id).toBeNull();

    const approve = await request(ctx.app)
      .put(`/api/v1/advance-requests/${histId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);
    const after = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [histId]);
    expect(after.employee_id).toBeNull();
    expect(after.employee_name).toBe("سجل قديم بدون موظف");
    expect(after.ledger_entry_id).toBeNull();
    expect(after.operating_expense_id).toBeNull();

    const movement = await ctx.db.get(
      "SELECT * FROM shift_cash_movements WHERE advance_request_id = ?",
      [histId]
    );
    expect(movement).toBeTruthy();
    expect(Number(movement.amount)).toBe(-18);
    expect(
      await ctx.db.get("SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?", [histId])
    ).toBeUndefined();
  });

  test("Telegram approve keeps employee_id and posts once", async () => {
    const prevToken = process.env.TELEGRAM_SULAF_BOT_TOKEN;
    const prevSecret = process.env.TELEGRAM_SULAF_WEBHOOK_SECRET;
    const prevChat = process.env.TELEGRAM_SULAF_CHAT_ID;
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "test-sulaf-secret";
    process.env.TELEGRAM_SULAF_CHAT_ID = "6096292832";
    const originalFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 9 } }) });

    try {
      const emp = await createTestEmployee(ctx.db, { name: "تيليجرام" });
      const created = await request(ctx.app)
        .post("/api/v1/advance-requests")
        .set(authHeader(cashierToken))
        .send({ employee_id: emp.id, amount: 27 });
      const requestId = unwrap(created.body).request_id;

      const result = await handleTelegramUpdate(ctx.db, {
        callback_query: {
          id: "cq-pos-salary",
          data: `sulaf:approve:${requestId}`,
          message: { chat: { id: 6096292832 } },
          from: { id: 6096292832 },
        },
      });
      expect(result.action).toBe("approve");
      const row = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
      expect(row.status).toBe("approved");
      expect(Number(row.employee_id)).toBe(emp.id);
      expect(Number(row.manager_id)).toBe(adminId);

      const again = await handleTelegramUpdate(ctx.db, {
        callback_query: {
          id: "cq-pos-salary-2",
          data: `sulaf:approve:${requestId}`,
          message: { chat: { id: 6096292832 } },
          from: { id: 6096292832 },
        },
      });
      expect(again.action).toBe("already_handled");
      expect(
        (await ctx.db.all("SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?", [requestId]))
          .length
      ).toBe(1);
    } finally {
      global.fetch = originalFetch;
      if (prevToken == null) delete process.env.TELEGRAM_SULAF_BOT_TOKEN;
      else process.env.TELEGRAM_SULAF_BOT_TOKEN = prevToken;
      if (prevSecret == null) delete process.env.TELEGRAM_SULAF_WEBHOOK_SECRET;
      else process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = prevSecret;
      if (prevChat == null) delete process.env.TELEGRAM_SULAF_CHAT_ID;
      else process.env.TELEGRAM_SULAF_CHAT_ID = prevChat;
    }
  });
});
