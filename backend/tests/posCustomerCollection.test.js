import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

describe("retired POS customer collection route", () => {
  let ctx;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("the mistaken cash-collection endpoint is no longer posted from POS", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/pos/customer-collections")
      .set(authHeader(cashierToken))
      .send({ customer_id: 1, amount: 10, idempotency_key: "retired-collection-key" });
    expect(res.status).toBe(404);
  });
});
