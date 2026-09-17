import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createTestEmployee,
  createAccountantUser,
} from "./helpers.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";
import { buildFinanceOverview } from "../utils/financeOverview.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("employee expenses, corrections, cashier linking", () => {
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

  async function salaryCategory(name = "salaries") {
    return ctx.db.get("SELECT * FROM expense_categories WHERE name = ?", [name]);
  }

  async function createRegular(name) {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  test("GET cashier-accounts lists existing cashiers without creating employees or finance rows", async () => {
    const beforeEmp = await ctx.db.get("SELECT COUNT(*) AS n FROM employees");
    const beforeOpex = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const beforeLed = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries");
    const beforeEnt = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_entitlements");

    const res = await request(ctx.app)
      .get("/api/v1/employees/cashier-accounts")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    expect(Array.isArray(rows)).toBe(true);
    const found = rows.find((r) => r.user_id === cashierId);
    expect(found).toBeTruthy();
    expect(found.username).toBe("testcashier");
    expect(found.linked).toBe(false);
    expect(found.linked_employee_id).toBeNull();
    expect(rows.some((r) => r.username === "testadmin")).toBe(false);

    const listed = await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken));
    expect(unwrap(listed.body).some((e) => e.user_id === cashierId)).toBe(false);

    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(beforeEmp.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(beforeOpex.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(beforeLed.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_entitlements")).n).toBe(
      beforeEnt.n
    );
  });

  test("create-from-cashier-user is idempotent, appears in list and POS, and posts no finance", async () => {
    const beforeOpex = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const beforeLed = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries");
    const beforeEnt = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_entitlements");

    const created = await request(ctx.app)
      .post("/api/v1/employees/from-cashier-user")
      .set(authHeader(adminToken))
      .send({ user_id: cashierId, name: "كاشير موجود" });
    expect(created.status).toBe(201);
    const emp = unwrap(created.body);
    expect(emp.user_id).toBe(cashierId);
    expect(emp.kind).toBe("cashier");
    expect(emp.name).toBe("كاشير موجود");

    const again = await request(ctx.app)
      .post("/api/v1/employees/from-cashier-user")
      .set(authHeader(adminToken))
      .send({ user_id: cashierId, name: "اسم آخر" });
    expect(again.status).toBe(200);
    expect(unwrap(again.body).id).toBe(emp.id);
    expect(unwrap(again.body).name).toBe("كاشير موجود");

    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
    );
    expect(listed.filter((e) => e.user_id === cashierId)).toHaveLength(1);
    expect(listed.find((e) => e.user_id === cashierId).kind).toBe("cashier");

    const pos = unwrap(
      (await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken))).body
    );
    expect(pos.some((r) => r.id === emp.id && r.name === "كاشير موجود")).toBe(true);

    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(beforeOpex.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(beforeLed.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_entitlements")).n).toBe(
      beforeEnt.n
    );

    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, '2026-08-03T07:00:00.000Z', '2026-08-03T15:00:00.000Z', 100, 'closed', 18)`,
      [cashierId]
    );
    const preview = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/hours-preview`)
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .set(authHeader(adminToken));
    expect(preview.status).toBe(200);
    const hours = unwrap(preview.body);
    expect(hours.applicable).toBe(true);
    expect(hours.posted_hours).toBeGreaterThan(0);
    expect(hours.uses_live_hourly_rate).toBe(false);

    const inactive = await request(ctx.app)
      .patch(`/api/v1/employees/${emp.id}`)
      .set(authHeader(adminToken))
      .send({ active: false });
    expect(inactive.status).toBe(200);
    const stmt = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/statement`)
      .set(authHeader(adminToken));
    expect(stmt.status).toBe(200);
  });

  test("link existing employee to a second cashier without a duplicate record", async () => {
    const hash = await bcrypt.hash("cash2pass", 4);
    const ins = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["secondcashier", hash]
    );
    const secondId = ins.lastID;
    const regular = await createRegular("سجل قائم للربط");
    const beforeCount = await ctx.db.get("SELECT COUNT(*) AS n FROM employees");

    const linked = await request(ctx.app)
      .post(`/api/v1/employees/${regular.id}/link-user`)
      .set(authHeader(adminToken))
      .send({ user_id: secondId });
    expect(linked.status).toBe(200);
    expect(unwrap(linked.body).user_id).toBe(secondId);
    expect(unwrap(linked.body).kind).toBe("cashier");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(beforeCount.n);

    const dup = await request(ctx.app)
      .post("/api/v1/employees/from-cashier-user")
      .set(authHeader(adminToken))
      .send({ user_id: secondId });
    expect(dup.status).toBe(200);
    expect(unwrap(dup.body).id).toBe(regular.id);

    const other = await createRegular("لا يُربط مرتين");
    const taken = await request(ctx.app)
      .post(`/api/v1/employees/${other.id}/link-user`)
      .set(authHeader(adminToken))
      .send({ user_id: secondId });
    expect(taken.status).toBe(409);
  });

  test("salary expense routes require an employee and use the canonical writer once", async () => {
    const emp = await createRegular("موظف مصروف راتب");
    const cat = await salaryCategory("salaries");
    const advCat = await salaryCategory("salary_advance");
    expect(cat).toBeTruthy();
    expect(advCat).toBeTruthy();

    const missing = await request(ctx.app)
      .post("/api/v1/expenses")
      .set(authHeader(adminToken))
      .send({
        category_id: cat.id,
        amount: 400,
        paid_on: "2026-08-10",
        payment_method: "transfer",
      });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("EMPLOYEE_REQUIRED");

    const financeMissing = await request(ctx.app)
      .post("/api/v1/finance/operating-expenses")
      .set(authHeader(adminToken))
      .send({
        category: "salaries",
        amount: 400,
        paid_on: "2026-08-10",
        payment_method: "transfer",
      });
    expect(financeMissing.status).toBe(400);
    expect(financeMissing.body.code).toBe("EMPLOYEE_REQUIRED");

    const posted = await request(ctx.app)
      .post("/api/v1/expenses")
      .set(authHeader(adminToken))
      .send({
        category_id: cat.id,
        employee_id: emp.id,
        purpose: "salary_payment",
        amount: 400,
        paid_on: "2026-08-10",
        payment_method: "transfer",
        reference_note: "من المصروفات",
      });
    expect(posted.status).toBe(201);
    const expRow = unwrap(posted.body);
    expect(expRow.employee_id).toBe(emp.id);
    expect(expRow.source).toBe("employee_payment");
    expect(Number(expRow.amount)).toBe(400);

    const ledgers = await ctx.db.all(
      "SELECT * FROM employee_ledger_entries WHERE employee_id = ? AND purpose = 'salary_payment'",
      [emp.id]
    );
    expect(ledgers).toHaveLength(1);
    expect(Number(ledgers[0].operating_expense_id)).toBe(expRow.id);

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stmt.period_salary_payments).toBe(400);

    const del = await request(ctx.app)
      .delete(`/api/v1/expenses/${expRow.id}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(409);

    const financeDel = await request(ctx.app)
      .delete(`/api/v1/finance/operating-expenses/${expRow.id}`)
      .set(authHeader(adminToken));
    expect(financeDel.status).toBe(409);

    const advance = await request(ctx.app)
      .post("/api/v1/expenses")
      .set(authHeader(adminToken))
      .send({
        category_id: advCat.id,
        employee_id: emp.id,
        amount: 50,
        paid_on: "2026-08-11",
        payment_method: "cash",
      });
    expect(advance.status).toBe(201);
    const advLedger = await ctx.db.get(
      "SELECT * FROM employee_ledger_entries WHERE operating_expense_id = ?",
      [unwrap(advance.body).id]
    );
    expect(advLedger.purpose).toBe("salary_advance");
  });

  test("historical generic salary expenses remain listable and deletable", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO operating_expenses (category, amount, paid_on, payment_method, reference_note)
       VALUES ('salaries', 90, '2026-01-15', 'cash', 'راتب تاريخي عام')`
    );
    const list = await request(ctx.app)
      .get("/api/v1/expenses")
      .query({ from: "2026-01-01", to: "2026-01-31" })
      .set(authHeader(adminToken));
    expect(list.status).toBe(200);
    const row = unwrap(list.body).find((r) => r.id === ins.lastID);
    expect(row).toBeTruthy();
    expect(row.employee_id).toBeNull();
    expect(row.source).toBeNull();

    const del = await request(ctx.app)
      .delete(`/api/v1/expenses/${ins.lastID}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(200);
  });

  test("office payment replace and reverse are dated; POS and employee-move are blocked", async () => {
    const emp = await createRegular("تصحيح مكتبي");
    const other = await createRegular("المستلم المقصود");
    const pay = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_payment",
        amount: 1000,
        occurred_on: "2026-08-05",
        payment_method: "transfer",
        reference_note: "مبلغ خاطئ",
      });
    expect(pay.status).toBe(201);
    const paymentId = unwrap(pay.body).id;

    const move = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments/${paymentId}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "replace",
        amount: 800,
        reason: "تصحيح المبلغ",
        correction_date: "2026-08-20",
        employee_id: other.id,
      });
    expect(move.status).toBe(409);
    expect(move.body.code).toBe("EMPLOYEE_RECLASS_BLOCKED");

    const replaced = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments/${paymentId}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "replace",
        amount: 800,
        reason: "المبلغ الصحيح 800",
        correction_date: "2026-08-20",
      });
    expect(replaced.status).toBe(200);
    const body = unwrap(replaced.body);
    expect(body.reversal).toBeTruthy();
    expect(body.replacement.amount).toBe(800);
    expect(body.original.status).toBe("reversed");

    const again = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments/${paymentId}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "replace",
        amount: 800,
        reason: "إعادة",
        correction_date: "2026-08-20",
      });
    expect(again.status).toBe(200);
    expect(unwrap(again.body).replacement.id).toBe(body.replacement.id);

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stmt.period_salary_payments).toBe(800);
    const originalStillThere = stmt.movements.some(
      (m) => m.source_id === paymentId && m.credit === 1000
    );
    expect(originalStillThere).toBe(true);
    expect(stmt.movements.some((m) => m.kind === "salary_payment_reversal" && m.debit === 1000)).toBe(
      true
    );

    const opex = await ctx.db.all(
      `SELECT amount, paid_on, source FROM operating_expenses
       WHERE id IN (?, ?, ?)`,
      [body.original.operating_expense_id, body.reversal.operating_expense_id, body.replacement.operating_expense_id]
    );
    expect(opex.some((r) => Number(r.amount) === 1000 && r.paid_on === "2026-08-05")).toBe(true);
    expect(opex.some((r) => Number(r.amount) === -1000 && r.paid_on === "2026-08-20")).toBe(true);
    expect(opex.some((r) => Number(r.amount) === 800 && r.paid_on === "2026-08-20")).toBe(true);

    const finance = await buildFinanceOverview(ctx.db, "2026-08-01", "2026-08-31");
    expect(Number(finance.operating_expenses_total)).toBeGreaterThanOrEqual(800);

    const annotate = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments/${body.replacement.id}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "annotate_recipient",
        intended_employee_id: other.id,
        reason: "الاسم في الدفاتر كان خطأ",
        correction_date: "2026-08-21",
      });
    expect(annotate.status).toBe(200);
    expect(unwrap(annotate.body).original.intended_employee_id).toBe(other.id);
    expect(unwrap(annotate.body).original.employee_id).toBe(emp.id);

    const otherStmt = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${other.id}/statement`).set(authHeader(adminToken)))
        .body
    );
    expect(otherStmt.period_salary_payments || 0).toBe(0);
    expect(otherStmt.movements.some((m) => m.kind === "payment_annotation")).toBe(true);

    const posEmp = await createTestEmployee(ctx.db, { name: "سلفة صندوق" });
    const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect([201, 409]).toContain(started.status);
    const openShift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
      [cashierId]
    );
    expect(openShift).toBeTruthy();
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 500 WHERE id = ?", [openShift.id]);
    const createdAdv = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: posEmp.id, amount: 40 });
    expect(createdAdv.status).toBe(201);
    const requestId = unwrap(createdAdv.body).request_id;
    const approved = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const posLedger = await ctx.db.get(
      "SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?",
      [requestId]
    );
    const posFix = await request(ctx.app)
      .post(`/api/v1/employees/${posEmp.id}/payments/${posLedger.id}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "reverse",
        reason: "محاولة عكس سلفة الصندوق",
        correction_date: "2026-08-22",
      });
    expect(posFix.status).toBe(409);
    expect(posFix.body.code).toBe("POS_CORRECTION_BLOCKED");
    expect(
      (await ctx.db.get("SELECT * FROM employee_ledger_entries WHERE id = ?", [posLedger.id])).status
    ).toBe("active");
    expect(
      (await ctx.db.all("SELECT * FROM shift_cash_movements WHERE advance_request_id = ?", [requestId]))
        .length
    ).toBe(1);
  });

  test("expenses permission alone cannot post a salary payment", async () => {
    const emp = await createRegular("صلاحية مصروف فقط");
    const cat = await salaryCategory("salaries");
    const acct = await createAccountantUser(ctx.db, {
      username: "exp-only-payroll",
      password: "acctpass123",
      permissions: { ...defaultAccountantPermissions(), expenses: true, employee_payroll: false, finance: true },
    });
    const loginRes = await login(ctx.app, acct.username, "acctpass123");
    const token = loginRes.body.token;
    const res = await request(ctx.app)
      .post("/api/v1/expenses")
      .set(authHeader(token))
      .send({
        category_id: cat.id,
        employee_id: emp.id,
        purpose: "salary_payment",
        amount: 10,
        paid_on: "2026-08-12",
        payment_method: "cash",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PAYROLL_REQUIRED");
  });

  test("duplicate office payment can be reversed without deleting the original expense", async () => {
    const emp = await createRegular("سجل مكرر");
    const first = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${emp.id}/payments`)
          .set(authHeader(adminToken))
          .send({
            purpose: "salary_advance",
            amount: 120,
            occurred_on: "2026-08-08",
            payment_method: "cash",
          })
      ).body
    );
    const dup = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${emp.id}/payments`)
          .set(authHeader(adminToken))
          .send({
            purpose: "salary_advance",
            amount: 120,
            occurred_on: "2026-08-08",
            payment_method: "cash",
          })
      ).body
    );
    const reversed = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments/${dup.id}/correct`)
      .set(authHeader(adminToken))
      .send({
        mode: "reverse",
        reason: "تسجيل مكرر",
        correction_date: "2026-08-09",
      });
    expect(reversed.status).toBe(200);
    expect(await ctx.db.get("SELECT id FROM operating_expenses WHERE id = ?", [first.operating_expense_id])).toBeTruthy();
    expect(await ctx.db.get("SELECT id FROM operating_expenses WHERE id = ?", [dup.operating_expense_id])).toBeTruthy();
    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stmt.period_advances).toBe(120);
  });
});
