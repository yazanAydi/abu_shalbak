import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { deriveStockFromLedger } from "../utils/inventoryLedger.js";

/**
 * Batch 2 — data integrity.
 * Stage 4 (Scenario I): reports reconcile from source tables; daily_reports is
 *   never written and is not authoritative.
 * Stage 8: a single sale produces exactly one stock delta (ledger = source of
 *   truth; inventory_movements is a secondary log).
 * Stage 9: schema version is recorded.
 */
describe("Reporting reconciliation and inventory source of truth", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    await ctx.db.run("UPDATE products SET stock = 100, price = 10, tax_rate = 0 WHERE id = ?", [
      ctx.productId,
    ]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function sell(quantity) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity, price: 10 }],
        payment_method: "cash",
      });
  }

  test("Scenario I: dashboard/today + last-7-days reconcile with raw source-table sums", async () => {
    await sell(2);
    await sell(3);
    await sell(1);

    const sums = await ctx.db.get(
      `SELECT COALESCE(SUM(total), 0) AS sales FROM transactions
       WHERE date(created_at) = ? AND COALESCE(status,'completed') = 'completed'`,
      [today]
    );
    const refSums = await ctx.db.get(
      `SELECT COALESCE(SUM(total), 0) AS refunds FROM refunds WHERE date(created_at) = ?`,
      [today]
    );
    const expectedNet = Math.round((sums.sales - refSums.refunds) * 100) / 100;

    const todayRes = await request(ctx.app)
      .get("/api/v1/reports/today")
      .set(authHeader(adminToken));
    expect(todayRes.status).toBe(200);
    const todayData = todayRes.body.data || todayRes.body;
    expect(todayData.net_sales).toBe(expectedNet);

    const weekRes = await request(ctx.app)
      .get("/api/v1/reports/last-7-days")
      .set(authHeader(adminToken));
    const weekDays = (weekRes.body.data || weekRes.body).days;
    const todayRow = weekDays.find((d) => d.date === today);
    expect(todayRow.total_sales).toBe(Math.round(sums.sales * 100) / 100);
  });

  test("daily_reports is never written (non-authoritative)", async () => {
    const row = await ctx.db.get("SELECT COUNT(*) AS c FROM daily_reports");
    expect(row.c).toBe(0);
  });

  test("Stage 8: a single sale produces exactly one stock delta", async () => {
    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [ctx.productId]);
    const res = await sell(3);
    const txId = res.body.data.transaction_id;

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(7); // decremented once, not twice

    const ledger = await ctx.db.all(
      "SELECT * FROM inventory_ledger WHERE reference_id = ? AND movement_type = 'sale'",
      [txId]
    );
    expect(ledger.length).toBe(1);
    expect(ledger[0].quantity_delta).toBe(-3);

    const movements = await ctx.db.all(
      "SELECT * FROM inventory_movements WHERE ref_id = ? AND movement_type = 'sale'",
      [txId]
    );
    expect(movements.length).toBe(1);
    expect(movements[0].quantity).toBe(-3);
  });

  test("Stage 8: ledger is authoritative — derived stock matches cache when only the ledger mutates stock", async () => {
    // Fresh product whose stock is ONLY ever changed through the ledger.
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('LEDGER01', 'Ledger Item', 5, 2, 'Test', 0)`
    );
    const pid = ins.lastID;
    await ctx.db.run("UPDATE products SET stock = 20 WHERE id = ? AND 0 = 1", [pid]); // no-op, keep stock from ledger only

    const { applyStockDelta } = await import("../utils/inventory.js");
    await applyStockDelta(ctx.db, pid, 20, { movementType: "opening" });
    await applyStockDelta(ctx.db, pid, -7, { movementType: "sale" });

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [pid]);
    const derived = await deriveStockFromLedger(ctx.db, pid);
    expect(product.stock).toBe(13);
    expect(derived).toBe(product.stock);
  });

  test("Stage 9: schema version is recorded", async () => {
    const row = await ctx.db.get("SELECT COUNT(*) AS c FROM schema_migrations");
    expect(row.c).toBeGreaterThan(0);
  });
});
