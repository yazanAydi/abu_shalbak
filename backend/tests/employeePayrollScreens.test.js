import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { buildFinanceOverview } from "../utils/financeOverview.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("employee statement and salary screens", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierUserId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierUserId = cashier.id;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    );
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 800 WHERE id = ?", [shift.id]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createRegular(name) {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, start_on: "2026-01-01" });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function createLinkedCashier(name) {
    const existing = await ctx.db.get("SELECT id FROM employees WHERE user_id = ?", [cashierUserId]);
    if (existing) {
      await ctx.db.run("UPDATE employees SET user_id = NULL WHERE id = ?", [existing.id]);
    }
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, user_id: cashierUserId, start_on: "2026-01-01" });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function postPayment(employeeId, body) {
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${employeeId}/payments`)
      .set(authHeader(adminToken))
      .send(body);
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function insertCustomer(name, code, balance) {
    const ins = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES (?, ?, ?, 0, 5000)`,
      [name, code, balance]
    );
    return ins.lastID;
  }

  async function insertOnAccountSale({ customerId, employeeId, total, createdAt, name, receipt }) {
    const tx = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number)
       VALUES (?, ?, ?, 0, ?, 'on_account', ?, ?, 'completed', ?, ?)`,
      [
        cashierUserId,
        JSON.stringify([{ name, quantity: 1, price: total }]),
        total,
        total,
        customerId,
        employeeId,
        createdAt,
        receipt,
      ]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', ?)`,
      [tx.lastID, total]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items (transaction_id, name, quantity, unit_price, line_net, line_gross)
       VALUES (?, ?, 1, ?, ?, ?)`,
      [tx.lastID, name, total, total, total]
    );
    await ctx.db.run("UPDATE customers SET balance = COALESCE(balance, 0) + ? WHERE id = ?", [
      total,
      customerId,
    ]);
    return tx.lastID;
  }

  test("schema includes payroll screen tables and keeps opening-balance table", async () => {
    const names = (
      await ctx.db.all(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('employee_salary_periods','employee_payroll_payouts','employee_settlements','employee_opening_balances')`
      )
    ).map((row) => row.name);
    expect(names.sort()).toEqual([
      "employee_opening_balances",
      "employee_payroll_payouts",
      "employee_salary_periods",
      "employee_settlements",
    ]);
    const col = await ctx.db.get("PRAGMA table_info(employees)");
    const cols = await ctx.db.all("PRAGMA table_info(employees)");
    expect(cols.some((c) => c.name === "customer_id")).toBe(true);
    expect(col).toBeTruthy();
  });

  test("regular and cashier history show salary, advances, debts; no opening balance", async () => {
    const regular = await createRegular("موظف كشف");
    const cashier = await createLinkedCashier("كاشير كشف شاشات");
    await postPayment(regular.id, {
      purpose: "salary_payment",
      amount: 1200,
      occurred_on: "2026-08-10",
      payment_method: "transfer",
      reference_note: "راتب آب",
    });
    await postPayment(regular.id, {
      purpose: "salary_advance",
      amount: 200,
      occurred_on: "2026-08-05",
      payment_method: "cash",
      reference_note: "سلفة آب",
    });
    await postPayment(cashier.id, {
      purpose: "salary_payment",
      amount: 800,
      occurred_on: "2026-08-12",
      payment_method: "transfer",
      reference_note: "راتب كاشير",
    });

    const customerId = await insertCustomer("ذمة موظف كشف", "EMP-H1", 0);
    const linked = await request(ctx.app)
      .post(`/api/v1/employees/${regular.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: customerId });
    expect(linked.status).toBe(200);
    const txId = await insertOnAccountSale({
      customerId,
      employeeId: regular.id,
      total: 90,
      createdAt: "2026-08-08 10:00:00",
      name: "خبز",
      receipt: "H-90",
    });

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${regular.id}/history`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(hist.presentation).toBe("transaction_history");
    expect(hist).not.toHaveProperty("opening_balance");
    expect(hist).not.toHaveProperty("opening_balances");
    expect(hist.salaries.items.some((row) => row.amount === 1200 && row.date === "2026-08-10")).toBe(true);
    expect(hist.salaries.period_total).toBe(1200);
    expect(hist.advances.items.some((row) => row.amount === 200 && row.date === "2026-08-05")).toBe(true);
    expect(hist.advances.period_total).toBe(200);
    expect(hist.advances.outstanding_as_of).toBe(200);
    expect(hist.debts.linked).toBe(true);
    expect(hist.debts.items.some((row) => row.source_id === txId && row.original === 90)).toBe(true);
    expect(hist.debts.items[0].description).toMatch(/خبز/);
    expect(hist.debts.period_total).toBe(90);

    const cashHist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${cashier.id}/history`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(cashHist.kind).toBe("cashier");
    expect(cashHist.salaries.period_total).toBe(800);
    expect(cashHist).not.toHaveProperty("opening_balance");
  });

  test("date filter keeps outstanding advances/debts for payroll deductions", async () => {
    const emp = await createRegular("موظف قائم قديم");
    const advance = await postPayment(emp.id, {
      purpose: "salary_advance",
      amount: 75,
      occurred_on: "2026-01-15",
      payment_method: "cash",
      reference_note: "سلفة قديمة",
    });
    const customerId = await insertCustomer("ذمة قديمة", "EMP-OLD1", 0);
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: customerId });
    await insertOnAccountSale({
      customerId,
      employeeId: emp.id,
      total: 40,
      createdAt: "2026-01-20 09:00:00",
      name: "حليب",
      receipt: "OLD-40",
    });

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(hist.advances.items).toHaveLength(0);
    expect(hist.advances.outstanding_items.some((row) => row.id === advance.id && row.remaining === 75)).toBe(
      true
    );
    expect(hist.advances.outstanding_as_of).toBe(75);
    expect(hist.debts.items).toHaveLength(0);
    expect(hist.debts.outstanding_items.some((row) => row.remaining === 40)).toBe(true);

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-08-01", period_to: "2026-08-31", as_of: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(preview.advances.some((row) => row.id === advance.id && row.remaining === 75)).toBe(true);
    expect(preview.debts.some((row) => row.remaining === 40)).toBe(true);
  });

  test("GET payroll-preview never posts salary or settlements", async () => {
    const emp = await createRegular("معاينة فقط");
    const before = {
      periods: (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n,
      payouts: (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_payroll_payouts")).n,
      opex: (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n,
      led: (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n,
    };
    const res = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/payroll-preview`)
      .query({ period_from: "2026-08-01", period_to: "2026-08-31" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(unwrap(res.body).kind).toBe("regular");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n).toBe(before.periods);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_payroll_payouts")).n).toBe(before.payouts);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(before.opex);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(before.led);
  });

  test("partial debt settlement then leftover cannot be deducted twice; remaining stays", async () => {
    const emp = await createRegular("موظف ذمة جزئية");
    const customerId = await insertCustomer("ذمة جزئية", "EMP-D1", 0);
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: customerId });
    const txId = await insertOnAccountSale({
      customerId,
      employeeId: emp.id,
      total: 500,
      createdAt: "2026-08-02 11:00:00",
      name: "مشتريات",
      receipt: "D-500",
    });

    const first = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 3000,
        cash_paid: 2300,
        payment_method: "transfer",
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: 200 }],
        idempotency_key: `debt-partial-${emp.id}`,
      });
    expect(first.status).toBe(201);
    const payout = unwrap(first.body);
    expect(payout.cash_paid).toBe(2300);
    expect(payout.breakdown.product_debt_deducted).toBe(200);
    expect(payout.breakdown.net_salary).toBe(2800);
    expect(payout.breakdown.remaining_salary).toBe(500);
    expect(payout.in_kind_expense_id).toBeTruthy();

    const inKind = await ctx.db.get("SELECT * FROM operating_expenses WHERE id = ?", [
      payout.in_kind_expense_id,
    ]);
    expect(inKind.source).toBe("employee_salary_in_kind");
    expect(inKind.reference_note).toMatch(/غير نقدي/);
    expect(Number(inKind.amount)).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(
      300
    );

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-09-01", period_to: "2026-09-30", as_of: "2026-09-16" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = preview.debts.find((row) => row.source_id === txId);
    expect(debt.original).toBe(500);
    expect(debt.settled).toBe(200);
    expect(debt.remaining).toBe(300);

    const again = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-09-01",
        period_to: "2026-09-30",
        occurred_on: "2026-09-16",
        salary_before_deductions: 1000,
        cash_paid: 1000,
        payment_method: "transfer",
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: 500 }],
      });
    expect(again.status).toBe(400);

    const second = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-09-01",
        period_to: "2026-09-30",
        occurred_on: "2026-09-16",
        salary_before_deductions: 1000,
        cash_paid: 700,
        payment_method: "transfer",
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: 300 }],
      });
    expect(second.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(
      0
    );
    const settledPreview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-10-01", period_to: "2026-10-31", as_of: "2026-10-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(settledPreview.debts.some((row) => row.source_id === txId)).toBe(false);
  });

  test("partial salary payment preserves remainder without repeating deductions", async () => {
    const emp = await createRegular("راتب جزئي");
    const advance = await postPayment(emp.id, {
      purpose: "salary_advance",
      amount: 500,
      occurred_on: "2026-08-04",
      payment_method: "cash",
      reference_note: "سلفة للحسم",
    });
    const opexBefore = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'employee_payment' AND id IN (SELECT operating_expense_id FROM employee_ledger_entries WHERE employee_id = ? AND purpose = 'salary_advance')",
      [emp.id]
    );

    const first = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 3000,
        cash_paid: 1000,
        payment_method: "transfer",
        deductions: [{ kind: "advance", source_type: "ledger_entry", source_id: advance.id, amount: 500 }],
        idempotency_key: `partial-sal-${emp.id}`,
      });
    expect(first.status).toBe(201);
    expect(unwrap(first.body).breakdown.remaining_salary).toBe(1500);
    expect(unwrap(first.body).breakdown.advance_deducted).toBe(500);

    const opexAfter = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'employee_payment' AND id IN (SELECT operating_expense_id FROM employee_ledger_entries WHERE employee_id = ? AND purpose = 'salary_advance')",
      [emp.id]
    );
    expect(opexAfter.n).toBe(opexBefore.n);

    const replay = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 3000,
        cash_paid: 1000,
        payment_method: "transfer",
        deductions: [{ kind: "advance", source_type: "ledger_entry", source_id: advance.id, amount: 500 }],
        idempotency_key: `partial-sal-${emp.id}`,
      });
    expect(replay.status).toBe(201);
    expect(unwrap(replay.body).id).toBe(unwrap(first.body).id);

    const mismatch = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 3000,
        cash_paid: 50,
        payment_method: "transfer",
        deductions: [],
        idempotency_key: `partial-sal-${emp.id}`,
      });
    expect(mismatch.status).toBe(409);

    const repeatDeduction = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        cash_paid: 0,
        deductions: [{ kind: "advance", source_type: "ledger_entry", source_id: advance.id, amount: 500 }],
      });
    expect(repeatDeduction.status).toBe(201);
    expect(unwrap(repeatDeduction.body).breakdown.advance_deducted).toBe(0);

    const rest = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        cash_paid: 1500,
        payment_method: "transfer",
        deductions: [],
      });
    expect(rest.status).toBe(201);
    expect(unwrap(rest.body).breakdown.remaining_salary).toBe(0);
    expect(unwrap(rest.body).breakdown.advance_deducted).toBe(0);

    const nextMonth = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-09-01", period_to: "2026-09-30", as_of: "2026-09-16" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(nextMonth.advances.some((row) => row.id === advance.id)).toBe(false);
  });

  test("zero cash when deductions cover salary does not create a fake cash movement", async () => {
    const emp = await createRegular("تغطية بالحسم");
    const customerId = await insertCustomer("ذمة تغطية", "EMP-Z1", 0);
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: customerId });
    const txId = await insertOnAccountSale({
      customerId,
      employeeId: emp.id,
      total: 100,
      createdAt: "2026-08-03 12:00:00",
      name: "صنف",
      receipt: "Z-100",
    });
    const ledBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n;
    const movBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n;

    const res = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 100,
        cash_paid: 0,
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: 100 }],
      });
    expect(res.status).toBe(201);
    expect(unwrap(res.body).cash_paid).toBe(0);
    expect(unwrap(res.body).ledger_entry_id).toBeNull();
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(ledBefore);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n).toBe(movBefore);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(
      0
    );

    const overview = await buildFinanceOverview(ctx.db, "2026-08-01", "2026-08-31");
    const opexSum = await ctx.db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM operating_expenses WHERE paid_on >= '2026-08-01' AND paid_on <= '2026-08-31'`
    );
    expect(overview.profit.operatingExpenses).toBeCloseTo(Number(opexSum.total), 2);
    const inKind = await ctx.db.get(
      "SELECT * FROM operating_expenses WHERE source = 'employee_salary_in_kind' AND source_id = ?",
      [unwrap(res.body).id]
    );
    expect(inKind).toBeTruthy();
    expect(Number(inKind.amount)).toBe(100);
  });

  test("selected deductions cannot exceed remaining salary", async () => {
    const emp = await createRegular("حسم زائد");
    const advance = await postPayment(emp.id, {
      purpose: "salary_advance",
      amount: 400,
      occurred_on: "2026-08-01",
      payment_method: "cash",
    });
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        salary_before_deductions: 300,
        cash_paid: 0,
        deductions: [{ kind: "advance", source_type: "ledger_entry", source_id: advance.id, amount: 400 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code || unwrap(res.body).code).toBe("DEDUCTIONS_EXCEED_SALARY");
  });

  test("POS pending has no effect; approved advance appears once on the employee", async () => {
    const emp = await createRegular("سلفة صندوق");
    const pending = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 35, notes: "معلّق" });
    expect(pending.status).toBe(201);
    const pendingId = unwrap(pending.body).request_id;
    const histPending = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2026-01-01", to: "2026-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(histPending.advances.outstanding_as_of).toBe(0);

    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 60, notes: "سلفة معتمدة" });
    const requestId = unwrap(created.body).request_id;
    const approve = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);
    const retry = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(retry.status).toBe(400);

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2026-01-01", to: "2026-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const matches = hist.advances.outstanding_items.filter((row) => row.advance_request_id === requestId);
    expect(matches).toHaveLength(1);
    expect(matches[0].amount).toBe(60);
    expect(hist.advances.items.filter((row) => row.advance_request_id === pendingId)).toHaveLength(0);
  });

  test("cashier missing snapshot is not a final wage; GET does not post", async () => {
    const emp = await createLinkedCashier("كاشير بلا لقطة");
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, '2026-08-04T07:00:00.000Z', '2026-08-04T15:00:00.000Z', 100, 'closed', NULL)`,
      [cashierUserId]
    );
    const before = (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n;
    const previewRes = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/payroll-preview`)
      .query({ period_from: "2026-08-01", period_to: "2026-08-31" })
      .set(authHeader(adminToken));
    expect(previewRes.status).toBe(200);
    const preview = unwrap(previewRes.body);
    expect(preview.calculation_final).toBe(false);
    expect(preview.calculated_salary).toBeNull();
    expect(preview.hours.preview_pay_incomplete).toBe(true);
    expect(preview.hours.review_flags).toContain("missing_snapshot");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n).toBe(before);

    const paid = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-31",
        cash_paid: 100,
        payment_method: "transfer",
      });
    expect(paid.status).toBe(201);
    expect(unwrap(paid.body).cash_paid).toBe(100);
    expect(unwrap(paid.body).breakdown.salary_before_deductions).toBeNull();
  });

  test("cashier can pay less or more than calculated wage without freezing it", async () => {
    const emp = await createLinkedCashier("كاشير ساعات نهائية");
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, '2026-07-03T07:00:00.000Z', '2026-07-03T15:00:00.000Z', 100, 'closed', 20)`,
      [cashierUserId]
    );
    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-07-01", period_to: "2026-07-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(preview.calculation_final).toBe(true);
    expect(preview.calculated_salary).toBe(160);

    const first = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-07-01",
        period_to: "2026-07-31",
        occurred_on: "2026-07-31",
        cash_paid: 80,
        payment_method: "transfer",
      });
    expect(first.status).toBe(201);
    expect(unwrap(first.body).cash_paid).toBe(80);
    expect(unwrap(first.body).breakdown.salary_before_deductions).toBeNull();

    const more = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-07-01",
        period_to: "2026-07-31",
        occurred_on: "2026-07-31",
        cash_paid: 200,
        payment_method: "transfer",
      });
    expect(more.status).toBe(201);
    expect(unwrap(more.body).cash_paid).toBe(200);
    expect(unwrap(more.body).breakdown.salary_before_deductions).toBeNull();

    const overlap = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-07-15",
        period_to: "2026-08-15",
        occurred_on: "2026-08-15",
        cash_paid: 10,
        payment_method: "transfer",
      });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code || unwrap(overlap.body).code).toBe("PERIOD_OVERLAP");
  });

  test("purchase refund reduces remaining debt without a payroll settlement", async () => {
    const emp = await createRegular("موظف مرتجع");
    const customerId = await insertCustomer("ذمة مرتجع", "EMP-R1", 0);
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: customerId });
    const txId = await insertOnAccountSale({
      customerId,
      employeeId: emp.id,
      total: 80,
      createdAt: "2026-08-06 08:00:00",
      name: "صنف مرتجع",
      receipt: "R-80",
    });
    await ctx.db.run(
      `INSERT INTO refunds
         (original_transaction_id, items_json, subtotal, tax, total, payment_method, reason, cashier_id, status, customer_id, created_at)
       VALUES (?, '[]', 30, 0, 30, 'on_account', 'مرتجع', ?, 'approved', ?, '2026-08-07')`,
      [txId, cashierUserId, customerId]
    );
    await ctx.db.run("UPDATE customers SET balance = balance - 30 WHERE id = ?", [customerId]);

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-08-01", period_to: "2026-08-31", as_of: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = preview.debts.find((row) => row.source_id === txId);
    expect(debt.original).toBe(80);
    expect(debt.refunded).toBe(30);
    expect(debt.remaining).toBe(50);
  });

  test("non-cashier can record a cash payment without a salary-before amount", async () => {
    const emp = await createRegular("دفعة دون استحقاق");
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-20",
        cash_paid: 250,
        payment_method: "cash",
      });
    expect(res.status).toBe(201);
    expect(unwrap(res.body).cash_paid).toBe(250);
    expect(unwrap(res.body).breakdown.salary_before_deductions).toBeNull();
    expect(unwrap(res.body).ledger_entry_id).toBeTruthy();
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(hist.salaries.items.some((row) => row.amount === 250)).toBe(true);
  });
});
