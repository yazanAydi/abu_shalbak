import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { withTransaction } from "../utils/dbTx.js";

/**
 * Stage 1 — concurrency-safe stock with clamp-at-zero.
 * Overselling is allowed (sale completes) but stock never drops below zero.
 */
describe("Concurrent sales with stock clamped at zero (Scenario F)", () => {
  let ctx;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function sell(quantity) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity, price: 10 }],
        payment_method: "cash",
      });
  }

  test("two simultaneous sales from stock 1 both succeed, final stock is 0, no lost update", async () => {
    await ctx.db.run("UPDATE products SET stock = 1 WHERE id = ?", [ctx.productId]);

    const [a, b] = await Promise.all([sell(1), sell(1)]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(0);

    const ledger = await ctx.db.all(
      "SELECT * FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale' AND reference_id IN (?, ?)",
      [ctx.productId, a.body.data.transaction_id, b.body.data.transaction_id]
    );
    expect(ledger.length).toBe(2);
    const deltas = ledger.map((r) => r.quantity_delta).sort((x, y) => y - x);
    expect(deltas).toEqual([0, -1]);
    for (const row of ledger) {
      expect(row.qty_after).toBe(Math.max(0, row.qty_before + row.quantity_delta));
    }
  });

  test("selling more than available succeeds and clamps stock at zero", async () => {
    await ctx.db.run("UPDATE products SET stock = 1 WHERE id = ?", [ctx.productId]);

    const res = await sell(5);
    expect(res.status).toBe(201);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(0);

    const ledger = await ctx.db.get(
      "SELECT * FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale' AND reference_id = ?",
      [ctx.productId, res.body.data.transaction_id]
    );
    expect(ledger.quantity_delta).toBe(-1);
    expect(ledger.qty_before).toBe(1);
    expect(ledger.qty_after).toBe(0);
  });

  test("selling from zero stock succeeds and keeps stock at zero", async () => {
    await ctx.db.run("UPDATE products SET stock = 0 WHERE id = ?", [ctx.productId]);

    const res = await sell(1);
    expect(res.status).toBe(201);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(0);
  });

  test("each sale creates its own inventory ledger record", async () => {
    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [ctx.productId]);
    const before = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );
    await sell(1);
    await sell(1);
    const after = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );
    expect(after.c - before.c).toBe(2);
  });

  test("withTransaction rolls back stock + ledger if the transaction throws", async () => {
    await ctx.db.run("UPDATE products SET stock = 7 WHERE id = ?", [ctx.productId]);
    const ledgerBefore = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ?",
      [ctx.productId]
    );

    await expect(
      withTransaction(ctx.db, async () => {
        await ctx.db.run("UPDATE products SET stock = stock - 3 WHERE id = ?", [ctx.productId]);
        await ctx.db.run(
          `INSERT INTO inventory_ledger (product_id, movement_type, quantity_delta, qty_before, qty_after)
           VALUES (?, 'sale', -3, 7, 4)`,
          [ctx.productId]
        );
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(7); // restored
    const ledgerAfter = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ?",
      [ctx.productId]
    );
    expect(ledgerAfter.c).toBe(ledgerBefore.c); // no orphan ledger row
  });
});
