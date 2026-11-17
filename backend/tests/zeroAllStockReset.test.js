/**
 * Company-wide stock reset: accounting, atomicity, and the bounded cost of
 * the old per-product valuation rebuild. Uses a disposable test database.
 */
import request from "supertest";
import { upsertProductUnit } from "../utils/productUnits.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { round2 } from "../utils/money.js";
import {
  buildHistoricalWarehouseValuation,
  explainPositiveDepletionGap,
  resetValuationAccountingStats,
  valuationAccountingStats,
} from "../utils/warehouseValuationHistory.js";
import { diagnoseZeroAllStock, resetZeroAllStockGuardForTests, runZeroAllStock } from "../services/zeroAllStockService.js";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
  waitForZeroAllStock,
  withCheckoutKey,
} from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

function fakeReq(user) {
  return {
    user,
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  };
}

describe("zero all stock reset", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let mainId;
  let returnsId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket\.db/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    supplierId = (await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد تصفير', 'Z-1', 0, 0)"
    )).lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    const warehouses = await ctx.db.all("SELECT id, type FROM warehouses WHERE active = 1");
    mainId = warehouses.find((row) => row.type === "main").id;
    returnsId = warehouses.find((row) => row.type === "returns").id;
    const shift = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(shift.status).toBe(201);
  });

  afterAll(async () => {
    resetZeroAllStockGuardForTests();
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, { stock = 0, cost = 2, costKnown = 1 } = {}) {
    seq += 1;
    const barcode = `79${String(seq).padStart(8, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, cost_known, category, stock, inventory_scope)
       VALUES (?, ?, 10, ?, ?, 'عام', ?, 'retail')`,
      [barcode, name, cost, costKnown, stock]
    );
    const unit = await upsertProductUnit(ctx.db, ins.lastID, {
      unit_name: "حبة",
      barcode,
      price: 10,
      cost,
      conversion_to_base: 1,
      is_default: true,
    });
    return { id: ins.lastID, unitId: unit.id, barcode };
  }

  async function postPurchase(product, { qty, total, expiry = null }) {
    const item = {
      product_id: product.id,
      unit_id: product.unitId,
      quantity: qty,
      total_cost: total,
    };
    if (expiry) item.expiry_date = expiry;
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, invoice_date: shopTodayYmd(), items: [item] });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
  }

  test("clears mixed stock once, keeps snapshots, and does not rebuild company valuation", async () => {
    const day = shopTodayYmd();
    const depletion = await makeProduct("نفاد");
    await postPurchase(depletion, { qty: 3, total: 10, expiry: "2027-04-01" });
    const soldOut = await makeProduct("بيع حتى الصفر");
    await postPurchase(soldOut, { qty: 3, total: 10, expiry: "2027-05-01" });
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: soldOut.id, quantity: 3, price: 10, unit_id: soldOut.unitId }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    const soldCost = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [soldOut.id]
    );
    const soldAdjustment = await ctx.db.get(
      `SELECT id, value_adjustment FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'sale' ORDER BY id DESC LIMIT 1`,
      [soldOut.id]
    );
    expect(Number(soldAdjustment.value_adjustment)).toBeCloseTo(-0.01, 2);

    const partial = await makeProduct("بيع جزئي");
    await postPurchase(partial, { qty: 5, total: 20, expiry: "2027-06-01" });
    const partialSale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: partial.id, quantity: 1, price: 10, unit_id: partial.unitId }],
        payment_method: "cash",
      }));
    expect(partialSale.status).toBe(201);
    const partialCost = await ctx.db.get(
      "SELECT id, unit_cost_at_sale FROM transaction_items WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [partial.id]
    );
    const partialLedgerBefore = await ctx.db.all(
      "SELECT id, value_adjustment, quantity_delta, movement_type FROM inventory_ledger WHERE product_id = ? ORDER BY id",
      [partial.id]
    );

    const unknown = await makeProduct("تكلفة مجهولة", { stock: 4, cost: 0, costKnown: 0 });
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day, cost_known, store_id)
       VALUES (?, 'manual_adjustment', 4, 0, 4, ?, 0, 1)`,
      [unknown.id, day]
    );
    const negative = await makeProduct("سالب", { stock: -5, cost: 2, costKnown: 1 });
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
          unit_cost_after, cost_known, store_id)
       VALUES (?, 'manual_adjustment', -5, 0, -5, ?, 2, 1, 1)`,
      [negative.id, day]
    );
    const already = await makeProduct("صفر أصلاً", { stock: 0, cost: 1, costKnown: 1 });
    const offset = await makeProduct("تعويض", { stock: 0, cost: 1, costKnown: 1 });
    await ctx.db.run(
      `INSERT INTO stock_source_lots (product_id, warehouse_id, expiry_date, quantity, provenance)
       VALUES (?, ?, '', 4, 'unknown'), (?, ?, '', -4, 'unknown')`,
      [offset.id, mainId, offset.id, returnsId]
    );
    const undated = await makeProduct("بدون دفعات مصدر", { stock: 7, cost: 3, costKnown: 1 });
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
          unit_cost_after, cost_known, store_id)
       VALUES (?, 'manual_adjustment', 7, 0, 7, ?, 3, 1, 1)`,
      [undated.id, day]
    );
    await ctx.db.run(
      `INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, '2027-07-01', 5)`,
      [undated.id]
    );
    const placed = await makeProduct("مستودعان", { stock: 6, cost: 4, costKnown: 1 });
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
          unit_cost_after, cost_known, store_id)
       VALUES (?, 'manual_adjustment', 6, 0, 6, ?, 4, 1, 1)`,
      [placed.id, day]
    );
    await ctx.db.run(
      `INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, '2027-08-01', 6)`,
      [placed.id]
    );
    await ctx.db.run(
      `INSERT INTO stock_source_lots
         (product_id, warehouse_id, expiry_date, quantity, provenance)
       VALUES (?, ?, '2027-08-01', 4, 'unknown'), (?, ?, '2027-08-01', 2, 'unknown')`,
      [placed.id, mainId, placed.id, returnsId]
    );
    await ctx.db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, '2027-08-01', 4), (?, ?, '2027-08-01', 2)`,
      [mainId, placed.id, returnsId, placed.id]
    );
    await ctx.db.run(
      `INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, 4), (?, ?, 2)`,
      [mainId, placed.id, returnsId, placed.id]
    );
    const reconciled = await makeProduct("يحتاج مطابقة", { stock: 3, cost: 1, costKnown: 1 });
    await ctx.db.run(
      "UPDATE products SET location_status = 'needs_reconciliation' WHERE id = ?",
      [reconciled.id]
    );
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
          unit_cost_after, cost_known, store_id)
       VALUES (?, 'manual_adjustment', 3, 0, 3, ?, 1, 1, 1)`,
      [reconciled.id, day]
    );
    await ctx.db.run(
      "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, 9)",
      [mainId, reconciled.id]
    );

    const cycle = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(adminToken))
      .send({ scope: "retail", confirm: true, reason: "إيقاف التقرير للاختبار" });
    expect(cycle.status).toBe(201);
    const cycleBefore = unwrap(cycle.body);
    const exclusionsBefore = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM expiry_report_exclusions WHERE cycle_id = ?",
      [cycleBefore.cycle_id]
    );
    const verificationsBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM expiry_report_verifications");

    const alreadyLedger = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [already.id]
    );
    resetValuationAccountingStats();
    const zeroed = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .send({});
    expect(zeroed.status).toBe(200);
    const body = await waitForZeroAllStock(ctx.app, adminToken, zeroed);
    expect(body.status).toBe("completed");
    expect(body.percent).toBe(100);
    expect(body.products_zeroed).toBeGreaterThan(0);
    expect(body.products_changed).toBe(body.products_zeroed);
    expect(body.processed).toBe(body.total);
    expect(valuationAccountingStats().historicalBuilds).toBe(0);
    expect(valuationAccountingStats().depletionPasses).toBe(1);

    const stocks = await ctx.db.get("SELECT COUNT(*) AS n FROM products WHERE ABS(COALESCE(stock, 0)) > 1e-9");
    expect(Number(stocks.n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_source_lots WHERE ABS(quantity) > 1e-9"
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM product_batches WHERE ABS(quantity) > 1e-9"
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE ABS(quantity) > 1e-9"
    )).n)).toBe(0);

    const depletionRow = await ctx.db.get(
      `SELECT quantity_delta, qty_after, value_adjustment, movement_type, reference_type
         FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'zero_all_stock'`,
      [depletion.id]
    );
    expect(depletionRow.movement_type).toBe("stock_count_correction");
    expect(Number(depletionRow.quantity_delta)).toBeCloseTo(-3, 3);
    expect(Number(depletionRow.qty_after)).toBeCloseTo(0, 3);
    expect(Number(depletionRow.value_adjustment)).toBeCloseTo(-0.01, 2);
    const purchaseCost = await ctx.db.get(
      "SELECT unit_cost_after, value_adjustment FROM inventory_ledger WHERE product_id = ? AND movement_type = 'purchase_receive'",
      [depletion.id]
    );
    expect(purchaseCost.value_adjustment).toBeNull();

    await ctx.db.run(
      "UPDATE inventory_ledger SET value_adjustment = NULL WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [depletion.id]
    );
    resetValuationAccountingStats();
    const scoped = await explainPositiveDepletionGap(ctx.db, depletion.id);
    const report = await buildHistoricalWarehouseValuation(ctx.db, {}, "9999-12-31", "9999-12-31");
    const fromReport = (report.unexplained_rounding || []).find((row) => Number(row.product_id) === depletion.id);
    expect(scoped).toBeCloseTo(0.01, 2);
    expect(fromReport.amount).toBeCloseTo(scoped, 2);
    expect(valuationAccountingStats().historicalBuilds).toBe(1);
    await ctx.db.run(
      `UPDATE inventory_ledger SET value_adjustment = ? WHERE product_id = ? AND reference_type = 'zero_all_stock'`,
      [round2(-scoped), depletion.id]
    );

    const unknownRow = await ctx.db.get(
      `SELECT value_adjustment, quantity_delta FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'zero_all_stock'`,
      [unknown.id]
    );
    expect(Number(unknownRow.quantity_delta)).toBeCloseTo(-4, 3);
    expect(unknownRow.value_adjustment).toBeNull();

    const negativeRow = await ctx.db.get(
      `SELECT quantity_delta, qty_after FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'zero_all_stock'`,
      [negative.id]
    );
    expect(Number(negativeRow.quantity_delta)).toBeCloseTo(5, 3);
    expect(Number(negativeRow.qty_after)).toBeCloseTo(0, 3);
    const negativeOpening = await ctx.db.get(
      `SELECT value_adjustment, quantity_delta FROM inventory_ledger
        WHERE product_id = ? AND reference_type IS NULL`,
      [negative.id]
    );
    expect(Number(negativeOpening.quantity_delta)).toBeCloseTo(-5, 3);
    expect(negativeOpening.value_adjustment).toBeNull();

    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [already.id]
    )).n)).toBe(Number(alreadyLedger.n));
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [offset.id]
    )).n)).toBe(0);
    const offsetAlloc = await ctx.db.all(
      `SELECT quantity, direction, warehouse_id FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'zero_all_stock' ORDER BY direction, warehouse_id`,
      [offset.id]
    );
    expect(offsetAlloc.map((row) => [Number(row.quantity), row.direction])).toEqual([
      [4, "in"],
      [4, "out"],
    ]);

    const undatedAlloc = await ctx.db.all(
      `SELECT expiry_date, quantity, direction FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'zero_all_stock' ORDER BY expiry_date`,
      [undated.id]
    );
    expect(undatedAlloc.map((row) => [row.expiry_date, Number(row.quantity), row.direction])).toEqual([
      [null, 2, "out"],
      ["2027-07-01", 5, "out"],
    ]);
    expect(Number((await ctx.db.get(
      "SELECT quantity_delta FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [undated.id]
    )).quantity_delta)).toBeCloseTo(-7, 3);

    expect(Number((await ctx.db.get(
      "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_source_lots WHERE product_id = ?",
      [placed.id]
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE product_id = ?",
      [placed.id]
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_stock WHERE product_id = ?",
      [placed.id]
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT quantity FROM warehouse_stock WHERE product_id = ?",
      [reconciled.id]
    )).quantity)).toBe(9);

    expect(Number((await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE id = ?",
      [partialCost.id]
    )).unit_cost_at_sale)).toBe(Number(partialCost.unit_cost_at_sale));
    const partialAfter = await ctx.db.all(
      "SELECT id, value_adjustment, quantity_delta FROM inventory_ledger WHERE product_id = ? AND reference_type IS NULL OR (product_id = ? AND reference_type != 'zero_all_stock') ORDER BY id",
      [partial.id, partial.id]
    );
    expect(partialAfter.map((row) => [row.id, row.value_adjustment, row.quantity_delta])).toEqual(
      partialLedgerBefore.map((row) => [row.id, row.value_adjustment, row.quantity_delta])
    );
    expect(Number((await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ?",
      [soldOut.id]
    )).unit_cost_at_sale)).toBe(Number(soldCost.unit_cost_at_sale));
    expect(Number((await ctx.db.get(
      "SELECT value_adjustment FROM inventory_ledger WHERE id = ?",
      [soldAdjustment.id]
    )).value_adjustment)).toBeCloseTo(-0.01, 2);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [soldOut.id]
    )).n)).toBe(0);

    const cycleRead = await request(ctx.app)
      .get("/api/v1/inventory/expiry-cycle")
      .query({ scope: "retail" })
      .set(authHeader(adminToken));
    expect(cycleRead.status).toBe(200);
    const cycleAfter = unwrap(cycleRead.body);
    expect(cycleAfter.cycle_id).toBe(cycleBefore.cycle_id);
    expect(cycleAfter.status).toBe("awaiting_count");
    expect(cycleAfter.verified_lines).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM expiry_report_exclusions WHERE cycle_id = ?",
      [cycleBefore.cycle_id]
    )).n)).toBe(Number(exclusionsBefore.n));
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM expiry_report_verifications")).n)).toBe(
      Number(verificationsBefore.n)
    );

    const run = await ctx.db.get("SELECT * FROM zero_all_stock_runs ORDER BY id DESC LIMIT 1");
    const audit = await ctx.db.get(
      `SELECT entity_type, entity_id FROM audit_logs
        WHERE entity_type = 'zero_all_stock_runs' ORDER BY id DESC LIMIT 1`
    );
    expect(Number(audit.entity_id)).toBe(Number(run.id));
    expect(Number(run.valuation_rebuilds)).toBe(0);
    expect(Number(run.depletion_passes)).toBe(1);

    const ledgerCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reference_type = 'zero_all_stock'"
    );
    const adjustmentSum = await ctx.db.get(
      "SELECT COALESCE(SUM(value_adjustment), 0) AS n FROM inventory_ledger"
    );
    const again = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .send({});
    expect(again.status).toBe(200);
    expect((await waitForZeroAllStock(ctx.app, adminToken, again)).products_zeroed).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reference_type = 'zero_all_stock'"
    )).n)).toBe(Number(ledgerCount.n));
    expect(Number((await ctx.db.get(
      "SELECT COALESCE(SUM(value_adjustment), 0) AS n FROM inventory_ledger"
    )).n)).toBeCloseTo(Number(adjustmentSum.n), 2);

    const statusRead = await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .set(authHeader(adminToken));
    expect(statusRead.status).toBe(200);
    const status = unwrap(statusRead.body);
    expect(status.verdict).toBe("committed");
    expect(status.read_only).toBe(true);
    expect(status.latest_run.products_zeroed).toBe(0);
    expect(status.evidence.ledger_rows_for_latest_run).toBe(0);
    expect(status.latest_run.id).toBeGreaterThan(Number(run.id));
  });

  test("unauthorized callers and a wrong password do not change stock", async () => {
    const missing = await request(ctx.app).post("/api/v1/inventory/zero-all-stock").send({});
    expect(missing.status).toBe(401);
    const cashier = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(cashierToken))
      .send({});
    expect(cashier.status).toBe(403);
    await createAccountantUser(ctx.db, { username: "zeroacct", password: "acctpass123" });
    const accountantToken = (await login(ctx.app, "zeroacct", "acctpass123", "office")).body.token;
    const accountant = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(accountantToken))
      .send({});
    expect(accountant.status).toBe(403);
    const statusDenied = await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .set(authHeader(cashierToken));
    expect(statusDenied.status).toBe(403);

    await ctx.db.run("UPDATE products SET stock = 6 WHERE id = ?", [ctx.productId]);
    const setPassword = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "zeropass" });
    expect(setPassword.status).toBe(200);
    const wrong = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "nope" })
      .send({});
    expect(wrong.status).toBe(403);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(6);
    const right = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "zeropass" })
      .send({});
    expect(right.status).toBe(200);
    await waitForZeroAllStock(ctx.app, adminToken, right);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(0);
    await request(ctx.app).delete("/api/v1/admin/zero-all-stock-password").set(authHeader(adminToken));
    expect(Number((await ctx.db.get("SELECT COALESCE(SUM(stock), 0) AS n FROM products")).n)).toBe(0);
  });

  test("the same idempotency key does not reset twice, and a lost retry can read status", async () => {
    await ctx.db.run("UPDATE products SET stock = 8 WHERE id = ?", [ctx.productId]);
    const ledgerBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [ctx.productId]
    )).n);
    const auditsBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'zero_all_stock_runs'"
    )).n);
    const key = "zero-same-key-01";
    const first = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .set("Idempotency-Key", key)
      .send({});
    expect(first.status).toBe(200);
    expect(unwrap(first.body).status).toBe("running");
    expect(unwrap(first.body).replayed).toBe(false);
    const firstBody = await waitForZeroAllStock(ctx.app, adminToken, first);
    expect(firstBody.products_zeroed).toBeGreaterThan(0);
    const second = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .set("Idempotency-Key", key)
      .send({});
    expect(second.status).toBe(200);
    expect(unwrap(second.body).status).toBe("completed");
    expect(unwrap(second.body).replayed).toBe(true);
    expect(unwrap(second.body).products_zeroed).toBe(firstBody.products_zeroed);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM zero_all_stock_runs WHERE idempotency_key = ?",
      [key]
    )).n)).toBe(1);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [ctx.productId]
    )).n)).toBe(ledgerBefore + 1);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'zero_all_stock_runs'"
    )).n)).toBe(auditsBefore + 1);

    const readsBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM audit_logs")).n);
    const statusRead = await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .set(authHeader(adminToken));
    expect(statusRead.status).toBe(200);
    const status = unwrap(statusRead.body);
    expect(status.verdict).toBe("committed");
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM audit_logs")).n)).toBe(readsBefore);

    await ctx.db.run("UPDATE products SET stock = 4 WHERE id = ?", [ctx.productId]);
    const dirty = await diagnoseZeroAllStock(ctx.db);
    expect(dirty.verdict).toBe("unresolved");
    expect(dirty.evidence.stock_open).toBeGreaterThan(0);
    await ctx.db.run("UPDATE products SET stock = 0 WHERE id = ?", [ctx.productId]);
    expect((await diagnoseZeroAllStock(ctx.db)).verdict).toBe("committed");
  });
});

