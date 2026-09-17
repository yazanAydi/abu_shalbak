import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
} from "./helpers.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";

describe("employees phase 1", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierId = cashier.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("schema exists on isolated test db", async () => {
    const tables = await ctx.db.all(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name IN ('employees','employee_compensation','employee_opening_balances','employee_events','employee_event_clock','employee_ledger_entries','employee_salary_entitlements','employee_entitlement_shifts','employee_salary_periods','employee_period_shifts','employee_payroll_payouts','employee_settlements')`
    );
    expect(tables.map((t) => t.name).sort()).toEqual([
      "employee_compensation",
      "employee_entitlement_shifts",
      "employee_event_clock",
      "employee_events",
      "employee_ledger_entries",
      "employee_opening_balances",
      "employee_payroll_payouts",
      "employee_period_shifts",
      "employee_salary_entitlements",
      "employee_salary_periods",
      "employee_settlements",
      "employees",
    ]);
  });

  test("create employee without a login account", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "أحمد المخبز", phone: "0599000001", start_on: "2026-01-15" });
    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    expect(body.name).toBe("أحمد المخبز");
    expect(body.user_id).toBeNull();
    expect(body.active).toBe(true);
    expect(body.compensation).toEqual([]);
    expect(body.opening_balances).toEqual([]);
  });

  test("does not auto-create a user when adding an employee", async () => {
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM users");
    await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "بدون حساب" });
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM users");
    expect(after.n).toBe(before.n);
  });

  test("explicit user link is unique and limited to shop-floor roles", async () => {
    const first = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "كاشير مربوط", user_id: cashierId });
    expect(first.status).toBe(201);
    expect((first.body.data ?? first.body).user_id).toBe(cashierId);

    const adminUser = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const adminLink = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "لا يُربط بأدمن", user_id: adminUser.id });
    expect(adminLink.status).toBe(400);
    expect(adminLink.body.code).toBe("USER_NOT_LINKABLE");

    const dup = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "كاشير ثاني", user_id: cashierId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("USER_ALREADY_LINKED");
  });

  test("effective-dated compensation: raise is a new row and same-day duplicate is rejected", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "راتب شهري" });
    const id = (created.body.data ?? created.body).id;

    const first = await request(ctx.app)
      .post(`/api/v1/employees/${id}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: "2026-01-01", compensation_type: "monthly", amount: 3000 });
    expect(first.status).toBe(201);
    expect((first.body.data ?? first.body).amount).toBe(3000);

    const raise = await request(ctx.app)
      .post(`/api/v1/employees/${id}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: "2026-06-01", compensation_type: "monthly", amount: 3200 });
    expect(raise.status).toBe(201);

    const sameDay = await request(ctx.app)
      .post(`/api/v1/employees/${id}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: "2026-06-01", compensation_type: "monthly", amount: 3300 });
    expect(sameDay.status).toBe(409);
    expect(sameDay.body.code).toBe("RATE_EFFECTIVE_FROM_EXISTS");

    const detail = await request(ctx.app)
      .get(`/api/v1/employees/${id}`)
      .set(authHeader(adminToken));
    const rates = (detail.body.data ?? detail.body).compensation;
    expect(rates).toHaveLength(2);
    expect(rates.map((r) => r.amount)).toEqual([3200, 3000]);
    expect(rates[0].effective_from).toBe("2026-06-01");
  });

  test("opening balances are audited and receive monotonic event_seq on the same day", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "أرصدة افتتاحية" });
    const id = (created.body.data ?? created.body).id;

    const unpaid = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "unpaid_salary",
        amount: 800,
        as_of: "2026-08-01",
        reason: "راتب آب غير مدفوع عند بدء النظام",
      });
    expect(unpaid.status).toBe(201);
    expect((unpaid.body.data ?? unpaid.body).event_seq).toBe(1);

    const prepaid = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 200,
        as_of: "2026-08-01",
        reason: "سلفة على الراتب قبل القطع",
      });
    expect(prepaid.status).toBe(201);
    expect((prepaid.body.data ?? prepaid.body).event_seq).toBe(2);

    const events = await ctx.db.all(
      "SELECT event_seq, kind, event_date FROM employee_events WHERE employee_id = ? ORDER BY event_seq",
      [id]
    );
    expect(events).toEqual([
      { event_seq: 1, kind: "opening_unpaid", event_date: "2026-08-01" },
      { event_seq: 2, kind: "opening_prepaid", event_date: "2026-08-01" },
    ]);

    const audit = await ctx.db.get(
      "SELECT action FROM audit_logs WHERE action = ? AND entity_id = ? ORDER BY id DESC",
      ["EMPLOYEE_OPENING_BALANCE_CREATE", (unpaid.body.data ?? unpaid.body).id]
    );
    expect(audit).toBeTruthy();
  });

  test("unpaid opening cannot attach an expense", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "غير مدفوع" });
    const id = (created.body.data ?? created.body).id;
    const exp = await ctx.db.run(
      `INSERT INTO operating_expenses (category, amount, paid_on, payment_method)
       VALUES ('salaries', 100, '2026-07-01', 'cash')`
    );
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "unpaid_salary",
        amount: 100,
        as_of: "2026-07-01",
        reason: "خطأ",
        operating_expense_id: exp.lastID,
      });
    expect(res.status).toBe(400);
  });

  test("cutover: attaching an expense and a matching orphan prepaid is rejected both ways", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "قطع محاسبي" });
    const id = (created.body.data ?? created.body).id;
    const exp = await ctx.db.run(
      `INSERT INTO operating_expenses (category, amount, paid_on, payment_method, reference_note)
       VALUES ('salaries', 500, '2026-05-10', 'transfer', 'راتب مبكر تاريخي')`
    );

    const attach = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 500,
        as_of: "2026-05-10",
        reason: "ربط سند مصروف قائم",
        operating_expense_id: exp.lastID,
      });
    expect(attach.status).toBe(201);

    const opexCount = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE id = ?", [exp.lastID]);
    expect(opexCount.n).toBe(1);

    const dupAttach = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 500,
        as_of: "2026-05-10",
        reason: "محاولة ربط نفس السند",
        operating_expense_id: exp.lastID,
      });
    expect(dupAttach.status).toBe(409);
    expect(dupAttach.body.code).toBe("CUTOVER_DUPLICATE");

    const orphan = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 500,
        as_of: "2026-05-10",
        reason: "نفس الدفعة بدون سند",
      });
    expect(orphan.status).toBe(409);
    expect(orphan.body.code).toBe("CUTOVER_DUPLICATE");
  });

  test("cutover: orphan prepaid then attaching the matching expense is rejected", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "قطع بالعكس" });
    const id = (created.body.data ?? created.body).id;
    const exp = await ctx.db.run(
      `INSERT INTO operating_expenses (category, amount, paid_on, payment_method)
       VALUES ('salaries', 250, '2026-04-01', 'cash')`
    );

    const orphan = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 250,
        as_of: "2026-04-01",
        reason: "دفعة خارج النظام",
      });
    expect(orphan.status).toBe(201);

    const attach = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 250,
        as_of: "2026-04-01",
        reason: "ثم ربط السند",
        operating_expense_id: exp.lastID,
      });
    expect(attach.status).toBe(409);
    expect(attach.body.code).toBe("CUTOVER_DUPLICATE");
  });

  test("cutover attach requires matching amount and paid_on", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "عدم تطابق السند" });
    const id = (created.body.data ?? created.body).id;
    const exp = await ctx.db.run(
      `INSERT INTO operating_expenses (category, amount, paid_on, payment_method)
       VALUES ('salaries', 400, '2026-03-01', 'cash')`
    );

    const wrongAmt = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 399,
        as_of: "2026-03-01",
        reason: "مبلغ مختلف",
        operating_expense_id: exp.lastID,
      });
    expect(wrongAmt.status).toBe(400);
    expect(wrongAmt.body.code).toBe("CUTOVER_AMOUNT_MISMATCH");

    const wrongDay = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 400,
        as_of: "2026-03-02",
        reason: "تاريخ مختلف",
        operating_expense_id: exp.lastID,
      });
    expect(wrongDay.status).toBe(400);
    expect(wrongDay.body.code).toBe("CUTOVER_DATE_MISMATCH");
  });

  test("inactive employee is kept and not hard-deleted", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "سابق", start_on: "2024-01-01" });
    const id = (created.body.data ?? created.body).id;
    const patched = await request(ctx.app)
      .patch(`/api/v1/employees/${id}`)
      .set(authHeader(adminToken))
      .send({ active: false, end_on: "2026-02-01" });
    expect(patched.status).toBe(200);
    expect((patched.body.data ?? patched.body).active).toBe(false);

    const listed = await request(ctx.app)
      .get("/api/v1/employees")
      .set(authHeader(adminToken));
    const rows = listed.body.data ?? listed.body;
    expect(rows.some((r) => r.id === id && r.active === false)).toBe(true);
  });

  test("cashier cannot access employee APIs", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/employees")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(403);
  });

  test("accountant without employee_payroll is 403; with it can list", async () => {
    const denied = await createAccountantUser(ctx.db, {
      username: "acct-no-payroll",
      permissions: { ...defaultAccountantPermissions(), employee_payroll: false },
    });
    const deniedLogin = await login(ctx.app, denied.username, denied.password);
    const deniedRes = await request(ctx.app)
      .get("/api/v1/employees")
      .set(authHeader(deniedLogin.body.token));
    expect(deniedRes.status).toBe(403);

    const allowed = await createAccountantUser(ctx.db, {
      username: "acct-payroll",
      permissions: { ...defaultAccountantPermissions(), employee_payroll: true },
    });
    const allowedLogin = await login(ctx.app, allowed.username, allowed.password);
    const ok = await request(ctx.app)
      .get("/api/v1/employees")
      .set(authHeader(allowedLogin.body.token));
    expect(ok.status).toBe(200);
  });

  test("opening does not insert an operating_expenses row", async () => {
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "بدون مصروف جديد" });
    const id = (created.body.data ?? created.body).id;
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "unpaid_salary",
        amount: 50,
        as_of: "2026-01-01",
        reason: "افتتاح",
      });
    expect(res.status).toBe(201);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    expect(after.n).toBe(before.n);
  });
});
