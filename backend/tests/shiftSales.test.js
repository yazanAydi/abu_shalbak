import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("shift current sales for refund picker", () => {
  let ctx;
  let cashierToken;
  let shiftId;
  let product;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken));
    shiftId = shiftRes.body.data?.shift_id ?? shiftRes.body.shift_id;

    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("no open shift returns empty sales list", async () => {
    const otherCtx = await createTestContext();
    const otherLogin = await login(otherCtx.app, "testcashier", "cashpass123", "pos");
    const res = await request(otherCtx.app)
      .get("/api/v1/shifts/current/sales")
      .set(authHeader(otherLogin.body.token));
    expect(res.status).toBe(200);
    const emptyPayload = res.body.data ?? res.body;
    expect(emptyPayload.shift_id).toBeNull();
    expect(emptyPayload.sales).toEqual([]);
    await destroyTestContext(otherCtx);
  });

  test("returns sales newest-first with item preview", async () => {
    const sale1 = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    expect(sale1.status).toBe(201);
    const tx1 = sale1.body.data?.transaction_id ?? sale1.body.transaction_id;

    const sale2 = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "visa",
      });
    expect(sale2.status).toBe(201);
    const tx2 = sale2.body.data?.transaction_id ?? sale2.body.transaction_id;

    const res = await request(ctx.app)
      .get("/api/v1/shifts/current/sales")
      .set(authHeader(cashierToken));

    expect(res.status).toBe(200);
    const payload = res.body.data ?? res.body;
    expect(payload.shift_id).toBe(shiftId);
    expect(payload.sales.length).toBeGreaterThanOrEqual(2);

    const ids = payload.sales.map((s) => s.transaction_id);
    expect(ids.indexOf(tx2)).toBeLessThan(ids.indexOf(tx1));

    const latest = payload.sales.find((s) => s.transaction_id === tx2);
    expect(latest.item_count).toBe(2);
    expect(latest.items_preview).toContain("Test Product");
    expect(latest.returnable).toBe(true);
    expect(latest.fully_refunded).toBe(false);
  });

  test("fully refunded sale is not returnable", async () => {
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    const txId = sale.body.data?.transaction_id ?? sale.body.transaction_id;

    await ctx.db.run(
      `INSERT INTO refunds (
        original_transaction_id, items_json, subtotal, tax, total,
        payment_method, reason, cashier_id, shift_id, status, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'))`,
      [
        txId,
        JSON.stringify([
          { product_id: ctx.productId, name: product.name, quantity: 1, price: product.price },
        ]),
        product.price,
        0,
        product.price,
        "cash",
        "test",
        (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id,
        shiftId,
      ]
    );

    const res = await request(ctx.app)
      .get("/api/v1/shifts/current/sales")
      .set(authHeader(cashierToken));

    const payload = res.body.data ?? res.body;
    const row = payload.sales.find((s) => s.transaction_id === txId);
    expect(row).toBeTruthy();
    expect(row.fully_refunded).toBe(true);
    expect(row.returnable).toBe(false);
  });
});
