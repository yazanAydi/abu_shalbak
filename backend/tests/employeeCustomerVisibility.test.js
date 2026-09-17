import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { sqlOrdinaryCustomer } from "../utils/employeeCustomer.js";
import { applyCustomerBalanceImport } from "../utils/customerImport.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("employee debt accounts stay out of ordinary customer UI", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierUserId;
  let emp;
  let empCustomerId;
  let ordinarySameNameId;
  let walkInId;
  let inactiveEmp;
  let inactiveCustomerId;
  let saleTxId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierUserId = cashierLogin.body.user.id;

    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "yyy", start_on: "2026-01-01" });
    expect(created.status).toBe(201);
    emp = unwrap(created);

    const account = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(adminToken))
      .send({});
    expect([200, 201]).toContain(account.status);
    emp = unwrap(account);
    empCustomerId = Number(emp.customer_id);
    expect(empCustomerId).toBeGreaterThan(0);

    await ctx.db.run("UPDATE customers SET balance = 30 WHERE id = ?", [empCustomerId]);

    const tx = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number)
       VALUES (?, ?, 30, 0, 30, 'on_account', ?, ?, 'completed', datetime('now'), 'R-YYY-30')`,
      [
        cashierUserId,
        JSON.stringify([{ name: "ذمة yyy", quantity: 1, price: 30 }]),
        empCustomerId,
        emp.id,
      ]
    );
    saleTxId = tx.lastID;
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', 30)`,
      [saleTxId]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items (transaction_id, name, quantity, unit_price, line_net, line_gross)
       VALUES (?, 'ذمة yyy', 1, 30, 30, 30)`,
      [saleTxId]
    );

    const ordinary = await request(ctx.app)
      .post("/api/v1/customers")
      .set(authHeader(adminToken))
      .send({ name: "yyy", customer_code: "WALK-YYY", opening_balance: 12 });
    expect(ordinary.status).toBe(201);
    ordinarySameNameId = unwrap(ordinary).id;

    const walkIn = await request(ctx.app)
      .post("/api/v1/customers")
      .set(authHeader(adminToken))
      .send({ name: "زبون عادي", customer_code: "WALK-1", opening_balance: 5 });
    expect(walkIn.status).toBe(201);
    walkInId = unwrap(walkIn).id;

    const inactiveCreated = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "موظف موقوف", start_on: "2026-01-01", active: 0 });
    expect(inactiveCreated.status).toBe(201);
    inactiveEmp = unwrap(inactiveCreated);
    const inactiveAccount = await request(ctx.app)
      .post(`/api/v1/employees/${inactiveEmp.id}/debt-account`)
      .set(authHeader(adminToken))
      .send({});
    expect([200, 201]).toContain(inactiveAccount.status);
    inactiveEmp = unwrap(inactiveAccount);
    inactiveCustomerId = Number(inactiveEmp.customer_id);
    await request(ctx.app)
      .patch(`/api/v1/employees/${inactiveEmp.id}`)
      .set(authHeader(adminToken))
      .send({ active: 0 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("sqlOrdinaryCustomer is relationship-based", () => {
    expect(sqlOrdinaryCustomer("c")).toMatch(/employees e WHERE e.customer_id = c\.id/);
    expect(sqlOrdinaryCustomer("c")).not.toMatch(/name/i);
  });

  test("yyy disappears from ordinary customer lists and search, same-name walk-in remains", async () => {
    const list = await request(ctx.app).get("/api/v1/customers").set(authHeader(adminToken));
    expect(list.status).toBe(200);
    const rows = unwrap(list);
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(ordinarySameNameId);
    expect(ids).toContain(walkInId);
    expect(ids).not.toContain(empCustomerId);
    expect(ids).not.toContain(inactiveCustomerId);

    const search = await request(ctx.app)
      .get("/api/v1/customers")
      .query({ q: "yyy" })
      .set(authHeader(adminToken));
    expect(search.status).toBe(200);
    const found = unwrap(search);
    expect(found.map((r) => Number(r.id))).toEqual([ordinarySameNameId]);
    expect(found.every((r) => Number(r.id) !== empCustomerId)).toBe(true);
  });

  test("customer-only balances exclude employee accounts before totals", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/customers/balances")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = unwrap(res);
    const ids = (body.customers || []).map((r) => Number(r.id));
    expect(ids).toContain(ordinarySameNameId);
    expect(ids).toContain(walkInId);
    expect(ids).not.toContain(empCustomerId);
    expect(ids).not.toContain(inactiveCustomerId);
    expect(Number(body.total_due)).toBeCloseTo(17, 2);
  });

  test("store-wide receivables still include the ₪30 employee debt once", async () => {
    const today = shopTodayYmd();
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const fin = unwrap(res);
    expect(Number(fin.currentPosition.customerReceivables)).toBeCloseTo(47, 2);

    const bal = unwrap(
      await request(ctx.app).get("/api/v1/customers/balances").set(authHeader(adminToken))
    );
    expect(Number(fin.currentPosition.customerReceivables)).toBeGreaterThan(Number(bal.total_due));
    expect(Number(fin.currentPosition.customerReceivables) - Number(bal.total_due)).toBeCloseTo(30, 2);
  });

  test("employee screens and POS موظف keep the same account, balance, and invoice", async () => {
    const live = await ctx.db.get("SELECT id, balance FROM customers WHERE id = ?", [empCustomerId]);
    expect(Number(live.balance)).toBeCloseTo(30, 2);

    const linked = await ctx.db.all("SELECT id FROM employees WHERE customer_id = ?", [empCustomerId]);
    expect(linked).toHaveLength(1);
    expect(Number(linked[0].id)).toBe(emp.id);

    const detail = unwrap(
      await request(ctx.app).get(`/api/v1/employees/${emp.id}`).set(authHeader(adminToken))
    );
    expect(Number(detail.customer_id)).toBe(empCustomerId);
    expect(Number(detail.customer_balance)).toBeCloseTo(30, 2);

    const history = unwrap(
      await request(ctx.app)
        .get(`/api/v1/employees/${emp.id}/history`)
        .query({ from: "2020-01-01", to: "2030-12-31" })
        .set(authHeader(adminToken))
    );
    const invoices = history.debts?.items || [];
    expect(invoices.some((row) => Number(row.source_id) === Number(saleTxId))).toBe(true);
    expect(Number(history.debts.customer_balance)).toBeCloseTo(30, 2);

    const pos = unwrap(
      await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken))
    );
    expect(pos.some((row) => Number(row.id) === Number(emp.id))).toBe(true);
    expect(pos.some((row) => Number(row.id) === Number(inactiveEmp.id))).toBe(false);

    const debtCustomers = unwrap(
      await request(ctx.app).get("/api/v1/employees/debt-customers").set(authHeader(adminToken))
    );
    expect(debtCustomers.some((row) => Number(row.id) === empCustomerId)).toBe(true);
  });

  test("authorized customer statement by id still returns the employee invoice", async () => {
    const stmt = await request(ctx.app)
      .get(`/api/v1/customers/${empCustomerId}/statement`)
      .query({ from: "2020-01-01", to: "2030-12-31" })
      .set(authHeader(adminToken));
    expect(stmt.status).toBe(200);
    const body = unwrap(stmt);
    const rows = body.rows || [];
    expect(rows.some((r) => Number(r.sourceId) === Number(saleTxId))).toBe(true);

    const byId = await request(ctx.app)
      .get(`/api/v1/customers/${empCustomerId}`)
      .set(authHeader(adminToken));
    expect(byId.status).toBe(200);
    expect(Number(unwrap(byId).balance)).toBeCloseTo(30, 2);
  });

  test("customer edit/delete/payment cannot mutate the employee account by id", async () => {
    const put = await request(ctx.app)
      .put(`/api/v1/customers/${empCustomerId}`)
      .set(authHeader(adminToken))
      .send({ name: "should-not-rename" });
    expect(put.status).toBe(409);
    expect(unwrap(put).code || put.body.code).toBe("EMPLOYEE_ACCOUNT_PROTECTED");

    const pay = await request(ctx.app)
      .post(`/api/v1/customers/${empCustomerId}/payment`)
      .set(authHeader(adminToken))
      .send({ amount: 5 });
    expect(pay.status).toBe(409);

    const del = await request(ctx.app)
      .delete(`/api/v1/customers/${empCustomerId}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(409);

    const still = await ctx.db.get("SELECT name, balance FROM customers WHERE id = ?", [empCustomerId]);
    expect(still.name).toBe("yyy");
    expect(Number(still.balance)).toBeCloseTo(30, 2);

    const ordinaryPut = await request(ctx.app)
      .put(`/api/v1/customers/${walkInId}`)
      .set(authHeader(adminToken))
      .send({ notes: "ok" });
    expect(ordinaryPut.status).toBe(200);
  });

  test("customer balance import does not overwrite the employee ₪30", async () => {
    const empCust = await ctx.db.get("SELECT customer_code FROM customers WHERE id = ?", [empCustomerId]);
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 1,
        name: "yyy",
        code: empCust.customer_code,
        phone: null,
        balance: 999,
        importType: "hesabati_customer_balances",
      },
    ]);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBeGreaterThan(0);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [empCustomerId]);
    expect(Number(live.balance)).toBeCloseTo(30, 2);
    const empStill = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id]);
    expect(Number(empStill.customer_id)).toBe(empCustomerId);
  });

  test("customer import matching an employee by name only creates a new ordinary customer", async () => {
    const createdEmp = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "موظف استيراد بالاسم", start_on: "2026-01-01" });
    const empRow = unwrap(createdEmp);
    const account = unwrap(
      await request(ctx.app)
        .post(`/api/v1/employees/${empRow.id}/debt-account`)
        .set(authHeader(adminToken))
        .send({})
    );
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM customers");
    const empBalance = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [account.customer_id]);
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 1,
        name: "موظف استيراد بالاسم",
        code: null,
        phone: null,
        balance: 12,
        importType: "hesabati_customer_balances",
      },
    ]);
    expect(summary.created).toBe(1);
    expect(summary.updated).toBe(0);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM customers");
    expect(Number(after.n)).toBe(Number(before.n) + 1);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [account.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(Number(empBalance.balance), 2);
    const created = await ctx.db.get(
      `SELECT id FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id != ? ORDER BY id DESC LIMIT 1`,
      ["موظف استيراد بالاسم", account.customer_id]
    );
    const linked = await ctx.db.get("SELECT id FROM employees WHERE customer_id = ?", [created.id]);
    expect(linked).toBeFalsy();
  });

  test("customer import does not merge ordinary customers by name", async () => {
    const existing = await ctx.db.get("SELECT id, balance FROM customers WHERE id = ?", [walkInId]);
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM customers");
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 1,
        name: "زبون عادي",
        code: null,
        phone: null,
        balance: 88,
        importType: "hesabati_customer_balances",
      },
    ]);
    expect(summary.created).toBe(1);
    expect(summary.updated).toBe(0);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM customers");
    expect(Number(after.n)).toBe(Number(before.n) + 1);
    const still = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [existing.id]);
    expect(Number(still.balance)).toBeCloseTo(Number(existing.balance), 2);
  });
});
