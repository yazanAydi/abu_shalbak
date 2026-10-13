import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { withTransaction } from "../utils/dbTx.js";

/**
 * Concurrent sales stop at the eligible quantity. A rejected sale writes nothing.
 */
describe("Concurrent sales stop at eligible stock (Scenario F)", () => {
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
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity, price: 10 }],
        payment_method: "cash",
      }));
  }

  async function setStock(quantity) {
    await ctx.db.run("DELETE FROM warehouse_batch_stock WHERE product_id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE products SET stock = ?, location_status = 'located' WHERE id = ?",
      [quantity, ctx.productId]
    );
  }

  test("two simultaneous sales from stock 1 accept one unit and write one movement", async () => {
    await setStock(1);

    const [a, b] = await Promise.all([sell(1), sell(1)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(0);
    const winner = a.status === 201 ? a : b;

    const ledger = await ctx.db.all(
      "SELECT * FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale' AND reference_id = ?",
      [ctx.productId, winner.body.data.transaction_id]
    );
    expect(ledger.length).toBe(1);
    expect(ledger[0].quantity_delta).toBe(-1);
    expect(ledger[0].qty_after).toBe(ledger[0].qty_before + ledger[0].quantity_delta);
  });

  test("selling more than available is rejected and stock stays unchanged", async () => {
    await setStock(1);

    const before = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?",
      [ctx.productId]
    );
    const res = await sell(5);
    expect(res.status).toBe(400);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(1);
    const sales = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?",
      [ctx.productId]
    );
    expect(Number(sales.n)).toBe(Number(before.n));
  });

  test("selling from zero stock is rejected and stock stays at 0", async () => {
    await setStock(0);

    const res = await sell(1);
    expect(res.status).toBe(400);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(0);
  });

  test("each sale creates its own inventory ledger record", async () => {
    await setStock(10);
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
