import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Inventory stock update", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = loginRes.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("manual adjustment creates ledger entry", async () => {
    const before = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);

    const res = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "in",
        items: [{ product_id: ctx.productId, quantity: 5 }],
        post: true,
      });

    expect(res.status).toBe(201);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(after.stock).toBe(before.stock + 5);

    const ledger = await ctx.db.get(
      "SELECT * FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [ctx.productId]
    );
    expect(ledger).toBeTruthy();
    expect(ledger.quantity_delta).toBe(5);
  });
});
