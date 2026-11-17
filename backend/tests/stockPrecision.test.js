import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import { withTransaction } from "../utils/dbTx.js";
import { applyStockDelta } from "../utils/inventory.js";
import { runZeroAllStock, resetZeroAllStockGuardForTests } from "../services/zeroAllStockService.js";
import { previewStockPrecisionRepair, applyStockPrecisionRepair } from "../services/stockPrecisionRepair.js";

const body = (r) => r.body.data ?? r.body;
describe("stock precision at zero", () => {
  let ctx, admin, token, main;
  let seq = 0;
  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await ctx.db.get("SELECT id, username, role FROM users WHERE username='testadmin'");
    token = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    main = (await ctx.db.get("SELECT id FROM warehouses WHERE type='main'")).id;
  });
  afterAll(async () => { resetZeroAllStockGuardForTests(); await destroyTestContext(ctx); });
  async function product(stock) {
    const row = await ctx.db.run("INSERT INTO products (name,barcode,stock,cost,cost_known,price) VALUES (?, ?, ?, 2, 1, 3)",
      [`precision ${++seq}`, `PREC${seq}`, stock]);
    await ctx.db.run("INSERT INTO inventory_ledger (product_id,movement_type,quantity_delta,qty_before,qty_after) VALUES (?, 'manual_adjustment', ?, 0, ?)", [row.lastID, stock, stock]);
    return row.lastID;
  }
  test("bulk reset cancels raw fractions and existing tiny residues exactly", async () => {
    const ids = [];
    for (const value of [0.1 + 0.2, -1.4210854715202004e-14, 8.881784197001252e-16, -0.000001]) ids.push(await product(value));
    await ctx.db.run("INSERT INTO product_batches (product_id,expiry_date,quantity) VALUES (?, '2027-01-01', ?)", [ids[0], 1e-14]);
    await ctx.db.run("INSERT INTO stock_source_lots (product_id,warehouse_id,expiry_date,quantity,provenance) VALUES (?, ?, '', ?, 'unknown')", [ids[0], main, -1e-14]);
    await runZeroAllStock(ctx.db, { userId: admin.id, req: { user: admin, headers: {} }, idempotencyKey: "precision-reset-1" });
    for (const id of ids) {
      expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [id])).stock).toBe(0);
      expect((await ctx.db.get("SELECT qty_after FROM inventory_ledger WHERE product_id=? ORDER BY id DESC LIMIT 1", [id])).qty_after).toBe(0);
    }
    expect((await ctx.db.get("SELECT quantity FROM product_batches WHERE product_id=?", [ids[0]])).quantity).toBe(0);
    expect((await ctx.db.get("SELECT quantity FROM stock_source_lots WHERE product_id=?", [ids[0]])).quantity).toBe(0);
  });
  test("ordinary depletion cancels binary noise but preserves real fractional shortages", async () => {
    const id = await product(0.1 + 0.2);
    await withTransaction(ctx.db, () => applyStockDelta(ctx.db, id, -0.3, { deferDepletion: true }));
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [id])).stock).toBe(0);
    const row = await ctx.db.get("SELECT * FROM inventory_ledger WHERE product_id=? ORDER BY id DESC LIMIT 1", [id]);
    expect(row.qty_before + row.quantity_delta).toBe(row.qty_after);
    const negativeNoise = await product(0.3);
    await withTransaction(ctx.db, async () => {
      await applyStockDelta(ctx.db, negativeNoise, -0.1, { deferDepletion: true });
      await applyStockDelta(ctx.db, negativeNoise, -0.2, { deferDepletion: true });
    });
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [negativeNoise])).stock).toBe(0);
    for (const remainder of [-0.125, -0.000001, 0.000001]) {
      const pid = await product(1);
      await withTransaction(ctx.db, () => applyStockDelta(ctx.db, pid, remainder - 1, { deferDepletion: true }));
      expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [pid])).stock).toBeCloseTo(remainder, 12);
    }
  });
  test("negative report ignores numerical noise and preview returns normalized zero", async () => {
    const noise = await product(-2.7755575615628914e-17);
    // The sidebar caps its preview at ten rows; keep this fixture ahead of other zeros.
    await ctx.db.run("UPDATE products SET name = '! precision noise' WHERE id = ?", [noise]);
    const real = await product(-0.000001);
    const res = await request(ctx.app).get("/api/v1/inventory/negative-stock").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(body(res).products.some((p) => p.id === noise)).toBe(false);
    expect(body(res).products.some((p) => p.id === real)).toBe(true);
    const preview = await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(token));
    expect(preview.status).toBe(200);
    expect(body(preview).low_stock_preview.find((p) => p.id === noise).stock).toBe(0);
    const report = await request(ctx.app).get("/api/v1/inventory/low-stock").set(authHeader(token));
    expect(report.status).toBe(200);
    expect(body(report).find((p) => p.id === noise).stock).toBe(0);
  });
  test("explicit repair is preview-first, audited, repeat-safe and leaves real counts unchanged", async () => {
    const noise = await product(-1.42e-14);
    const counted = await product(17.125);
    const shortage = await product(-0.000001);
    await ctx.db.run("INSERT INTO warehouse_stock (warehouse_id,product_id,quantity) VALUES (?, ?, ?)", [main, noise, -1e-14]);
    const before = await previewStockPrecisionRepair(ctx.db);
    expect(before.products.some((p) => p.id === noise)).toBe(true);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [noise])).stock).toBe(-1.42e-14);
    await expect(applyStockPrecisionRepair(ctx.db, { actorId: -1, reason: "test" })).rejects.toThrow();
    const result = await applyStockPrecisionRepair(ctx.db, { actorId: admin.id, reason: "تصحيح دقة الصفر" });
    expect(result.changed).toBe(true);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [noise])).stock).toBe(0);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [counted])).stock).toBe(17.125);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [shortage])).stock).toBe(-0.000001);
    expect((await ctx.db.get("SELECT quantity FROM warehouse_stock WHERE product_id=?", [noise])).quantity).toBe(0);
    const correction = await ctx.db.get("SELECT * FROM inventory_ledger WHERE product_id=? ORDER BY id DESC LIMIT 1", [noise]);
    expect(correction.reference_type).toBe("stock_precision_correction");
    expect(correction.qty_after).toBe(0);
    const audit = await ctx.db.get("SELECT * FROM audit_logs WHERE action='STOCK_PRECISION_CORRECTION' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(audit.new_value).reason).toBe("تصحيح دقة الصفر");
    expect((await applyStockPrecisionRepair(ctx.db, { actorId: admin.id, reason: "repeat" })).changed).toBe(false);
  });
  test("failed repair audit rolls the stock and new ledger correction back", async () => {
    const id = await product(1e-14);
    const failing = { ...ctx.db, run: async (sql, args) => {
      if (/INSERT INTO audit_logs/.test(sql)) throw new Error("forced audit failure");
      return ctx.db.run(sql, args);
    } };
    await expect(applyStockPrecisionRepair(failing, { actorId: admin.id, reason: "rollback" })).rejects.toThrow("forced audit failure");
    expect((await ctx.db.get("SELECT stock FROM products WHERE id=?", [id])).stock).toBe(1e-14);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id=? AND reference_type='stock_precision_correction'", [id])).n).toBe(0);
  });
});
