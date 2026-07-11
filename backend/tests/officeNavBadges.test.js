import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function unwrapData(body) {
  return body?.data ?? body;
}

describe("office nav badges", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let transactionId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;

    await ctx.db.run(
      `UPDATE products SET stock = 2, inventory_scope = 'retail' WHERE id = ?`,
      [ctx.productId]
    );

    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, inventory_scope)
       VALUES ('9900001', 'Bakery Flour', 0, 1, 1, 'bakery')`
    );

    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, inventory_scope)
       VALUES ('9900002', 'Oversold Item', 5, 2, -3, 'retail')`
    );

    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});

    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    transactionId = checkoutRes.body.data?.transaction_id ?? checkoutRes.body.transaction_id;

    await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "badge test",
        payment_method: "cash",
      });

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, expected_cash, status)
       VALUES (?, datetime('now', '-2 hours'), datetime('now', '-1 hour'), 0, 0, 'pending_count')`,
      [cashier.id]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("returns scoped stock and actionable counts", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/office/nav-badges")
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const data = unwrapData(res.body);

    expect(data.retail_low_stock).toBeGreaterThanOrEqual(1);
    expect(data.bakery_low_stock).toBeGreaterThanOrEqual(1);
    expect(data.negative_stock).toBeGreaterThanOrEqual(1);
    expect(data.pending_refunds).toBeGreaterThanOrEqual(1);
    expect(data.pending_shift_count).toBeGreaterThanOrEqual(1);

    expect(data.by_path["/bakery-supplies"]).toBe(data.bakery_low_stock);
    expect(data.by_path["/inventory"]).toBe(data.negative_stock);
    expect(data.by_path["/refund-approvals"]).toBe(data.pending_refunds);
    expect(data.by_path["/shift-audit"]).toBe(data.pending_shift_count);
    expect(data.by_path["/expiry"]).toBe(data.expiry_page_alerts);
    expect(data.expiry_page_alerts).toBeGreaterThanOrEqual(data.near_expiry);
    expect(data.expiry_page_alerts).toBeLessThanOrEqual(
      data.retail_low_stock + data.near_expiry
    );

    const expectedTotal =
      data.by_path["/expiry"] +
      data.by_path["/bakery-supplies"] +
      data.by_path["/inventory"] +
      data.by_path["/refund-approvals"] +
      data.by_path["/shift-audit"];
    expect(data.total).toBe(expectedTotal);
  });

  test("reports low-stock excludes bakery scope", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/reports/low-stock?threshold=5")
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const data = unwrapData(res.body);
    const products = data.products ?? [];
    expect(products.every((p) => p.name !== "Bakery Flour")).toBe(true);
  });

  test("rejects unauthenticated requests", async () => {
    const res = await request(ctx.app).get("/api/v1/office/nav-badges");
    expect(res.status).toBe(401);
  });
});
