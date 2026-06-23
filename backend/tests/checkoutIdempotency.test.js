import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

/**
 * Stage 3 — server-side checkout idempotency (Scenario G).
 * A client-supplied idempotency_key dedupes retries and double submissions so
 * a single intended sale is never recorded twice.
 */
describe("Checkout idempotency (Scenario G)", () => {
  let ctx;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    await ctx.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function sale(key) {
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "cash",
    };
    if (key) body.idempotency_key = key;
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(body);
  }

  async function txCountForKey(key) {
    const row = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE idempotency_key = ?",
      [key]
    );
    return row.c;
  }

  test("duplicate sequential requests create exactly one sale and replay the original", async () => {
    const key = "seq-key-0000000001";
    const first = await sale(key);
    expect(first.status).toBe(201);
    const firstTxId = first.body.data.transaction_id;

    const second = await sale(key);
    expect(second.status).toBe(200);
    expect(second.body.data.idempotent_replay).toBe(true);
    expect(second.body.data.transaction_id).toBe(firstTxId);

    expect(await txCountForKey(key)).toBe(1);
  });

  test("duplicate concurrent requests create exactly one sale", async () => {
    const key = "conc-key-000000002";
    const [a, b] = await Promise.all([sale(key), sale(key)]);

    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    expect(a.body.data.transaction_id).toBe(b.body.data.transaction_id);

    expect(await txCountForKey(key)).toBe(1);
  });

  test("two different keys create two distinct sales", async () => {
    const r1 = await sale("diff-key-aaaaaaaa1");
    const r2 = await sale("diff-key-bbbbbbbb2");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.transaction_id).not.toBe(r2.body.data.transaction_id);
  });

  test("requests without a key still succeed (backward compatible)", async () => {
    const r1 = await sale(null);
    const r2 = await sale(null);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.transaction_id).not.toBe(r2.body.data.transaction_id);
  });
});
