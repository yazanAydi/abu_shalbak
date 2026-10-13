/**
 * Purchase returns created from supplier lots already in مرتجعات.
 * Disposable database only.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { shopTodayYmd, shopYmdToUtcBounds } from "../utils/shopTime.js";

const CLOCK = "2026-10-05";
const SAME = "2026-10-20";
let barcodeSeq = 880000000000;

function unwrap(body) {
  return body?.data ?? body;
}

function codeOf(res) {
  return res.body?.code || res.body?.data?.code || null;
}

jest.setTimeout(60000);

async function buildShop() {
  jest.useFakeTimers({
    now: new Date(shopYmdToUtcBounds(CLOCK).startIso).getTime() + 12 * 60 * 60 * 1000,
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
  });
  const ctx = await createTestContext();
  if (!/abo-shalbak-test-/.test(ctx.dbPath)) throw new Error(`refusing ${ctx.dbPath}`);
  const adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
  const supplierA = (await ctx.db.run(
    "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد أ', 'RET-A', 0, 0)"
  )).lastID;
  const supplierB = (await ctx.db.run(
    "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد ب', 'RET-B', 0, 0)"
  )).lastID;
  const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
  return {
    ctx,
    adminToken,
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

async function makeProduct(ctx, name, scope = "retail") {
  barcodeSeq += 1;
  const barcode = String(barcodeSeq);
  const ins = await ctx.db.run(
    `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known, inventory_scope)
     VALUES (?, ?, 8, 0, 'اختبار مرتجع', 0, 0, ?)`,
    [barcode, name, scope]
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
}

async function transferLots(shop, lots) {
  const draft = await request(shop.ctx.app)
    .post("/api/v1/warehouses/transfers")
    .set(authHeader(shop.adminToken))
    .send({
      from_warehouse_id: shop.main.id,
      to_warehouse_id: shop.returnsWh.id,
      transfer_date: CLOCK,
      items: lots.map((lot) => ({
        product_id: lot.product_id,
        quantity: lot.quantity,
        source_lot_id: lot.id,
        batch_source: lot.expiry_date ? "dated" : "undated",
        expiry_date: lot.expiry_date || undefined,
      })),
    });
  expect(draft.status).toBe(201);
  const posted = await request(shop.ctx.app)
    .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
    .set(authHeader(shop.adminToken));
  expect(posted.status).toBe(200);
}

async function lotsOf(db, productId, warehouseId, supplierId) {
  return db.all(
    `SELECT * FROM stock_source_lots
      WHERE product_id = ? AND warehouse_id = ? AND supplier_id = ? AND quantity > 0.0000001
      ORDER BY received_at, id`,
    [productId, warehouseId, supplierId]
  );
}

async function listReturns(shop, params) {
  const res = await request(shop.ctx.app)
    .get("/api/v1/warehouses/returns-stock")
    .query(params)
    .set(authHeader(shop.adminToken));
  expect(res.status).toBe(200);
  return unwrap(res.body);
}

function snapshot(db, productId) {
  return db.get("SELECT stock, cost FROM products WHERE id = ?", [productId]);
}

describe("purchase return from مرتجعات", () => {
  let shop;

  beforeAll(async () => {
    shop = await buildShop();
  });

  afterAll(async () => {
    await closeShop(shop);
  });

  test("supplier filter, pagination, partial return, and the other supplier stay intact", async () => {
    const product = await makeProduct(shop.ctx, "حليب مشترك");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 5, total_cost: 20, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 10, total_cost: 60, expiry_date: SAME }]);
    const aMain = await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierA);
    const bMain = await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierB);
    await transferLots(shop, [...aMain, ...bMain]);

    const page = await listReturns(shop, { supplier_id: shop.supplierA, limit: 1, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].supplier_id).toBe(shop.supplierA);
    expect(page.rows[0].quantity).toBe(5);
    expect(page.rows[0].expiry_date).toBe(SAME);
    const hidden = await listReturns(shop, { supplier_id: shop.supplierB, limit: 1 });
    expect(hidden.rows.every((row) => row.supplier_id === shop.supplierB)).toBe(true);
    expect(hidden.rows.some((row) => row.source_lot_id === page.rows[0].source_lot_id)).toBe(false);

    const extras = [];
    for (let i = 0; i < 3; i += 1) {
      const extra = await makeProduct(shop.ctx, `صنف ${i}`);
      await receive(shop, shop.supplierA, extra.id, [{ quantity: 1, total_cost: 4, expiry_date: SAME }]);
      extras.push(...await lotsOf(shop.ctx.db, extra.id, shop.main.id, shop.supplierA));
    }
    await transferLots(shop, extras);
    const first = await listReturns(shop, { supplier_id: shop.supplierA, limit: 2, offset: 0 });
    const second = await listReturns(shop, { supplier_id: shop.supplierA, limit: 2, offset: 2 });
    const all = await listReturns(shop, { supplier_id: shop.supplierA, limit: "all" });
    expect(first.total).toBe(4);
    expect(all.total).toBe(4);
    expect(all.rows).toHaveLength(4);
    const visibleIds = new Set([...first.rows, ...second.rows].map((row) => row.source_lot_id));
    expect(all.rows.map((row) => row.source_lot_id).every((id) => visibleIds.has(id))).toBe(true);
    expect(first.rows).toHaveLength(2);
    expect(second.rows.length).toBeGreaterThan(0);

    const chosen = all.rows.find((row) => row.product_id === product.id);
    const only = all.rows.filter((row) => row.source_lot_id === chosen.source_lot_id);
    expect(only).toHaveLength(1);
    const created = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 2,
          total_cost: 8,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: chosen.source_lot_id,
        }],
      });
    expect(created.status).toBe(201);
    const ret = unwrap(created.body);
    const stockBefore = Number((await snapshot(shop.ctx.db, product.id)).stock);
    const balA = Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance);
    const balB = Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierB])).balance);
    const mainBefore = await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierB);
    const removed = await request(shop.ctx.app)
      .delete(`/api/v1/purchases/returns/${ret.id}`)
      .set(authHeader(shop.adminToken));
    expect(removed.status).toBe(200);
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(stockBefore);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(balA);

    const again = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 2,
          total_cost: 8,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: chosen.source_lot_id,
        }],
      });
    expect(again.status).toBe(201);
    const posted = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(again.body).id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const retry = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(again.body).id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(retry.status).toBe(400);
    expect(codeOf(retry)).toBe("ALREADY_POSTED");
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(stockBefore - 2);
    const left = await shop.ctx.db.get(
      "SELECT quantity FROM stock_source_lots WHERE id = ?",
      [chosen.source_lot_id]
    );
    expect(Number(left.quantity)).toBe(3);
    expect(await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierB)).toEqual(mainBefore);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(balA - 8);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierB])).balance)).toBe(balB);
    const bReturns = await lotsOf(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierB);
    expect(bReturns.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10);
    expect(shopTodayYmd()).toBe(CLOCK);
  });

  test("multiple receipts keep their identities, unknown stock is not returned, and a stale line rolls back", async () => {
    const product = await makeProduct(shop.ctx, "إيصالات");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 4, total_cost: 16, expiry_date: SAME }]);
    await receive(shop, shop.supplierA, product.id, [{ quantity: 6, total_cost: 30, expiry_date: SAME }]);
    const mainLots = await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierA);
    expect(mainLots).toHaveLength(2);
    await transferLots(shop, mainLots);
    const listed = await listReturns(shop, { supplier_id: shop.supplierA, limit: "all", q: "إيصالات" });
    const mine = listed.rows.filter((row) => row.product_id === product.id);
    expect(mine).toHaveLength(2);
    expect(mine.some((row) => row.show_receipt_reference)).toBe(true);
    const created = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: mine.map((row) => ({
          product_id: product.id,
          quantity: row.quantity,
          total_cost: row.quantity * 4,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: row.source_lot_id,
        })),
      });
    expect(created.status).toBe(201);
    const items = await shop.ctx.db.all(
      "SELECT source_lot_id, quantity FROM purchase_return_items WHERE return_id = ? ORDER BY source_lot_id",
      [unwrap(created.body).id]
    );
    expect(items.map((row) => Number(row.source_lot_id))).toEqual(mine.map((row) => row.source_lot_id).sort((a, b) => a - b));

    const unknownProduct = await makeProduct(shop.ctx, "افتتاحي");
    await shop.ctx.db.run("UPDATE products SET stock = 3 WHERE id = ?", [unknownProduct.id]);
    const moved = await request(shop.ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(shop.adminToken))
      .send({
        from_warehouse_id: shop.main.id,
        to_warehouse_id: shop.returnsWh.id,
        items: [{ product_id: unknownProduct.id, quantity: 3, batch_source: "undated" }],
      });
    expect(moved.status).toBe(201);
    expect((await request(shop.ctx.app).post(`/api/v1/warehouses/transfers/${unwrap(moved.body).id}/post`).set(authHeader(shop.adminToken))).status).toBe(200);
    const unknown = await listReturns(shop, { unknown: "1", q: "افتتاحي" });
    expect(unknown.rows).toHaveLength(1);
    expect(unknown.rows[0].supplier_name).toBe("غير معروف");
    expect(unknown.rows[0].eligible).toBe(false);
    const rejected = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [{
          product_id: unknownProduct.id,
          quantity: 3,
          total_cost: 9,
          batch_source: "undated",
          source_lot_id: unknown.rows[0].source_lot_id,
        }],
      });
    expect(rejected.status).toBe(201);
    const beforeUnknown = Number((await snapshot(shop.ctx.db, unknownProduct.id)).stock);
    const beforeBal = Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance);
    const denied = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(rejected.body).id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(denied.status).toBe(400);
    expect(codeOf(denied)).toBe("WRONG_SUPPLIER");
    expect(Number((await snapshot(shop.ctx.db, unknownProduct.id)).stock)).toBe(beforeUnknown);
    expect(Number((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierA])).balance)).toBe(beforeBal);
    expect((await shop.ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [unwrap(rejected.body).id])).status).toBe("draft");

    await shop.ctx.db.run("UPDATE stock_source_lots SET quantity = 1 WHERE id = ?", [mine[1].source_lot_id]);
    const stockBefore = Number((await snapshot(shop.ctx.db, product.id)).stock);
    const stale = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created.body).id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(stale.status).toBe(400);
    expect(codeOf(stale)).toBe("STALE_RETURN_QTY");
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(stockBefore);
    expect((await shop.ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [unwrap(created.body).id])).status).toBe("draft");
    const firstLot = await shop.ctx.db.get("SELECT quantity FROM stock_source_lots WHERE id = ?", [mine[0].source_lot_id]);
    expect(Number(firstLot.quantity)).toBe(4);
  });

  test("supermarket and bakery scopes stay separate", async () => {
    const retail = await makeProduct(shop.ctx, "سكر", "retail");
    const bakery = await makeProduct(shop.ctx, "طحين مخبز", "bakery");
    await receive(shop, shop.supplierA, retail.id, [{ quantity: 2, total_cost: 8, expiry_date: null }]);
    await receive(shop, shop.supplierA, bakery.id, [{ quantity: 2, total_cost: 6, expiry_date: null }]);
    await transferLots(shop, [
      ...(await lotsOf(shop.ctx.db, retail.id, shop.main.id, shop.supplierA)),
      ...(await lotsOf(shop.ctx.db, bakery.id, shop.main.id, shop.supplierA)),
    ]);
    const market = await listReturns(shop, { supplier_id: shop.supplierA, limit: "all", q: "سكر" });
    const oven = await listReturns(shop, { supplier_id: shop.supplierA, membership: "bakery", limit: "all", q: "طحين" });
    const marketAll = await listReturns(shop, { supplier_id: shop.supplierA, limit: "all" });
    expect(market.rows.some((row) => row.product_id === retail.id)).toBe(true);
    expect(market.rows.some((row) => row.product_id === bakery.id)).toBe(false);
    expect(oven.rows.some((row) => row.product_id === bakery.id)).toBe(true);
    expect(oven.rows.some((row) => row.product_id === retail.id)).toBe(false);
    expect(marketAll.rows.some((row) => row.product_id === bakery.id)).toBe(false);
    expect(oven.rows[0].batch_source).toBe("undated");
    expect(oven.rows[0].expiry_date).toBeNull();
  });
});

async function warehouseQty(db, warehouseId, productId) {
  const row = await db.get(
    "SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
    [warehouseId, productId]
  );
  return Number(row?.quantity) || 0;
}

async function sourceQty(db, productId, warehouseId, supplierId) {
  const rows = await lotsOf(db, productId, warehouseId, supplierId);
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function supplierBalance(db, supplierId) {
  return Number((await db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
}

describe("persisted return price versus supplier balance", () => {
  let shop;

  beforeAll(async () => {
    shop = await buildShop();
    const tax = await request(shop.ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(shop.adminToken))
      .send({ default_tax_rate: 0 });
    expect(tax.status).toBe(200);
    expect(Number(unwrap(tax.body).default_tax_rate)).toBe(0);
  });

  afterAll(async () => {
    await closeShop(shop);
  });

  test("returning 2 of a ₪4 receipt saves quantity 2, unit ₪4, line ₪8, and reduces the balance by ₪8", async () => {
    const product = await makeProduct(shop.ctx, "حليب السعر");
    await receive(shop, shop.supplierA, product.id, [{ quantity: 5, total_cost: 20, expiry_date: SAME }]);
    await receive(shop, shop.supplierB, product.id, [{ quantity: 10, total_cost: 60, expiry_date: SAME }]);
    const aLot = (await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierA))[0];
    const bLot = (await lotsOf(shop.ctx.db, product.id, shop.main.id, shop.supplierB))[0];
    await transferLots(shop, [aLot, bLot]);

    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(15);
    expect(await warehouseQty(shop.ctx.db, shop.main.id, product.id)).toBe(0);
    expect(await warehouseQty(shop.ctx.db, shop.returnsWh.id, product.id)).toBe(15);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierA)).toBe(5);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierB)).toBe(10);
    expect(await supplierBalance(shop.ctx.db, shop.supplierA)).toBe(20);
    expect(await supplierBalance(shop.ctx.db, shop.supplierB)).toBe(60);

    const returnsLot = (await lotsOf(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierA))[0];
    const created = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierA,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 2,
          total_cost: 8,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: returnsLot.id,
        }],
      });
    expect(created.status).toBe(201);
    const draft = unwrap(created.body);
    const draftItem = await shop.ctx.db.get(
      "SELECT quantity, unit_cost, total_cost, line_total, source_lot_id FROM purchase_return_items WHERE return_id = ?",
      [draft.id]
    );
    expect(Number(draftItem.quantity)).toBe(2);
    expect(Number(draftItem.unit_cost)).toBe(4);
    expect(Number(draftItem.total_cost)).toBe(8);
    expect(Number(draftItem.line_total)).toBe(8);
    expect(Number(draftItem.source_lot_id)).toBe(returnsLot.id);
    expect(Number((await shop.ctx.db.get("SELECT total, status FROM purchase_returns WHERE id = ?", [draft.id])).total)).toBe(8);
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(15);
    expect(await supplierBalance(shop.ctx.db, shop.supplierA)).toBe(20);
    expect(await supplierBalance(shop.ctx.db, shop.supplierB)).toBe(60);

    const posted = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${draft.id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(posted.status).toBe(200);
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(13);
    expect(await warehouseQty(shop.ctx.db, shop.main.id, product.id)).toBe(0);
    expect(await warehouseQty(shop.ctx.db, shop.returnsWh.id, product.id)).toBe(13);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierA)).toBe(3);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierB)).toBe(10);
    expect(await supplierBalance(shop.ctx.db, shop.supplierA)).toBe(12);
    expect(await supplierBalance(shop.ctx.db, shop.supplierB)).toBe(60);

    const allocation = await shop.ctx.db.get(
      `SELECT quantity, source_lot_id, supplier_id, direction, reference_type
         FROM stock_batch_allocations
        WHERE reference_type = 'purchase_return' AND reference_id = ?`,
      [draft.id]
    );
    expect(Number(allocation.quantity)).toBe(2);
    expect(Number(allocation.source_lot_id)).toBe(returnsLot.id);
    expect(Number(allocation.supplier_id)).toBe(shop.supplierA);
    expect(allocation.direction).toBe("out");

    const ledger = await shop.ctx.db.get(
      `SELECT movement_type, quantity_delta, qty_before, qty_after, reference_type, warehouse_id
         FROM inventory_ledger
        WHERE reference_type = 'purchase_return' AND reference_id = ?`,
      [draft.id]
    );
    expect(Number(ledger.quantity_delta)).toBe(-2);
    expect(Number(ledger.qty_before)).toBe(15);
    expect(Number(ledger.qty_after)).toBe(13);
    expect(Number(ledger.warehouse_id)).toBe(shop.returnsWh.id);
    expect(ledger.reference_type).toBe("purchase_return");

    const statement = await shop.ctx.db.get(
      "SELECT total, status FROM purchase_returns WHERE id = ?",
      [draft.id]
    );
    expect(statement.status).toBe("posted");
    expect(Number(statement.total)).toBe(8);

    const retry = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${draft.id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(retry.status).toBe(400);
    expect(codeOf(retry)).toBe("ALREADY_POSTED");
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(13);
    expect(await supplierBalance(shop.ctx.db, shop.supplierA)).toBe(12);
    expect(await supplierBalance(shop.ctx.db, shop.supplierB)).toBe(60);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, shop.supplierA)).toBe(3);
  });

  test("returning 2 of an ₪8 receipt saves line ₪16 and reduces the balance by ₪16", async () => {
    const supplier = (await shop.ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد ثمانية', 'RET-8', 0, 0)"
    )).lastID;
    const product = await makeProduct(shop.ctx, "حليب ثمانية");
    await receive(shop, supplier, product.id, [{ quantity: 5, total_cost: 40, expiry_date: SAME }]);
    expect(await supplierBalance(shop.ctx.db, supplier)).toBe(40);
    const before = 40;
    const lot = (await lotsOf(shop.ctx.db, product.id, shop.main.id, supplier))[0];
    await transferLots(shop, [lot]);
    const returnsLot = (await lotsOf(shop.ctx.db, product.id, shop.returnsWh.id, supplier))[0];
    const created = await request(shop.ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: supplier,
        return_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 2,
          total_cost: 16,
          expiry_date: SAME,
          batch_source: "dated",
          source_lot_id: returnsLot.id,
        }],
      });
    expect(created.status).toBe(201);
    const draft = unwrap(created.body);
    const item = await shop.ctx.db.get(
      "SELECT quantity, unit_cost, total_cost, line_total FROM purchase_return_items WHERE return_id = ?",
      [draft.id]
    );
    expect(Number(item.quantity)).toBe(2);
    expect(Number(item.unit_cost)).toBe(8);
    expect(Number(item.total_cost)).toBe(16);
    expect(Number(item.line_total)).toBe(16);
    expect(await supplierBalance(shop.ctx.db, supplier)).toBe(before);
    const posted = await request(shop.ctx.app)
      .post(`/api/v1/purchases/returns/${draft.id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    expect(posted.status).toBe(200);
    expect(Number((await shop.ctx.db.get("SELECT total FROM purchase_returns WHERE id = ?", [draft.id])).total)).toBe(16);
    expect(await supplierBalance(shop.ctx.db, supplier)).toBe(24);
    expect(await sourceQty(shop.ctx.db, product.id, shop.returnsWh.id, supplier)).toBe(3);
    expect(Number((await snapshot(shop.ctx.db, product.id)).stock)).toBe(3);
  });
});