describe("zero all stock failure and overlap", () => {
  let ctx;
  let adminToken;
  let adminUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    adminUser = await ctx.db.get("SELECT id, username, role FROM users WHERE username = 'testadmin'");
  });

  afterAll(async () => {
    resetZeroAllStockGuardForTests();
    await destroyTestContext(ctx);
  });

  test("a failure midway rolls back quantities, ledger rows, and the completion audit", async () => {
    const stockBefore = Number((await ctx.db.get("SELECT COALESCE(SUM(stock), 0) AS n FROM products")).n);
    const ledgerBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n);
    const allocBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM stock_batch_allocations")).n);
    const rollbackKey = "rollback-key-0001";
    await expect(runZeroAllStock(ctx.db, {
      userId: adminUser.id,
      req: fakeReq(adminUser),
      idempotencyKey: rollbackKey,
      failAfter: 1,
    })).rejects.toMatchObject({ code: "FORCED_ZERO_FAILURE" });
    const failed = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: rollbackKey })
      .set(authHeader(adminToken))).body);
    expect(failed.status).toBe("failed");
    expect(failed.percent).not.toBe(100);
    expect(failed.products_zeroed).toBeNull();
    resetZeroAllStockGuardForTests();
    const interrupted = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: rollbackKey })
      .set(authHeader(adminToken))).body);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.percent).toBeNull();
    expect(interrupted.products_zeroed).toBeNull();
    expect(Number((await ctx.db.get("SELECT COALESCE(SUM(stock), 0) AS n FROM products")).n)).toBeCloseTo(stockBefore, 3);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n)).toBe(ledgerBefore);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM stock_batch_allocations")).n)).toBe(allocBefore);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM zero_all_stock_runs")).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'zero_all_stock_runs'"
    )).n)).toBe(0);
    const status = await diagnoseZeroAllStock(ctx.db);
    expect(status.verdict).toBe("rolled_back");
  });

  test("a second submission waits outside the running reset, and a read stays available", async () => {
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const pending = runZeroAllStock(ctx.db, {
      userId: adminUser.id,
      req: fakeReq(adminUser),
      idempotencyKey: "inflight-key-aaaa",
      hold,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const other = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .set("Idempotency-Key", "inflight-key-bbbb")
      .send({});
    expect(other.status).toBe(200);
    const reused = unwrap(other.body);
    expect(reused.reused).toBe(true);
    expect(reused.operation_id).toBe("inflight-key-aaaa");
    expect(reused.status).toBe("running");
    expect(reused.percent).not.toBe(100);
    resetValuationAccountingStats();
    const progressStarted = Date.now();
    const progress = await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: "inflight-key-aaaa" })
      .set(authHeader(adminToken));
    const progressMs = Date.now() - progressStarted;
    expect(progress.status).toBe(200);
    const progressBody = unwrap(progress.body);
    expect(progressBody.stage).toBe("preparing");
    expect(progressBody.indeterminate).toBe(true);
    expect(progressBody.stage_ar).toBe("جارٍ تجهيز بيانات المخزون…");
    expect(progressBody.percent).toBeNull();
    expect(progressMs).toBeLessThan(500);
    expect(Number(progress.headers["x-query-count"])).toBeLessThan(20);
    expect(valuationAccountingStats().historicalBuilds).toBe(0);
    const reconnect = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .set(authHeader(adminToken))).body);
    expect(reconnect.operation_id).toBe("inflight-key-aaaa");
    expect(reconnect.status).toBe("running");

    let settled = false;
    const adjustment = request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "in",
        items: [{ product_id: ctx.productId, quantity: 1 }],
        post: true,
      })
      .then((res) => {
        settled = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    const healthStarted = Date.now();
    const health = await request(ctx.app).get("/api/v1/health");
    const healthMs = Date.now() - healthStarted;
    expect(health.status).toBe(200);
    expect(healthMs).toBeLessThan(1000);
    release();
    const done = await pending;
    expect(done.products_zeroed).toBeGreaterThan(0);
    expect(done.valuation_rebuilds).toBe(0);
    const adj = await adjustment;
    expect(adj.status).toBe(201);
    expect(settled).toBe(true);
    const joined = await runZeroAllStock(ctx.db, {
      userId: adminUser.id,
      req: fakeReq(adminUser),
      idempotencyKey: "inflight-key-aaaa",
    });
    expect(joined.replayed).toBe(true);
    expect(joined.products_zeroed).toBe(done.products_zeroed);

    resetZeroAllStockGuardForTests();
    const reconciled = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: "inflight-key-aaaa" })
      .set(authHeader(adminToken))).body);
    expect(reconciled.status).toBe("completed");
    expect(reconciled.percent).toBe(100);
    expect(reconciled.products_changed).toBe(done.products_zeroed);
  });

  test("progress follows processed products and reaches 100 only after commit", async () => {
    await ctx.db.run("UPDATE products SET stock = 3 WHERE id = ?", [ctx.productId]);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = runZeroAllStock(ctx.db, {
      userId: adminUser.id,
      req: fakeReq(adminUser),
      idempotencyKey: "progress-key-0001",
      holdAfter: 1,
      holdAfterGate: gate,
    });
    let seen = null;
    for (let i = 0; i < 40; i += 1) {
      const status = unwrap((await request(ctx.app)
        .get("/api/v1/inventory/zero-all-stock/status")
        .query({ operation_id: "progress-key-0001" })
        .set(authHeader(adminToken))).body);
      if (status.stage === "zeroing" && status.processed >= 1 && status.processed < status.total) {
        seen = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(seen).toBeTruthy();
    expect(seen.stage_ar).toBe("جارٍ تصفير الكميات…");
    expect(seen.indeterminate).toBe(false);
    expect(seen.percent).toBe(Math.min(99, Math.floor((seen.processed / seen.total) * 100)));
    expect(seen.percent).toBeLessThan(100);
    expect(seen.products_changed).toBeNull();
    release();
    const done = await pending;
    const finalStatus = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: "progress-key-0001" })
      .set(authHeader(adminToken))).body);
    expect(finalStatus.status).toBe("completed");
    expect(finalStatus.stage_ar).toBe("اكتمل التصفير");
    expect(finalStatus.percent).toBe(100);
    expect(finalStatus.processed).toBe(finalStatus.total);
    expect(finalStatus.products_changed).toBe(done.products_zeroed);
    expect(finalStatus.products_changed + finalStatus.skipped).toBe(finalStatus.total);
  });

  test("ledger rows without a completion record stay unresolved", async () => {
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, reference_type, store_id)
       VALUES (?, 'stock_count_correction', -1, 1, 0, 'zero_all_stock', 1)`,
      [ctx.productId]
    );
    await ctx.db.run("DELETE FROM zero_all_stock_runs");
    await ctx.db.run("DELETE FROM audit_logs WHERE entity_type = 'zero_all_stock_runs'");
    const status = await diagnoseZeroAllStock(ctx.db);
    expect(status.verdict).toBe("unresolved");
    expect(status.evidence.zero_ledger_rows).toBeGreaterThan(0);
    expect(status.latest_run).toBeNull();
  });
});

describe("zero all stock representative cost", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket\.db/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
  }, 120000);

  afterAll(async () => {
    resetZeroAllStockGuardForTests();
    await destroyTestContext(ctx);
  });

  test("one bounded company rebuild is the old cost, and the reset does that work once", async () => {
    async function insertChunks(prefix, groups, size = 120) {
      for (let i = 0; i < groups.length; i += size) {
        const slice = groups.slice(i, i + size);
        const params = [];
        const values = slice.map((row) => {
          params.push(...row);
          return `(${row.map(() => "?").join(",")})`;
        }).join(",");
        await ctx.db.run(`${prefix} ${values}`, params);
      }
    }

    const main = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'main' AND active = 1");
    const returnsWh = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'returns' AND active = 1");
    const nonzeroTarget = 3379;
    const zeroTarget = 900;
    const lotTarget = 36715;
    const ledgerTarget = 104420;
    const seedStarted = Date.now();
    await ctx.db.exec("BEGIN IMMEDIATE");
    try {
      const productRows = [];
      for (let i = 0; i < nonzeroTarget + zeroTarget; i += 1) {
        const stock = i < nonzeroTarget ? (i % 12) + 1 : 0;
        productRows.push([`ZP${String(i).padStart(6, "0")}`, `صنف ${i}`, 1, 1.5, 1, "عام", stock, "retail"]);
      }
      await insertChunks(
        `INSERT INTO products (barcode, name, price, cost, cost_known, category, stock, inventory_scope) VALUES`,
        productRows
      );
      const seeded = await ctx.db.all(
        "SELECT id, stock FROM products WHERE barcode LIKE 'ZP%' AND stock > 0 ORDER BY id"
      );
      const ledgerRows = seeded.map((product) => [product.id, product.stock, 0, product.stock]);
      ledgerRows.push([seeded[0].id, 0, 0, 0]);
      let cursor = 0;
      while (ledgerRows.length + 1 < ledgerTarget) {
        const product = seeded[cursor % seeded.length];
        ledgerRows.push([product.id, 1, 0, 1], [product.id, -1, 1, 0]);
        cursor += 1;
      }
      await insertChunks(
        `INSERT INTO inventory_ledger
           (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
            unit_cost_after, cost_known, store_id)
         VALUES`,
        ledgerRows.map((row) => [row[0], "manual_adjustment", row[1], row[2], row[3], "2026-01-15", 1.5, 1, 1])
      );
      await insertChunks(
        "INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES",
        seeded.map((product) => [product.id, "2027-06-01", product.stock])
      );
      await insertChunks(
        "INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity) VALUES",
        seeded.flatMap((product) => {
          const rows = [[main.id, product.id, "", product.stock]];
          if (Number(product.id) % 5 === 0) rows.push([returnsWh.id, product.id, "2027-06-01", 1]);
          return rows;
        })
      );
      await insertChunks(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES",
        seeded.flatMap((product) => {
          const rows = [[main.id, product.id, product.stock]];
          if (Number(product.id) % 5 === 0) rows.push([returnsWh.id, product.id, 1]);
          return rows;
        })
      );
      const lotRows = [];
      for (let lots = 0; lots < lotTarget; lots += 1) {
        const product = seeded[lots % seeded.length];
        lotRows.push([
          product.id,
          lots % 2 === 0 ? returnsWh.id : main.id,
          lots % 3 === 0 ? "2027-06-01" : "",
          1,
          "unknown",
        ]);
      }
      await insertChunks(
        `INSERT INTO stock_source_lots (product_id, warehouse_id, expiry_date, quantity, provenance) VALUES`,
        lotRows
      );
      await ctx.db.exec("COMMIT");
    } catch (err) {
      try { await ctx.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw err;
    }
    const seedMs = Date.now() - seedStarted;

    const volume = await ctx.db.get(
      `SELECT
         (SELECT COUNT(*) FROM products) AS products,
         (SELECT COUNT(*) FROM products WHERE ABS(COALESCE(stock, 0)) > 1e-6) AS nonzero,
         (SELECT COUNT(*) FROM stock_source_lots) AS lots,
         (SELECT COUNT(*) FROM inventory_ledger) AS ledger`
    );
    expect(Number(volume.products)).toBeGreaterThanOrEqual(4283);
    expect(Number(volume.nonzero)).toBeGreaterThanOrEqual(3383);
    expect(Number(volume.lots)).toBeGreaterThanOrEqual(36715);
    expect(Number(volume.ledger)).toBeGreaterThanOrEqual(104420);

    resetValuationAccountingStats();
    const buildStarted = Date.now();
    await buildHistoricalWarehouseValuation(ctx.db, {}, "9999-12-31", "9999-12-31");
    const firstBuildMs = Date.now() - buildStarted;
    let measuredBuilds = 1;
    if (firstBuildMs < 8000) {
      await buildHistoricalWarehouseValuation(ctx.db, {}, "9999-12-31", "9999-12-31");
      measuredBuilds = 2;
    }
    expect(measuredBuilds).toBeLessThanOrEqual(2);
    expect(valuationAccountingStats().historicalBuilds).toBe(measuredBuilds);
    const extrapolatedMs = firstBuildMs * Number(volume.nonzero);

    resetValuationAccountingStats();
    const zeroStarted = Date.now();
    const zeroRes = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .send({});
    expect(zeroRes.status).toBe(200);
    const startedBody = unwrap(zeroRes.body);
    expect(startedBody.status).toBe("running");
    expect(Date.now() - zeroStarted).toBeLessThan(1000);
    const pollStarted = Date.now();
    const poll = await request(ctx.app)
      .get("/api/v1/inventory/zero-all-stock/status")
      .query({ operation_id: startedBody.operation_id })
      .set(authHeader(adminToken));
    const pollMs = Date.now() - pollStarted;
    const pollBody = unwrap(poll.body);
    expect(poll.status).toBe(200);
    expect(pollBody.status).toBe("running");
    expect(pollMs).toBeLessThan(500);
    expect(valuationAccountingStats().historicalBuilds).toBe(0);
    const healthStarted = Date.now();
    const health = await request(ctx.app).get("/api/v1/health");
    const healthMs = Date.now() - healthStarted;
    const finalBody = await waitForZeroAllStock(ctx.app, adminToken, zeroRes);
    const zeroMs = Date.now() - zeroStarted;
    const stats = valuationAccountingStats();
    const queryCount = Number(poll.headers["x-query-count"]);
    const measured = {
      driver: ctx.db.driver,
      seedMs,
      products: Number(volume.products),
      nonzero: Number(volume.nonzero),
      lots: Number(volume.lots),
      ledger: Number(volume.ledger),
      historicalBuildMs: firstBuildMs,
      historicalBuildsMeasured: measuredBuilds,
      extrapolatedMs,
      optimizedMs: zeroMs,
      valuationRebuilds: stats.historicalBuilds,
      depletionPasses: stats.depletionPasses,
      depletionProducts: stats.depletionProducts,
      queryCount,
      healthMs,
      pollMs,
      pollStage: pollBody.stage,
    };
    console.log(JSON.stringify({ label: "zero-all-stock-perf", ...measured }));

    expect(stats.historicalBuilds).toBe(0);
    expect(stats.depletionPasses).toBe(1);
    expect(queryCount).toBeGreaterThan(0);
    expect(queryCount).toBeLessThan(30);
    expect(extrapolatedMs).toBeGreaterThan(zeroMs * 10);
    expect(health.status).toBe(200);
    expect(healthMs).toBeLessThan(5000);
    expect(pollBody.status).toBe("running");
    expect(finalBody.percent).toBe(100);
    expect(finalBody.products_zeroed).toBeGreaterThanOrEqual(Number(volume.nonzero));
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM products WHERE ABS(COALESCE(stock, 0)) > 1e-6"
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_source_lots WHERE ABS(quantity) > 1e-9"
    )).n)).toBe(0);
  }, 240000);
});
