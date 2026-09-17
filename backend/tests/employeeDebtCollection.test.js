import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createTestEmployee,
} from "./helpers.js";
import { captureBaseline } from "./load/snapshot.js";
import { checkInvariants } from "./load/invariants.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function unwrap(body) {
  return body?.data ?? body;
}

function codeOf(res) {
  return res.body?.code || unwrap(res.body)?.code;
}

describe("employee debt collection, ledger, identity", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierUserId;
  let productPrice;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierUserId = cashierLogin.body.user.id;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    productPrice = Number(product.price);
    await ctx.db.run("UPDATE products SET stock = 5000 WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createLinkedEmployee(name) {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, start_on: "2026-01-01" });
    expect(created.status).toBe(201);
    const emp = unwrap(created.body);
    const account = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(adminToken))
      .send({});
    expect([200, 201]).toContain(account.status);
    return unwrap(account.body);
  }

  async function insertEmployeeSale(emp, { total = 100, qty = 10, createdAt = "2026-01-15 10:00:00" } = {}) {
    const unit = round2(total / qty);
    const tx = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number)
       VALUES (?, ?, ?, 0, ?, 'on_account', ?, ?, 'completed', ?, ?)`,
      [
        cashierUserId,
        JSON.stringify([{ name: "ذمة موظف", quantity: qty, price: unit, product_id: ctx.productId }]),
        total,
        total,
        emp.customer_id,
        emp.id,
        createdAt,
        `ED-${emp.id}-${Date.now()}`,
      ]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', ?)`,
      [tx.lastID, total]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_gross)
       VALUES (?, ?, 'ذمة موظف', ?, ?, ?, ?)`,
      [tx.lastID, ctx.productId, qty, unit, total, total]
    );
    await ctx.db.run("UPDATE customers SET balance = COALESCE(balance, 0) + ? WHERE id = ?", [
      total,
      emp.customer_id,
    ]);
    return { txId: tx.lastID, total, qty };
  }

  async function payrollDeduct(emp, { sourceId, amount, periodFrom, periodTo, occurredOn, salary = 500 }) {
    return request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: periodFrom,
        period_to: periodTo,
        occurred_on: occurredOn,
        salary_before_deductions: salary,
        cash_paid: 0,
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: sourceId, amount }],
      });
  }

  async function repay(emp, { amount, method = "cash", key, occurredOn = "2026-09-17" }) {
    return request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-payments`)
      .set(authHeader(adminToken))
      .send({
        amount,
        payment_method: method,
        occurred_on: occurredOn,
        idempotency_key: key,
      });
  }

  async function refundSale(txId, quantity) {
    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity }],
        reason: "employee debt refund",
        payment_method: "on_account",
      });
    expect(createRes.status).toBe(201);
    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(createRes.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);
    return approveRes;
  }

  test("stale payroll preview cannot collect more than live remaining after a repayment", async () => {
    const emp = await createLinkedEmployee("__collect_stale__");
    const { txId, total } = await insertEmployeeSale(emp);
    expect(total).toBeCloseTo(100, 2);

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-09-01", period_to: "2026-09-30", as_of: "2026-09-17" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = preview.debts.find((row) => row.source_id === txId);
    expect(debt.remaining).toBeCloseTo(100, 2);

    const paid = await repay(emp, { amount: 60, key: `repay-stale-${emp.id}` });
    expect([200, 201]).toContain(paid.status);

    const payout = await payrollDeduct(emp, {
      sourceId: txId,
      amount: 100,
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
      occurredOn: "2026-09-17",
      salary: 200,
    });
    expect(payout.status).toBe(201);
    expect(unwrap(payout.body).breakdown.product_debt_deducted).toBeCloseTo(40, 2);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(0, 2);
    const settled = await ctx.db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM employee_settlements
       WHERE employee_id = ? AND kind = 'debt' AND status = 'active'`,
      [emp.id]
    );
    expect(Number(settled.s)).toBeCloseTo(40, 2);
  });

  test("concurrent payrolls cannot settle the same remaining twice", async () => {
    const emp = await createLinkedEmployee("__collect_race_pay__");
    const { txId } = await insertEmployeeSale(emp);

    const [a, b] = await Promise.all([
      payrollDeduct(emp, {
        sourceId: txId,
        amount: 100,
        periodFrom: "2026-01-01",
        periodTo: "2026-01-31",
        occurredOn: "2026-01-31",
        salary: 100,
      }),
      payrollDeduct(emp, {
        sourceId: txId,
        amount: 100,
        periodFrom: "2026-02-01",
        periodTo: "2026-02-28",
        occurredOn: "2026-02-28",
        salary: 100,
      }),
    ]);
    expect([a.status, b.status].every((s) => s === 201 || s === 400)).toBe(true);
    const settled = await ctx.db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM employee_settlements
       WHERE employee_id = ? AND kind = 'debt' AND status = 'active'`,
      [emp.id]
    );
    expect(Number(settled.s)).toBeCloseTo(100, 2);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(0, 2);
  });

  test("concurrent payroll deduction and direct repayment cannot collect twice", async () => {
    const emp = await createLinkedEmployee("__collect_race_mix__");
    const { txId } = await insertEmployeeSale(emp);

    const [pay, cash] = await Promise.all([
      payrollDeduct(emp, {
        sourceId: txId,
        amount: 60,
        periodFrom: "2026-03-01",
        periodTo: "2026-03-31",
        occurredOn: "2026-03-31",
        salary: 60,
      }),
      repay(emp, { amount: 60, key: `race-repay-${emp.id}`, occurredOn: "2026-03-31" }),
    ]);
    const okPay = pay.status === 201 ? unwrap(pay.body).breakdown.product_debt_deducted : 0;
    const okCash = [200, 201].includes(cash.status) ? unwrap(cash.body).amount : 0;
    const collected = Number(okPay) + Number(okCash);
    expect(collected).toBeLessThanOrEqual(100.009);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    const remaining = Math.max(0, Number(live.balance) || 0);
    expect(collected + remaining).toBeCloseTo(100, 2);
    expect(Number(live.balance)).toBeGreaterThanOrEqual(-0.009);
  });

  test("payroll settlement appears once on the canonical statement and matches balance", async () => {
    const emp = await createLinkedEmployee("__collect_ledger__");
    const { txId } = await insertEmployeeSale(emp);
    const payout = await payrollDeduct(emp, {
      sourceId: txId,
      amount: 40,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
      occurredOn: "2026-04-30",
      salary: 40,
    });
    expect(payout.status).toBe(201);

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/customers/${emp.customer_id}/statement`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const settlementRows = (stmt.rows || []).filter((row) => row.sourceType === "payroll_settlement");
    expect(settlementRows.length).toBe(1);
    expect(Number(settlementRows[0].credit)).toBeCloseTo(40, 2);
    expect(String(settlementRows[0].description || "")).toMatch(/غير نقدية/);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(stmt.totals?.finalBalance)).toBeCloseTo(Number(live.balance), 2);
    expect(Number(live.balance)).toBeCloseTo(60, 2);

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const invoice = hist.debts.items.find((row) => row.source_id === txId);
    expect(invoice.settled).toBeCloseTo(40, 2);
    expect(invoice.remaining).toBeCloseTo(60, 2);
    expect(Number(hist.debts.customer_balance)).toBeCloseTo(60, 2);
  });

  test("dated payroll settlement reversal appears as a debit without duplicating the original credit", async () => {
    const emp = await createLinkedEmployee("__collect_rev__");
    const { txId } = await insertEmployeeSale(emp);
    const payout = await payrollDeduct(emp, {
      sourceId: txId,
      amount: 25,
      periodFrom: "2026-05-01",
      periodTo: "2026-05-31",
      occurredOn: "2026-05-15",
      salary: 25,
    });
    expect(payout.status).toBe(201);
    const row = await ctx.db.get(
      `SELECT * FROM employee_settlements WHERE employee_id = ? AND kind = 'debt' ORDER BY id DESC LIMIT 1`,
      [emp.id]
    );
    await ctx.db.run(
      `UPDATE employee_settlements SET status = 'reversed', reversed_on = '2026-05-20' WHERE id = ?`,
      [row.id]
    );
    await ctx.db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [25, emp.customer_id]);

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/customers/${emp.customer_id}/statement`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const events = stmt.rows || [];
    const credits = events.filter((e) => e.sourceType === "payroll_settlement");
    const debits = events.filter((e) => e.sourceType === "payroll_settlement_reversal");
    expect(credits).toHaveLength(1);
    expect(debits).toHaveLength(1);
    expect(Number(credits[0].credit)).toBeCloseTo(25, 2);
    expect(Number(debits[0].debit)).toBeCloseTo(25, 2);
    expect(String(debits[0].date || "")).toMatch(/2026-05-20/);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(stmt.totals?.finalBalance)).toBeCloseTo(Number(live.balance), 2);
    expect(Number(live.balance)).toBeCloseTo(100, 2);
  });

  test("full refund after partial payroll keeps collected value as retained credit (does not cap)", async () => {
    const emp = await createLinkedEmployee("__refund_pay__");
    const { txId } = await insertEmployeeSale(emp);
    expect((await payrollDeduct(emp, {
      sourceId: txId,
      amount: 40,
      periodFrom: "2026-06-01",
      periodTo: "2026-06-30",
      occurredOn: "2026-06-30",
      salary: 40,
    })).status).toBe(201);
    await refundSale(txId, 10);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    // 100 goods − 40 salary settlement − 100 refund credit = −40 retained collected value.
    expect(Number(live.balance)).toBeCloseTo(-40, 2);
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const invoice = hist.debts.items.find((row) => row.source_id === txId);
    expect(invoice.refunded).toBeCloseTo(100, 2);
    expect(invoice.remaining).toBeCloseTo(0, 2);
    expect(Number(hist.debts.customer_balance)).toBeCloseTo(-40, 2);
  });

  test("full refund after direct repayment keeps collected cash as retained credit", async () => {
    const emp = await createLinkedEmployee("__refund_cash__");
    const { txId } = await insertEmployeeSale(emp);
    expect([200, 201]).toContain((await repay(emp, { amount: 40, key: `rf-c-pay-${emp.id}` })).status);
    await refundSale(txId, 10);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(-40, 2);
  });

  test("full refund before collection returns the account to zero, and a second refund is rejected", async () => {
    const emp = await createLinkedEmployee("__refund_full__");
    const { txId } = await insertEmployeeSale(emp);
    await refundSale(txId, 10);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(0, 2);
    const second = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 10 }],
        reason: "duplicate",
        payment_method: "on_account",
      });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  test("partial refunds preserve remaining value before and after collection", async () => {
    const emp = await createLinkedEmployee("__refund_part__");
    const { txId } = await insertEmployeeSale(emp);
    await refundSale(txId, 4);
    let live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(60, 2);
    expect((await payrollDeduct(emp, {
      sourceId: txId,
      amount: 20,
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      occurredOn: "2026-07-31",
      salary: 20,
    })).status).toBe(201);
    live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(40, 2);
  });

  test("تسجيل تسديد ذمة posts one receipt, updates the same balance, and shows in history", async () => {
    const emp = await createLinkedEmployee("__repay_ui__");
    await insertEmployeeSale(emp);
    const first = await repay(emp, { amount: 35, method: "transfer", key: `ui-pay-${emp.id}` });
    expect(first.status).toBe(201);
    const replay = await repay(emp, { amount: 35, method: "transfer", key: `ui-pay-${emp.id}` });
    expect([200, 201]).toContain(replay.status);
    expect(unwrap(replay.body).replay).toBe(true);
    const live = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
    expect(Number(live.balance)).toBeCloseTo(65, 2);
    const vouchers = await ctx.db.all(
      `SELECT v.id FROM vouchers v JOIN voucher_lines vl ON vl.voucher_id = v.id
       WHERE vl.customer_id = ? AND v.voucher_type = 'receipt' AND v.status = 'posted'`,
      [emp.customer_id]
    );
    expect(vouchers).toHaveLength(1);
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(hist.repayments.items.some((row) => Number(row.amount) === 35)).toBe(true);
    expect(hist.repayments.period_total).toBeCloseTo(35, 2);
    expect(hist.debts.items[0].remaining).toBeCloseTo(65, 2);
  });

  test("ordinary voucher repayment path stays open; office invoice/delivery/check writes stay blocked", async () => {
    const emp = await createLinkedEmployee("__guard_writes__");
    await insertEmployeeSale(emp, { total: 10, qty: 1 });

    const draft = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "receipt",
        voucher_date: "2026-09-17",
        notes: "authorized employee repayment",
        lines: [{ line_type: "cash", amount: 5, customer_id: emp.customer_id }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/vouchers/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);

    const invoice = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: emp.customer_id,
        invoice_date: "2026-09-17",
        items: [{ product_id: ctx.productId, quantity: 1 }],
      });
    expect(invoice.status).toBe(409);
    expect(codeOf(invoice)).toBe("EMPLOYEE_ACCOUNT_PROTECTED");

    const delivery = await request(ctx.app)
      .post("/api/v1/deliveries/sales")
      .set(authHeader(adminToken))
      .send({ customer_id: emp.customer_id, delivery_date: "2026-09-17" });
    expect(delivery.status).toBe(409);
    expect(codeOf(delivery)).toBe("EMPLOYEE_ACCOUNT_PROTECTED");

    const check = await request(ctx.app)
      .post("/api/v1/banks/checks")
      .set(authHeader(adminToken))
      .send({
        check_type: "received",
        amount: 10,
        customer_id: emp.customer_id,
      });
    expect(check.status).toBe(409);
    expect(codeOf(check)).toBe("EMPLOYEE_ACCOUNT_PROTECTED");
  });

  test("ordinary link does not stamp walk-in history or absorb unstamped invoices", async () => {
    const walkIn = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('__walk_hist__', 'WH-1', 0, 0, 0)`
    );
    const sale = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, status, created_at, receipt_number)
       VALUES (?, '[]', 10, 0, 10, 'on_account', ?, 'completed', '2026-08-01 10:00:00', 'WH-10')`,
      [cashierUserId, walkIn.lastID]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', 10)`,
      [sale.lastID]
    );
    await ctx.db.run("UPDATE customers SET balance = 10 WHERE id = ?", [walkIn.lastID]);

    const emp = await createTestEmployee(ctx.db, { name: "__no_stamp__" });
    const link = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: walkIn.lastID });
    expect(link.status).toBe(409);
    expect(codeOf(link)).toBe("CUSTOMER_HAS_HISTORY");
    const tx = await ctx.db.get("SELECT employee_id FROM transactions WHERE id = ?", [sale.lastID]);
    expect(tx.employee_id).toBeNull();

    const linked = await createLinkedEmployee("__no_fallback__");
    const unstamped = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, status, created_at, receipt_number)
       VALUES (?, '[]', 8, 0, 8, 'on_account', ?, 'completed', '2026-08-02 10:00:00', 'NF-8')`,
      [cashierUserId, linked.customer_id]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', 8)`,
      [unstamped.lastID]
    );
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${linked.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((hist.debts.items || []).some((row) => row.source_id === unstamped.lastID)).toBe(false);
  });

  test("balance-group delete still counts employee-owned customers", async () => {
    const emp = await createLinkedEmployee("__group_ref__");
    const ins = await ctx.db.run(
      `INSERT INTO customer_balance_groups (slug, label_ar, sort_order, is_system, active)
       VALUES ('emp-g-del', 'فئة موظف اختبار', 99, 0, 1)`
    );
    await ctx.db.run("UPDATE customers SET balance_group_id = ? WHERE id = ?", [
      ins.lastID,
      emp.customer_id,
    ]);
    const del = await request(ctx.app)
      .delete(`/api/v1/customers/meta/balance-groups/${ins.lastID}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(400);
    expect(codeOf(del)).toBe("GROUP_IN_USE");
  });

  test("load invariant counts active payroll settlements and their reversals", async () => {
    const emp = await createLinkedEmployee("__inv_settle__");
    const { txId } = await insertEmployeeSale(emp, { total: productPrice * 2, qty: 2 });
    const baseline = await captureBaseline(ctx.db);
    expect((await payrollDeduct(emp, {
      sourceId: txId,
      amount: productPrice,
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      occurredOn: "2026-08-31",
      salary: productPrice,
    })).status).toBe(201);
    let results = await checkInvariants(ctx.db, baseline);
    let row = results.find((r) => r.name === "customer_balance_matches_on_account_sales");
    expect(row.ok).toBe(true);

    const settlement = await ctx.db.get(
      `SELECT * FROM employee_settlements WHERE employee_id = ? AND kind = 'debt' ORDER BY id DESC LIMIT 1`,
      [emp.id]
    );
    await ctx.db.run(
      `UPDATE employee_settlements SET status = 'reversed', reversed_on = '2026-09-01' WHERE id = ?`,
      [settlement.id]
    );
    await ctx.db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [
      productPrice,
      emp.customer_id,
    ]);
    results = await checkInvariants(ctx.db, baseline);
    row = results.find((r) => r.name === "customer_balance_matches_on_account_sales");
    expect(row.ok).toBe(true);
  });
});
