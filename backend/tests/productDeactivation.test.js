import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

/** Stage 7 — product deactivation (Scenario H). */
describe("Product deactivation (Scenario H)", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;
    await ctx.db.run("UPDATE products SET stock = 50, price = 10, is_active = 1 WHERE id = ?", [
      ctx.productId,
    ]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function checkout() {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
      });
  }

  test("admin can deactivate a product", async () => {
    const res = await request(ctx.app)
      .patch(`/api/v1/products/${ctx.productId}/active`)
      .set(authHeader(adminToken))
      .send({ is_active: 0 });
    expect(res.status).toBe(200);
    expect(Number(res.body.data?.is_active ?? res.body.is_active)).toBe(0);
  });

  test("POS barcode lookup hides inactive product", async () => {
    const product = await ctx.db.get("SELECT barcode FROM products WHERE id = ?", [ctx.productId]);
    const res = await request(ctx.app)
      .get(`/api/v1/products/${encodeURIComponent(product.barcode)}`)
      .set(authHeader(cashierToken));
    expect(res.status).toBe(404);
  });

  test("checkout rejects inactive product with 409 PRODUCT_INACTIVE", async () => {
    const res = await checkout();
    expect(res.status).toBe(409);
    expect(res.body.data?.code || res.body.code).toBe("PRODUCT_INACTIVE");
  });

  test("reactivated product can be sold again", async () => {
    await request(ctx.app)
      .patch(`/api/v1/products/${ctx.productId}/active`)
      .set(authHeader(adminToken))
      .send({ is_active: 1 });

    const res = await checkout();
    expect(res.status).toBe(201);
    expect(shiftId).toBeTruthy();
  });
});
