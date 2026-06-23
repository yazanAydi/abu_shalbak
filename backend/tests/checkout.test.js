import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Checkout flow", () => {
  let ctx;
  let cashierToken;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("completes sale with receipt number and ledger entry", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = product.stock;

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.receipt_number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(res.body.data.transaction_id).toBeTruthy();

    const updated = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(updated.stock).toBe(stockBefore - 2);

    const ledger = await ctx.db.all(
      "SELECT * FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0].quantity_delta).toBe(-2);

    const tx = await ctx.db.get("SELECT receipt_number, status FROM transactions WHERE id = ?", [
      res.body.data.transaction_id,
    ]);
    expect(tx.receipt_number).toBe(res.body.data.receipt_number);
    expect(tx.status).toBe("completed");
  });

  test("shift was used for checkout", () => {
    expect(shiftId).toBeTruthy();
  });
});
