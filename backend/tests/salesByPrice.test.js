import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function checkout(app, token, productId, quantity, price) {
  return request(app)
    .post("/api/v1/checkout")
    .set(authHeader(token))
    .send({
      items: [{ product_id: productId, quantity, price }],
      payment_method: "cash",
    });
}

describe("Sales by price report", () => {
  let ctx;
  let cashierToken;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("same product sold at two different prices appears in two rows", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const priceA = round2(Number(product.price));

    const saleA = await checkout(ctx.app, cashierToken, ctx.productId, 3, priceA);
    expect(saleA.status).toBe(201);

    const priceB = round2(priceA + 2);
    await ctx.db.run("UPDATE products SET price = ? WHERE id = ?", [priceB, ctx.productId]);

    const saleB = await checkout(ctx.app, cashierToken, ctx.productId, 5, priceB);
    expect(saleB.status).toBe(201);

    const res = await request(ctx.app)
      .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const rows = res.body.data?.rows ?? res.body.rows;
    expect(rows).toHaveLength(2);

    const rowA = rows.find((r) => r.unit_price_at_sale === priceA);
    const rowB = rows.find((r) => r.unit_price_at_sale === priceB);
    expect(rowA.sold_quantity).toBe(3);
    expect(rowB.sold_quantity).toBe(5);
    expect(rowA.number_of_transactions).toBe(1);
    expect(rowB.number_of_transactions).toBe(1);
  });

  test("changing current product price does not change old report", async () => {
    const historicalPrices = (
      await ctx.db.all(
        "SELECT DISTINCT unit_price FROM transaction_items WHERE product_id = ? ORDER BY unit_price",
        [ctx.productId]
      )
    ).map((r) => r.unit_price);

    await ctx.db.run("UPDATE products SET price = ? WHERE id = ?", [999.99, ctx.productId]);

    const res = await request(ctx.app)
      .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const rows = res.body.data?.rows ?? res.body.rows;
    const reportPrices = rows.map((r) => r.unit_price_at_sale).sort((a, b) => a - b);
    expect(reportPrices).toEqual(historicalPrices);
    expect(reportPrices).not.toContain(999.99);
  });

  test("refunds reduce net quantity correctly", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const price = round2(Number(product.price));

    const checkoutRes = await checkout(ctx.app, cashierToken, ctx.productId, 4, price);
    expect(checkoutRes.status).toBe(201);
    const transactionId = checkoutRes.body.data.transaction_id;

    const refundReq = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 2 }],
        reason: "sales-by-price test refund",
        payment_method: "cash",
      });
    expect(refundReq.status).toBe(201);

    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${refundReq.body.data.request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);

    const res = await request(ctx.app)
      .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken))
      .query({ include_refunds: "true" });

    expect(res.status).toBe(200);
    const rows = res.body.data?.rows ?? res.body.rows;
    const row = rows.find((r) => r.unit_price_at_sale === price);
    expect(row).toBeTruthy();
    expect(row.refunded_quantity).toBeGreaterThanOrEqual(2);
    expect(row.net_quantity_sold).toBe(round2(row.sold_quantity - row.refunded_quantity));
  });

  test("date filter limits rows to sales in range", async () => {
    const txRows = await ctx.db.all(
      `SELECT t.id, t.created_at
       FROM transactions t
       JOIN transaction_items ti ON ti.transaction_id = t.id
       WHERE ti.product_id = ?
       ORDER BY t.created_at ASC
       LIMIT 1`,
      [ctx.productId]
    );
    expect(txRows.length).toBeGreaterThan(0);

    const saleDate = String(txRows[0].created_at).slice(0, 10);

    const resIn = await request(ctx.app)
      .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken))
      .query({ date_from: saleDate, date_to: saleDate });

    expect(resIn.status).toBe(200);
    const rowsIn = resIn.body.data?.rows ?? res.body.rows;
    expect(rowsIn.length).toBeGreaterThan(0);
    for (const row of rowsIn) {
      expect(String(row.first_sale_date).slice(0, 10)).toBe(saleDate);
    }

    const resOut = await request(ctx.app)
      .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken))
      .query({ date_from: "2099-01-01", date_to: "2099-01-31" });

    expect(resOut.status).toBe(200);
    const rowsOut = resOut.body.data?.rows ?? resOut.body.rows;
    expect(rowsOut).toHaveLength(0);
  });

  test("checkout stores cost and profit snapshots on transaction_items", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await checkout(ctx.app, cashierToken, ctx.productId, 1, product.price);
    expect(checkoutRes.status).toBe(201);

    const item = await ctx.db.get(
      "SELECT * FROM transaction_items WHERE transaction_id = ? AND product_id = ?",
      [checkoutRes.body.data.transaction_id, ctx.productId]
    );
    expect(item.unit_cost_at_sale).toBe(Number(product.cost));
    expect(item.gross_profit).not.toBeNull();
    expect(item.discount_at_sale).toBe(0);
  });
});
