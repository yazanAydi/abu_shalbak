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

describe("Zero all product stock", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("admin zeros all non-zero stock and writes ledger; already-zero products are skipped", async () => {
    const negativeIns = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990002', 'Negative Stock Product', 4, 2, 'Test', -7)`
    );
    const zeroIns = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990003', 'Zero Stock Product', 3, 1, 'Test', 0)`
    );
    const negativeId = negativeIns.lastID;
    const zeroId = zeroIns.lastID;

    const beforeCounts = await ctx.db.get(
      `SELECT
         SUM(CASE WHEN COALESCE(stock, 0) != 0 THEN 1 ELSE 0 END) AS non_zero,
         SUM(CASE WHEN COALESCE(stock, 0) = 0 THEN 1 ELSE 0 END) AS already_zero
       FROM products`
    );
    const beforeZeroLedger = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [zeroId]
    );

    const res = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const body = res.body?.data ?? res.body;
    expect(body.products_zeroed).toBe(Number(beforeCounts.non_zero));
    expect(body.skipped).toBe(Number(beforeCounts.already_zero));

    const positive = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    const negative = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [negativeId]);
    const alreadyZero = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [zeroId]);
    expect(positive.stock).toBe(0);
    expect(negative.stock).toBe(0);
    expect(alreadyZero.stock).toBe(0);

    const remaining = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM products WHERE COALESCE(stock, 0) != 0"
    );
    expect(remaining.n).toBe(0);

    const positiveLedger = await ctx.db.get(
      "SELECT * FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [ctx.productId]
    );
    expect(positiveLedger).toBeTruthy();
    expect(positiveLedger.quantity_delta).toBe(-100);
    expect(positiveLedger.movement_type).toBe("stock_count_correction");
    expect(positiveLedger.reference_type).toBe("zero_all_stock");
    expect(positiveLedger.qty_after).toBe(0);

    const negativeLedger = await ctx.db.get(
      "SELECT * FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [negativeId]
    );
    expect(negativeLedger).toBeTruthy();
    expect(negativeLedger.quantity_delta).toBe(7);
    expect(negativeLedger.movement_type).toBe("stock_count_correction");
    expect(negativeLedger.qty_after).toBe(0);

    const afterZeroLedger = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [zeroId]
    );
    expect(afterZeroLedger.n).toBe(beforeZeroLedger.n);
  });

  test("stock-count post uses live stock so a sale between count and post is not double-applied", async () => {
    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [ctx.productId]);
    const create = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ notes: "live-stock post" });
    expect(create.status).toBe(201);
    const sessionId = (create.body.data ?? create.body).id;

    const lineRes = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: ctx.productId, counted_qty: 8 });
    expect(lineRes.status).toBe(200);

    await ctx.db.run("UPDATE products SET stock = 9 WHERE id = ?", [ctx.productId]);

    const postRes = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken));
    expect(postRes.status).toBe(200);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(Number(after.stock)).toBe(8);

    const postedLine = await ctx.db.get(
      "SELECT system_qty, counted_qty, variance FROM stock_count_lines WHERE session_id = ? AND product_id = ?",
      [sessionId, ctx.productId]
    );
    expect(Number(postedLine.system_qty)).toBe(9);
    expect(Number(postedLine.counted_qty)).toBe(8);
    expect(Number(postedLine.variance)).toBe(-1);
  });

  test("cashier cannot zero all stock", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(cashierToken));

    expect([401, 403]).toContain(res.status);
  });
});
