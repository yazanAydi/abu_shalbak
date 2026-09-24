import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { round2 } from "../utils/money.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("GET /finance/overview — formulas and reconciliation", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let shiftId;
  let saleTxId;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierId = cashierLogin.body.user.id;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;

    await ctx.db.run("UPDATE products SET cost = 6, price = 10, stock = 100, tax_rate = 0 WHERE id = ?", [
      ctx.productId,
    ]);

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);
    saleTxId = sale.body.data.transaction_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function overview(from = today, to = today) {
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${from}&to=${to}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("gross sales = completed POS sale; net = gross − approved refunds", async () => {
    const before = await overview();
    expect(before.sales.gross).toBe(20);
    expect(before.sales.transactionCount).toBe(1);
    expect(before.pos_sales_total).toBe(20);
    expect(before.pos_transaction_count).toBe(1);

    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status, approved_at
       ) VALUES (?, ?, 10, 0, 10, 'cash', 'approved', ?, ?, 'approved', datetime('now'))`,
      [saleTxId, JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]), cashierId, shiftId]
    );

    const after = await overview();
    expect(after.sales.gross).toBe(20);
    expect(after.sales.refunds).toBe(10);
    expect(after.sales.refundCount).toBe(1);
    expect(after.sales.net).toBe(10);
    expect(after.net_pos_sales).toBe(round2(after.sales.gross - after.sales.refunds));
  });

  test("pending and rejected refunds are excluded from refunds and net", async () => {
    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status
       ) VALUES (?, ?, 10, 0, 10, 'cash', 'pending', ?, ?, 'pending')`,
      [saleTxId, JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]), cashierId, shiftId]
    );
    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status
       ) VALUES (?, ?, 10, 0, 10, 'cash', 'rejected', ?, ?, 'rejected')`,
      [saleTxId, JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]), cashierId, shiftId]
    );

    const body = await overview();
    expect(body.sales.refunds).toBe(10);
    expect(body.sales.refundCount).toBe(1);
    expect(body.sales.net).toBe(10);
  });

  test("COGS uses snapshot; refund reverses original cost; later products.cost is ignored", async () => {
    const before = await overview();
    expect(before.cogs_unknown).toBe(false);
    expect(before.profit.cogsKnown).toBe(true);
    expect(before.profit.cogs).toBe(6);
    expect(before.net_estimated_cogs).toBe(6);
    expect(before.profit.grossProfit).toBe(4);
    expect(before.estimated_gross_profit).toBe(4);
    expect(before.profit.grossMarginPercent).toBe(40);

    await ctx.db.run("UPDATE products SET cost = 99 WHERE id = ?", [ctx.productId]);
    const after = await overview();
    expect(after.profit.cogs).toBe(6);
    expect(after.profit.grossProfit).toBe(4);
  });

  test("non-completed transactions are not sales", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 50, 0, 50, 0, 'cash', ?, 'voided', datetime('now'))`,
      [cashier.id, JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 50 }]), shiftId]
    );
    const body = await overview();
    expect(body.sales.gross).toBe(20);
    expect(body.sales.transactionCount).toBe(1);
  });

  test("office-style completed sale without shift is included in gross sales", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const ins = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 15, 0, 15, 0, 'cash', NULL, 'completed', datetime('now'))`,
      [cashier.id, JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 15 }])]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate, unit_cost_at_sale, gross_profit)
       VALUES (?, ?, 'Office line', 1, 15, 15, 0, 15, 0, 3, 12)`,
      [ins.lastID]
    );

    const body = await overview();
    expect(body.sales.gross).toBe(35);
    expect(body.sales.transactionCount).toBe(2);
    expect(body.sales.net).toBe(25);
    expect(body.profit.cogs).toBe(9);
    expect(body.profit.grossProfit).toBe(16);
  });

  test("operating expenses reduce operating net; supplier payments do not", async () => {
    const cat = await ctx.db.get("SELECT id, name FROM expense_categories ORDER BY id LIMIT 1");
    await request(ctx.app)
      .post("/api/v1/expenses")
      .set(authHeader(adminToken))
      .send({
        category_id: cat.id,
        amount: 5,
        paid_on: today,
        payment_method: "cash",
      })
      .expect(201);

    const supplier = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('Opex supplier')");
    await ctx.db.run(
      `INSERT INTO supplier_payments (supplier_id, amount, paid_on, payment_method)
       VALUES (?, 400, ?, 'transfer')`,
      [supplier.lastID, today]
    );

    const body = await overview();
    expect(body.profit.operatingExpenses).toBe(5);
    expect(body.operating_expenses_total).toBe(5);
    expect(body.profit.grossProfit).toBe(16);
    expect(body.profit.operatingNetProfit).toBe(11);
    expect(body.supplierPayments.legacyTotal).toBe(400);
  });

  test("reconciles with sales reports, expenses summary, customers/balances, and inventory SQL", async () => {
    await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance)
       VALUES ('Due A', 'CA', 50, 50), ('Due B', 'CB', 30.02, 30), ('Credit', 'CC', -12, 0), ('Zero', 'CZ', 0, 0)`
    );

    const [fin, range, exp, bal] = await Promise.all([
      overview(),
      request(ctx.app)
        .get(`/api/v1/reports/range?from=${today}&to=${today}`)
        .set(authHeader(adminToken)),
      request(ctx.app)
        .get(`/api/v1/expenses/summary?from=${today}&to=${today}`)
        .set(authHeader(adminToken)),
      request(ctx.app).get("/api/v1/customers/balances").set(authHeader(adminToken)),
    ]);
    expect(range.status).toBe(200);
    expect(exp.status).toBe(200);
    expect(bal.status).toBe(200);

    const rangeBody = unwrap(range.body);
    const expBody = unwrap(exp.body);
    const balBody = unwrap(bal.body);

    expect(fin.sales.gross).toBe(rangeBody.total_sales);
    expect(fin.sales.refunds).toBe(rangeBody.refunds_total);
    expect(fin.sales.net).toBe(rangeBody.net_sales);
    expect(fin.sales.transactionCount).toBe(rangeBody.total_transactions);
    expect(fin.profit.cogs).toBe(rangeBody.cost);
    expect(fin.profit.grossProfit).toBe(rangeBody.profit);
    expect(fin.cogs_unknown).toBe(rangeBody.cost_unknown);

    expect(fin.profit.operatingExpenses).toBe(expBody.total);
    expect(fin.operating_expense_count).toBe(expBody.count);

    expect(fin.currentPosition.customerReceivables).toBe(balBody.total_due);
    const positiveCount = (balBody.customers || []).filter((c) => Number(c.balance) > 0.009).length;
    expect(fin.currentPosition.customersWithBalance).toBe(positiveCount);
    expect(fin.currentPosition.customerReceivables).toBe(80.02);

    const invSql = await ctx.db.get(
      `SELECT
         COALESCE(SUM(stock * cost), 0) AS at_cost,
         COALESCE(SUM(stock * price), 0) AS at_retail
       FROM products`
    );
    expect(fin.currentPosition.inventoryAtCost).toBe(round2(Number(invSql.at_cost)));
    expect(fin.currentPosition.inventoryAtRetail).toBe(round2(Number(invSql.at_retail)));
    expect(fin.inventory_value_at_cost).toBe(fin.currentPosition.inventoryAtCost);
    expect(fin.inventory_value_at_retail).toBe(fin.currentPosition.inventoryAtRetail);
  });

  test("inventory includes negative stock and flags zero-price stocked products", async () => {
    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('neg-1', 'Negative stock', 20, 10, 'Test', -2)`
    );
    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
       VALUES ('zero-p', 'Bakery zero price', 0, 4, 'Test', 5, 'bakery')`
    );

    const beforeSql = await ctx.db.get(
      `SELECT
         COALESCE(SUM(stock * cost), 0) AS at_cost,
         COALESCE(SUM(stock * price), 0) AS at_retail
       FROM products`
    );
    const body = await overview();
    expect(body.currentPosition.inventoryAtCost).toBe(round2(Number(beforeSql.at_cost)));
    expect(body.currentPosition.inventoryAtRetail).toBe(round2(Number(beforeSql.at_retail)));
    expect(body.currentPosition.zeroPriceStockedCount).toBeGreaterThanOrEqual(1);
    expect(body.currentPosition.nullCostStockedCount).toBe(0);
    expect(body.currentPosition.nullPriceStockedCount).toBe(0);
    expect(body.currentPosition.inventoryCostIncomplete).toBe(false);
    expect(body.currentPosition.inventoryRetailIncomplete).toBe(false);
    expect(body.currentPosition.inventoryAtCost).toBeLessThan(round2(Number(beforeSql.at_cost) + 40));

    const otherRange = await overview("2011-01-01", "2011-01-31");
    expect(otherRange.currentPosition.inventoryAtCost).toBe(body.currentPosition.inventoryAtCost);
    expect(otherRange.currentPosition.inventoryAtRetail).toBe(body.currentPosition.inventoryAtRetail);
    expect(otherRange.currentPosition.customerReceivables).toBe(body.currentPosition.customerReceivables);
  });

  test("rejects invalid date range", async () => {
    const missing = await request(ctx.app)
      .get("/api/v1/finance/overview")
      .set(authHeader(adminToken));
    expect(missing.status).toBe(400);

    const flipped = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-09-10&to=2026-09-01")
      .set(authHeader(adminToken));
    expect(flipped.status).toBe(400);
  });

  test("empty period is valid zero, not unknown", async () => {
    const body = await overview("2010-01-01", "2010-01-01");
    expect(body.sales.gross).toBe(0);
    expect(body.sales.net).toBe(0);
    expect(body.profit.cogs).toBe(0);
    expect(body.profit.cogsKnown).toBe(true);
    expect(body.profit.grossProfit).toBe(0);
    expect(body.profit.grossMarginPercent).toBeNull();
    expect(body.profit.operatingNetProfit).toBe(0);
    expect(body.purchases.gross).toBe(0);
    expect(body.purchases.returns).toBe(0);
    expect(body.purchases.net).toBe(0);
    expect(body.purchases.invoiceCount).toBe(0);
  });
});

describe("GET /finance/overview — unknown and zero cost", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function overview() {
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("unmarked zero cost leaves COGS unknown; a later cost does not fill it", async () => {
    await ctx.db.run("UPDATE products SET cost = 0, cost_known = NULL, price = 10, stock = 100 WHERE id = ?", [
      ctx.productId,
    ]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);

    const before = await overview();
    expect(before.profit.cogs).toBeNull();
    expect(before.cogs_unknown).toBe(true);
    expect(before.profit.grossProfit).toBeNull();

    await ctx.db.run("UPDATE products SET cost = 8 WHERE id = ?", [ctx.productId]);
    const after = await overview();
    expect(after.cogs_unknown).toBe(true);
    expect(after.profit.grossProfit).toBeNull();
    const item = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items ORDER BY id DESC LIMIT 1"
    );
    expect(item.unit_cost_at_sale).toBeNull();
  });

  test("explicit free cost is known zero and is not rewritten by a later cost", async () => {
    await ctx.db.run("UPDATE products SET cost = 0, cost_known = 1, price = 10, stock = 100 WHERE id = ?", [
      ctx.productId,
    ]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);
    const txId = sale.body.data?.transaction_id ?? sale.body.transaction_id;
    const before = await ctx.db.get(
      "SELECT unit_cost_at_sale, gross_profit FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(before.unit_cost_at_sale)).toBe(0);
    expect(Number(before.gross_profit)).toBe(10);

    await ctx.db.run("UPDATE products SET cost = 8 WHERE id = ?", [ctx.productId]);
    const after = await ctx.db.get(
      "SELECT unit_cost_at_sale, gross_profit FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(after.unit_cost_at_sale)).toBe(0);
    expect(Number(after.gross_profit)).toBe(10);
  });

  test("NULL snapshot cost marks profit fields null, not zero", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const shift = await ctx.db.get("SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1");
    await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'completed', datetime('now'))`,
      [
        cashier.id,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        shift.id,
      ]
    );

    const body = await overview();
    expect(body.cogs_unknown).toBe(true);
    expect(body.profit.cogsKnown).toBe(false);
    expect(body.profit.cogs).toBeNull();
    expect(body.profit.grossProfit).toBeNull();
    expect(body.profit.grossMarginPercent).toBeNull();
    expect(body.profit.operatingNetProfit).toBeNull();
    expect(body.net_estimated_cogs).toBeNull();
    expect(body.estimated_gross_profit).toBeNull();
    expect(body.sales.gross).toBeGreaterThan(0);

    const range = await request(ctx.app)
      .get(`/api/v1/reports/range?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    const rangeBody = unwrap(range.body);
    expect(rangeBody.cost).toBeNull();
    expect(rangeBody.profit).toBeNull();
    expect(body.sales.gross).toBe(rangeBody.total_sales);
  });
});

describe("GET /finance/overview — supplier payments stay unreconciled", () => {
  let ctx;
  let adminToken;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const ins = await ctx.db.run("INSERT INTO suppliers (name, balance) VALUES ('Payee', 500)");
    supplierId = ins.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function overview(from = "2026-09-01", to = "2026-09-30") {
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${from}&to=${to}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("voucher-only period is voucher_authoritative", async () => {
    const draft = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "payment",
        voucher_date: "2026-09-08",
        lines: [{ line_type: "cash", amount: 80, currency: "NIS", supplier_id: supplierId }],
      });
    expect(draft.status).toBe(201);
    const voucherId = unwrap(draft.body).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/vouchers/${voucherId}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);

    const leftDraft = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "payment",
        voucher_date: "2026-09-08",
        lines: [{ line_type: "cash", amount: 25, currency: "NIS", supplier_id: supplierId }],
      });
    expect(leftDraft.status).toBe(201);

    const receipt = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "receipt",
        voucher_date: "2026-09-08",
        lines: [{ line_type: "cash", amount: 10, currency: "NIS", supplier_id: supplierId }],
      });
    expect(receipt.status).toBe(201);
    await request(ctx.app)
      .post(`/api/v1/vouchers/${unwrap(receipt.body).id}/post`)
      .set(authHeader(adminToken))
      .expect(200);

    const body = await overview();
    expect(body.supplierPayments.status).toBe("voucher_authoritative");
    expect(body.supplierPayments.voucherTotal).toBe(80);
    expect(body.supplierPayments.legacyTotal).toBe(0);
    expect(body.supplierPayments.legacyCount).toBe(0);
    expect(body.supplierPayments.total).toBe(80);
    expect(body.profit.operatingNetProfit).toBe(0);
  });

  test("legacy rows make the headline unreconciled and total null", async () => {
    await ctx.db.run(
      `INSERT INTO supplier_payments (supplier_id, amount, paid_on, payment_method)
       VALUES (?, 80, '2026-09-08', 'transfer')`,
      [supplierId]
    );
    const body = await overview();
    expect(body.supplierPayments.status).toBe("unreconciled");
    expect(body.supplierPayments.voucherTotal).toBe(80);
    expect(body.supplierPayments.legacyTotal).toBe(80);
    expect(body.supplierPayments.legacyCount).toBe(1);
    expect(body.supplierPayments.total).toBeNull();
    expect(body.profit.operatingExpenses).toBe(0);
    expect(body.profit.operatingNetProfit).toBe(0);
  });
});

describe("GET /finance/overview — posted purchases", () => {
  let ctx;
  let adminToken;
  let supplierId;
  const from = "2026-09-01";
  const to = "2026-09-16";

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد مشتريات', 'S-FIN', 0, 0)`
    );
    supplierId = sup.lastID;
    await ctx.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')"
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function overview(rangeFrom = from, rangeTo = to) {
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${rangeFrom}&to=${rangeTo}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function createInvoice(invoiceDate, quantity, totalCost) {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: invoiceDate,
        items: [{ product_id: ctx.productId, quantity, total_cost: totalCost }],
      });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function createReturn(returnDate, quantity, totalCost) {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: returnDate,
        items: [{ product_id: ctx.productId, quantity, total_cost: totalCost }],
      });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function postInvoice(id) {
    const res = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function postReturn(id) {
    const res = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function canonicalSql(rangeFrom = from, rangeTo = to) {
    const inv = await ctx.db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_invoices
       WHERE status = 'posted' AND invoice_date >= ? AND invoice_date <= ?`,
      [rangeFrom, rangeTo]
    );
    const ret = await ctx.db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_returns
       WHERE status = 'posted' AND return_date >= ? AND return_date <= ?`,
      [rangeFrom, rangeTo]
    );
    const gross = round2(Number(inv.total) || 0);
    const returns = round2(Number(ret.total) || 0);
    return {
      gross,
      returns,
      net: round2(gross - returns),
      invoiceCount: Number(inv.n) || 0,
      returnCount: Number(ret.n) || 0,
    };
  }

  test("posted purchase is included; draft and leftover unposted are excluded", async () => {
    const profitBefore = (await overview()).profit;

    const posted = await createInvoice("2026-09-08", 2, 40);
    await postInvoice(posted.id);
    const draft = await createInvoice("2026-09-08", 3, 90);
    expect(draft.status).toBe("draft");

    const body = await overview();
    expect(body.purchases.gross).toBe(round2(Number(posted.total)));
    expect(body.purchases.invoiceCount).toBe(1);
    expect(body.purchases.returns).toBe(0);
    expect(body.purchases.net).toBe(round2(Number(posted.total)));
    expect(body.profit.grossProfit).toBe(profitBefore.grossProfit);
    expect(body.profit.operatingNetProfit).toBe(profitBefore.operatingNetProfit);

    const stillDraft = await ctx.db.get("SELECT status FROM purchase_invoices WHERE id = ?", [draft.id]);
    expect(stillDraft.status).toBe("draft");
  });

  test("date boundaries use invoice_date / return_date inclusive", async () => {
    const before = await createInvoice("2026-08-31", 1, 15);
    await postInvoice(before.id);
    const onFrom = await createInvoice("2026-09-01", 1, 20);
    await postInvoice(onFrom.id);
    const onTo = await createInvoice("2026-09-16", 1, 25);
    await postInvoice(onTo.id);
    const after = await createInvoice("2026-09-17", 1, 30);
    await postInvoice(after.id);

    const body = await overview();
    const sql = await canonicalSql();
    expect(body.purchases.gross).toBe(sql.gross);
    expect(body.purchases.invoiceCount).toBe(sql.invoiceCount);

    const outside = await overview("2026-08-31", "2026-08-31");
    expect(outside.purchases.invoiceCount).toBe(1);
    expect(outside.purchases.gross).toBe(round2(Number(before.total)));

    const afterOnly = await overview("2026-09-17", "2026-09-17");
    expect(afterOnly.purchases.invoiceCount).toBe(1);
    expect(afterOnly.purchases.gross).toBe(round2(Number(after.total)));
    expect(body.purchases.gross).toBe(
      round2(sql.gross)
    );
    expect(body.purchases.gross).toBe(
      round2(Number(onFrom.total) + Number(onTo.total) + 40)
    );
  });

  test("posted purchase return reduces net; draft return does not", async () => {
    const postedRet = await createReturn("2026-09-10", 1, 12);
    await postReturn(postedRet.id);
    const draftRet = await createReturn("2026-09-10", 1, 50);
    expect(draftRet.status).toBe("draft");

    const body = await overview();
    expect(body.purchases.returns).toBe(round2(Number(postedRet.total)));
    expect(body.purchases.returnCount).toBe(1);
    expect(body.purchases.net).toBe(round2(body.purchases.gross - body.purchases.returns));
  });

  test("manual supplier_invoices and supplier payments are not purchases", async () => {
    const before = await overview();
    await ctx.db.run(
      `INSERT INTO supplier_invoices (supplier_id, ref_text, amount_total, amount_paid, due_on, status)
       VALUES (?, 'MANUAL-AP', 999, 0, NULL, 'open')`,
      [supplierId]
    );
    await ctx.db.run(
      `INSERT INTO supplier_payments (supplier_id, amount, paid_on, payment_method)
       VALUES (?, 77, '2026-09-08', 'cash')`,
      [supplierId]
    );
    const after = await overview();
    expect(after.purchases.gross).toBe(before.purchases.gross);
    expect(after.purchases.net).toBe(before.purchases.net);
    expect(after.purchases.invoiceCount).toBe(before.purchases.invoiceCount);
  });

  test("finance purchases equal purchases/summary and the posted-invoice SQL", async () => {
    const [fin, summary] = await Promise.all([
      overview(),
      request(ctx.app)
        .get(`/api/v1/purchases/summary?from=${from}&to=${to}`)
        .set(authHeader(adminToken)),
    ]);
    expect(summary.status).toBe(200);
    const summaryBody = unwrap(summary.body);
    const sql = await canonicalSql();

    expect(fin.purchases).toEqual({
      gross: sql.gross,
      returns: sql.returns,
      net: sql.net,
      invoiceCount: sql.invoiceCount,
      returnCount: sql.returnCount,
    });
    expect(summaryBody.gross).toBe(sql.gross);
    expect(summaryBody.returns).toBe(sql.returns);
    expect(summaryBody.net).toBe(sql.net);
    expect(summaryBody.invoiceCount).toBe(sql.invoiceCount);
    expect(summaryBody.returnCount).toBe(sql.returnCount);
    expect(fin.purchases.gross).toBe(summaryBody.gross);
    expect(fin.purchases.net).toBe(summaryBody.net);
  });
});

