/**
 * Supplier and receipt identity under company batches.
 * Disposable database only. Expectations are calculated from the documents.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd, shopYmdToUtcBounds } from "../utils/shopTime.js";
import { ensureProductSourceLots, backfillAllSourceLots } from "../services/stockSourceService.js";

const CLOCK = "2026-10-05";
const SAME = "2026-10-20";
const OTHER = "2026-11-02";

function unwrap(body) {
  return body?.data ?? body;
}

function noonOf(ymd) {
  return new Date(shopYmdToUtcBounds(ymd).startIso).getTime() + 12 * 60 * 60 * 1000;
}

jest.setTimeout(60000);

async function buildShop() {
  jest.useFakeTimers({
    now: noonOf(CLOCK),
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
  });
  const ctx = await createTestContext();
  if (!/abo-shalbak-test-/.test(ctx.dbPath) || !/test\.db$/.test(ctx.dbPath)) {
    throw new Error(`refusing non-temporary database ${ctx.dbPath}`);
  }
  const adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
  const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  const supplierA = (await ctx.db.run(
    "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد أ', 'SRC-A', 0, 0)"
  )).lastID;
  const supplierB = (await ctx.db.run(
    "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد ب', 'SRC-B', 0, 0)"
  )).lastID;
  const shift = await request(ctx.app)
    .post("/api/v1/shifts/start")
    .set(authHeader(cashierToken))
    .send({ opening_cash: 300 });
  if (shift.status !== 201) throw new Error(`shift ${shift.status}`);
  const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
  return {
    ctx,
    adminToken,
    cashierToken,
    supplierA,
    supplierB,
    main: warehouses.find((row) => row.type === "main"),
    returnsWh: warehouses.find((row) => row.type === "returns"),
  };
}

async function closeShop(shop) {
  jest.useRealTimers();
  if (shop?.ctx) await destroyTestContext(shop.ctx);
}

async function makeProduct(ctx, name) {
  const barcode = `66${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 9)}`;
  const ins = await ctx.db.run(
    `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
     VALUES (?, ?, 8, 0, 'Test', 0, 0)`,
    [barcode, name]
  );
  await ctx.db.run(
    "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)",
    [ins.lastID, barcode]
  );
  await ctx.db.run(
    `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
     VALUES (?, 'حبة', ?, 8, 0, 1, 1)`,
    [ins.lastID, barcode]
  );
  return { id: ins.lastID, barcode };
}

async function receive(shop, supplierId, productId, lines) {
  const created = await request(shop.ctx.app)
    .post("/api/v1/purchases/invoices")
    .set(authHeader(shop.adminToken))
    .send({
      supplier_id: supplierId,
      invoice_date: CLOCK,
      items: lines.map((line) => ({ product_id: productId, ...line })),
    });
  expect(created.status).toBe(201);
  const posted = await request(shop.ctx.app)
    .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
    .set(authHeader(shop.adminToken))
    .send({});
  expect(posted.status).toBe(200);
  return unwrap(posted.body);
}

async function sourceLots(db, productId) {
  return db.all(
    `SELECT l.supplier_id, s.name AS supplier_name, l.expiry_date, l.quantity, l.provenance,
            l.purchase_invoice_item_id, l.warehouse_id, w.type AS warehouse_type, l.id
       FROM stock_source_lots l
       LEFT JOIN suppliers s ON s.id = l.supplier_id
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.product_id = ? AND l.quantity > 0.0000001
      ORDER BY l.received_at, l.id`,
    [productId]
  );
}

function qtyOf(rows, predicate) {
  return rows.filter(predicate).reduce((sum, row) => sum + Number(row.quantity), 0);
}

describe("supplier source lots", () => {
  let shop;

  beforeEach(async () => {
    shop = await buildShop();
    expect(shopTodayYmd()).toBe(CLOCK);
  });

  afterEach(async () => {
    await closeShop(shop);
  });

  test("same expiry from two suppliers stays split through transfer and return", async () => {
    const product = await makeProduct(shop.ctx, "حليب");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 5, total_cost: 20, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 10, total_cost: 60, expiry_date: SAME }]);

    const company = Number((await shop.ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id])).stock);
    expect(company).toBe(15);
    let lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierA)).toBe(5);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(10);
    expect(new Set(lots.map((row) => row.purchase_invoice_item_id)).size).toBe(2);

    const lotA = lots.find((row) => row.supplier_id === shop.supplierA);
    const sources = unwrap((await request(shop.ctx.app)
      .get(`/api/v1/warehouses/${shop.main.id}/sources`)
      .query({ product_id: product.id })
      .set(authHeader(shop.adminToken))).body);
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplier_id: shop.supplierA, quantity: 5, expiry_date: SAME }),
      expect.objectContaining({ supplier_id: shop.supplierB, quantity: 10, expiry_date: SAME }),
    ]));
    expect(sources.find((row) => row.supplier_id === shop.supplierA).supplier_name).toBe("مورد أ");
    expect(sources.find((row) => row.supplier_id === shop.supplierB).supplier_name).toBe("مورد ب");

    const draft = await request(shop.ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(shop.adminToken))
      .send({
        from_warehouse_id: shop.main.id,
        to_warehouse_id: shop.returnsWh.id,
        items: [{
          product_id: product.id,
          quantity: 5,
          batch_source: "dated",
          expiry_date: SAME,
          source_lot_id: lotA.id,
        }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(shop.ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(shop.adminToken));
    expect(posted.status).toBe(200);

    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.warehouse_type === "main" && row.supplier_id === shop.supplierB)).toBe(10);
    expect(qtyOf(lots, (row) => row.warehouse_type === "returns" && row.supplier_id === shop.supplierA)).toBe(5);
    expect(qtyOf(lots, (row) => row.warehouse_type === "main" && row.supplier_id === shop.supplierA)).toBe(0);

    const batch = Number((await shop.ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, SAME]
    )).quantity);
    expect(batch).toBe(15);

    const wrong = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierB,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 5,
          total_cost: 20,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: lots.find((row) => row.supplier_id === shop.supplierA).id,
        }],
      });
    expect(wrong.status).toBe(201);
    const wrongPost = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(wrong.body).id}/post`)
      .set(authHeader(shop.adminToken));
    expect(wrongPost.status).toBe(400);
    expect(unwrap(wrongPost.body).code || wrongPost.body.code).toBe("WRONG_SUPPLIER");
    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(15);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierB])).balance)).toBe(60);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(20);

    const ret = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 5,
          total_cost: 20,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: lots.find((row) => row.supplier_id === shop.supplierA).id,
        }],
      });
    expect(ret.status).toBe(201);
    const retPosted = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(ret.body).id}/post`)
      .set(authHeader(shop.adminToken));
    expect(retPosted.status).toBe(200);
    const again = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(ret.body).id}/post`)
      .set(authHeader(shop.adminToken));
    expect(again.status).toBe(400);

    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(10);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(0);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierB])).balance)).toBe(60);
    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.warehouse_type === "main")).toBe(10);
    expect(qtyOf(lots, (row) => row.warehouse_type === "returns")).toBe(0);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(10);
    const mainRow = await shop.ctx.db.get(
      `SELECT SUM(s.quantity) AS qty FROM warehouse_batch_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ? AND w.type = 'main'`,
      [product.id]
    );
    expect(Number(mainRow.qty)).toBe(10);

    const report = unwrap((await request(shop.ctx.app)
      .get("/api/v1/inventory/expiry")
      .query({ days: 30 })
      .set(authHeader(shop.adminToken))).body);
    const row = report.find((item) => item.product_id === product.id && item.expiry_date === SAME);
    expect(row.stock).toBe(10);
    expect(row.supplier_label).toBe("مورد ب");
    expect(row.suppliers.reduce((sum, item) => sum + Number(item.quantity), 0)).toBe(10);
  });

  test("a sale consumes receipt order and a refund restores those sources", async () => {
    const product = await makeProduct(shop.ctx, "حليب بيع");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 5, total_cost: 20, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 10, total_cost: 60, expiry_date: SAME }]);
    const wac = Number((await shop.ctx.db.get("SELECT cost FROM products WHERE id = ?", [product.id])).cost);
    expect(wac).toBeCloseTo(5.33, 2);

    const sale = await request(shop.ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(shop.cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 7, price: 8 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const sold = await shop.ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ? AND product_id = ?",
      [txId, product.id]
    );
    expect(Number(sold.unit_cost_at_sale)).toBeCloseTo(wac, 2);

    const alloc = await shop.ctx.db.all(
      `SELECT supplier_id, quantity, source_lot_id FROM stock_batch_allocations
        WHERE reference_type = 'transaction' AND reference_id = ? AND direction = 'out'
        ORDER BY id`,
      [txId]
    );
    expect(alloc.map((row) => [row.supplier_id, Number(row.quantity)])).toEqual([
      [shop.supplierA, 5],
      [shop.supplierB, 2],
    ]);
    let lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierA)).toBe(0);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(8);

    const refund = await request(shop.ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(shop.cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 7 }],
        payment_method: "cash",
        idempotency_key: `src-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(shop.ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(shop.adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierA && row.warehouse_type === "main")).toBe(5);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB && row.warehouse_type === "main")).toBe(10);
    expect(Number((await shop.ctx.db.get("SELECT cost FROM products WHERE id = ?", [product.id])).cost)).toBeCloseTo(wac, 2);
  });

  test("separate expiries, undated receipts, duplicate lines, and unknown sales", async () => {
    const product = await makeProduct(shop.ctx, "مصادر متعددة");
    await receive(shop, shop.supplierA, product.id, [
      { quantity: 4, total_cost: 8, expiry_date: SAME },
      { quantity: 3, total_cost: 9 },
    ]);
    await receive(shop, shop.supplierB, product.id, [
      { quantity: 6, total_cost: 18, expiry_date: OTHER },
      { quantity: 2, total_cost: 8 },
    ]);
    await receive(shop, shop.supplierA, product.id, [{ quantity: 1, total_cost: 3 }]);

    let lots = await sourceLots(shop.ctx.db, product.id);
    expect(lots.filter((row) => row.supplier_id === shop.supplierA && !row.expiry_date)).toHaveLength(2);
    const undatedA = lots.filter((row) => row.supplier_id === shop.supplierA && !row.expiry_date);
    const sources = unwrap((await request(shop.ctx.app)
      .get(`/api/v1/warehouses/${shop.main.id}/sources`)
      .query({ product_id: product.id })
      .set(authHeader(shop.adminToken))).body);
    const undatedOptions = sources.filter((row) => row.batch_source === "undated" && row.supplier_id === shop.supplierA);
    expect(undatedOptions.every((row) => row.show_receipt_reference)).toBe(true);

    const moveBoth = await request(shop.ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(shop.adminToken))
      .send({
        from_warehouse_id: shop.main.id,
        to_warehouse_id: shop.returnsWh.id,
        items: undatedA.map((lot) => ({
          product_id: product.id,
          quantity: Number(lot.quantity),
          batch_source: "undated",
          source_lot_id: lot.id,
        })),
      });
    expect(moveBoth.status).toBe(201);
    expect((await request(shop.ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(moveBoth.body).id}/post`)
      .set(authHeader(shop.adminToken))).status).toBe(200);

    const over = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [
          { product_id: product.id, quantity: 3, total_cost: 9, batch_source: "undated", source_lot_id: undatedA[0].id },
          { product_id: product.id, quantity: 3, total_cost: 9, batch_source: "undated", source_lot_id: undatedA[0].id },
        ],
      });
    expect(over.status).toBe(201);
    const stockBefore = Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const balBefore = Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance);
    const overPost = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(over.body).id}/post`)
      .set(authHeader(shop.adminToken));
    expect(overPost.status).toBe(400);
    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(stockBefore);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(balBefore);
    expect((await shop.ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [unwrap(over.body).id])).status).toBe("draft");

    const report = unwrap((await request(shop.ctx.app)
      .get("/api/v1/inventory/expiry")
      .query({ days: 60 })
      .set(authHeader(shop.adminToken))).body);
    const dated = report.filter((row) => row.product_id === product.id);
    const first = dated.find((row) => row.expiry_date === SAME);
    const second = dated.find((row) => row.expiry_date === OTHER);
    expect(first.supplier_label).toBe("مورد أ");
    expect(first.stock).toBe(4);
    expect(second.supplier_label).toBe("مورد ب");
    expect(second.stock).toBe(6);
    expect(first.suppliers.reduce((sum, item) => sum + Number(item.quantity), 0)).toBe(Number(first.stock));

    await shop.ctx.db.run(
      `INSERT INTO stock_source_lots
         (product_id, warehouse_id, expiry_date, supplier_id, quantity, provenance, received_at)
       VALUES (?, ?, ?, NULL, 2, 'unknown', datetime('now'))`,
      [product.id, shop.main.id, SAME]
    );
    await shop.ctx.db.run(
      "UPDATE warehouse_batch_stock SET quantity = quantity + 2 WHERE product_id = ? AND expiry_date = ? AND warehouse_id = ?",
      [product.id, SAME, shop.main.id]
    );
    await shop.ctx.db.run(
      "UPDATE product_batches SET quantity = quantity + 2 WHERE product_id = ? AND expiry_date = ?",
      [product.id, SAME]
    );
    await shop.ctx.db.run("UPDATE products SET stock = stock + 2 WHERE id = ?", [product.id]);
    const unknownSale = await request(shop.ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(shop.cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 5, price: 8 }],
        payment_method: "cash",
      }, `unknown-sale-${product.id}`));
    expect(unknownSale.status).toBe(201);
  });

  test("legacy mixed receipts stay unknown and initialization does not rewrite them", async () => {
    const product = await makeProduct(shop.ctx, "قديم");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 5, total_cost: 20, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 10, total_cost: 60, expiry_date: SAME }]);
    await shop.ctx.db.run(
      `INSERT INTO stock_batch_allocations
         (product_id, expiry_date, quantity, direction, reference_type, reference_id)
       VALUES (?, ?, 3, 'out', 'transaction', 1)`,
      [product.id, SAME]
    );
    await shop.ctx.db.run("DELETE FROM stock_source_lots WHERE product_id = ?", [product.id]);
    await ensureProductSourceLots(shop.ctx.db, product.id);
    let lots = await sourceLots(shop.ctx.db, product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0].supplier_id).toBeNull();
    expect(lots[0].provenance).toBe("unknown");
    expect(Number(lots[0].quantity)).toBe(15);

    const assigned = await request(shop.ctx.app)
      .post("/api/v1/inventory/source-lots/assign")
      .set(authHeader(shop.adminToken))
      .send({
        source_lot_id: lots[0].id,
        supplier_id: shop.supplierA,
        quantity: 4,
        note: "جرد يدوي",
      });
    expect(assigned.status).toBe(200);
    const purchasesBefore = await shop.ctx.db.get("SELECT COUNT(*) AS n FROM purchase_invoices");
    const salesBefore = await shop.ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    await backfillAllSourceLots(shop.ctx.db);
    const again = await initDatabase(shop.ctx.dbPath);
    await backfillAllSourceLots(again);
    await closeSqliteConnection(again);
    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.provenance === "unknown")).toBe(11);
    expect(qtyOf(lots, (row) => row.provenance === "assigned" && row.supplier_id === shop.supplierA)).toBe(4);
    expect(Number((await shop.ctx.db.get("SELECT COUNT(*) AS n FROM stock_source_assignments WHERE product_id = ?", [product.id])).n)).toBe(1);
    expect(Number((await shop.ctx.db.get("SELECT COUNT(*) AS n FROM purchase_invoices")).n)).toBe(Number(purchasesBefore.n));
    expect(Number((await shop.ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(Number(salesBefore.n));
    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(15);
  });

  test("damage, consumption, counts, and zero-all keep source quantities consistent", async () => {
    const product = await makeProduct(shop.ctx, "حركات");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 6, total_cost: 12, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 4, total_cost: 16, expiry_date: OTHER }]);

    const damage = await request(shop.ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(shop.adminToken))
      .send({
        adjustment_type: "damage",
        adjustment_date: CLOCK,
        post: true,
        items: [{ product_id: product.id, quantity: 1, batch_source: "dated", expiry_date: SAME }],
      });
    expect(damage.status).toBe(201);
    let lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierA)).toBe(5);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(4);

    const consumed = await request(shop.ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(shop.adminToken))
      .send({
        adjustment_type: "consumption",
        adjustment_date: CLOCK,
        post: true,
        items: [{ product_id: product.id, quantity: 6 }],
      });
    expect(consumed.status).toBe(201);
    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierA)).toBe(0);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(3);

    const session = await request(shop.ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(shop.adminToken))
      .send({ department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const saved = await request(shop.ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(shop.adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: SAME, counted_qty: 2 },
          { batch_source: "dated", expiry_date: OTHER, counted_qty: 3 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(saved.status).toBe(200);
    const counted = await request(shop.ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(counted.status).toBe(200);
    lots = await sourceLots(shop.ctx.db, product.id);
    expect(qtyOf(lots, (row) => row.provenance === "unknown" && row.expiry_date === SAME)).toBe(2);
    expect(qtyOf(lots, (row) => row.supplier_id === shop.supplierB)).toBe(3);
    const batchQty = Number((await shop.ctx.db.get(
      "SELECT SUM(quantity) AS qty FROM product_batches WHERE product_id = ?",
      [product.id]
    )).qty);
    const lotQty = lots.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(lotQty).toBe(batchQty);

    const zeroed = await request(shop.ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(shop.adminToken))
      .send({});
    expect(zeroed.status).toBe(200);
    expect(await sourceLots(shop.ctx.db, product.id)).toEqual([]);
    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(0);
  });

  test("two sales cannot consume the same receipt twice", async () => {
    const product = await makeProduct(shop.ctx, "تزامن");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 1, total_cost: 4, expiry_date: SAME }]);
    const [a, b] = await Promise.all([
      request(shop.ctx.app).post("/api/v1/checkout").set(authHeader(shop.cashierToken)).send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: 8 }],
        payment_method: "cash",
      }, `src-race-a-${product.id}`)),
      request(shop.ctx.app).post("/api/v1/checkout").set(authHeader(shop.cashierToken)).send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: 8 }],
        payment_method: "cash",
      }, `src-race-b-${product.id}`)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);
    expect(Number((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(0);
    const lots = await sourceLots(shop.ctx.db, product.id);
    expect(lots.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(0);
  });
});
