import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";

describe("silent receipt print", () => {
  let ctx;
  let cashierToken;
  let transactionId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 50 });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    transactionId = sale.body.data.transaction_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("rejects missing transaction_id", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown sale", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: 999999 });
    expect(res.status).toBe(404);
  });

  test("dry-runs print in test env", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(200);
    expect(res.body.data?.printed ?? res.body.printed).toBe(true);
    expect(res.body.data?.dry_run ?? res.body.dry_run).toBe(true);
  });
});