describe("GET /finance/overview — refund COGS period and incomplete refunds", () => {
  let ctx;
  let adminToken;
  let cashierId;
  const saleDay = "2026-08-10";
  const refundDay = "2026-08-12";

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    cashierId = cashier.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function overview(from, to) {
    const res = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${from}&to=${to}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("partial refund reverses original snapshot cost on the refund business day, not the sale day", async () => {
    const saleShift = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, start_time)
       VALUES (?, 0, 'closed', ?)`,
      [cashierId, `${saleDay} 10:00:00`]
    );
    const refundShift = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, start_time)
       VALUES (?, 0, 'closed', ?)`,
      [cashierId, `${refundDay} 10:00:00`]
    );
    const sale = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 20, 0, 20, 0, 'cash', ?, 'completed', ?)`,
      [
        cashierId,
        JSON.stringify([{ product_id: ctx.productId, quantity: 2, price: 10 }]),
        saleShift.lastID,
        `${saleDay} 10:15:00`,
      ]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
          unit_cost_at_sale, gross_profit)
       VALUES (?, ?, 'Test Product', 2, 10, 20, 0, 20, 0, 6, 8)`,
      [sale.lastID, ctx.productId]
    );
    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status, approved_at, created_at
       ) VALUES (?, ?, 10, 0, 10, 'cash', 'partial', ?, ?, 'approved', ?, ?)`,
      [
        sale.lastID,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        cashierId,
        refundShift.lastID,
        `${refundDay} 11:00:00`,
        `${refundDay} 11:00:00`,
      ]
    );
    await ctx.db.run("UPDATE products SET cost = 99 WHERE id = ?", [ctx.productId]);

    const saleOnly = await overview(saleDay, saleDay);
    expect(saleOnly.sales.gross).toBe(20);
    expect(saleOnly.sales.refunds).toBe(0);
    expect(saleOnly.profit.cogs).toBe(12);
    expect(saleOnly.profit.cogsKnown).toBe(true);
    expect(saleOnly.profit.grossProfit).toBe(8);

    const refundOnly = await overview(refundDay, refundDay);
    expect(refundOnly.sales.gross).toBe(0);
    expect(refundOnly.sales.refunds).toBe(10);
    expect(refundOnly.profit.cogs).toBe(-6);
    expect(refundOnly.profit.cogsKnown).toBe(true);
    expect(refundOnly.profit.grossProfit).toBe(-4);

    const both = await overview(saleDay, refundDay);
    expect(both.sales.gross).toBe(20);
    expect(both.sales.refunds).toBe(10);
    expect(both.sales.net).toBe(10);
    expect(both.profit.cogs).toBe(6);
    expect(both.profit.grossProfit).toBe(4);
    expect(both.profit.operatingNetProfit).toBe(4);
  });

  test("approved refund with unreadable items_json marks COGS unknown instead of reversing 0", async () => {
    const shift = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, start_time)
       VALUES (?, 0, 'closed', ?)`,
      [cashierId, "2026-08-20 10:00:00"]
    );
    const sale = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'completed', ?)`,
      [
        cashierId,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        shift.lastID,
        "2026-08-20 10:15:00",
      ]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
          unit_cost_at_sale, gross_profit)
       VALUES (?, ?, 'Test Product', 1, 10, 10, 0, 10, 0, 4, 6)`,
      [sale.lastID, ctx.productId]
    );
    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status, created_at
       ) VALUES (?, ?, 10, 0, 10, 'cash', 'bad-json', ?, ?, 'approved', ?)`,
      [sale.lastID, "{", cashierId, shift.lastID, "2026-08-20 12:00:00"]
    );

    const body = await overview("2026-08-20", "2026-08-20");
    expect(body.sales.refunds).toBe(10);
    expect(body.cogs_unknown).toBe(true);
    expect(body.profit.cogs).toBeNull();
    expect(body.profit.grossProfit).toBeNull();
    expect(body.profit.operatingNetProfit).toBeNull();
  });
});
