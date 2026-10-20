/**
 * Connected shop scenarios on a disposable database.
 * Expected quantities and money are calculated from the documents below,
 * not by calling the costing or allocation functions under test.
 *
 * Lots are keyed by expiry date. Outbound selection is earliest expiry
 * first (FEFO), then undated stock. Product cost is a weighted average
 * rounded to the agora when it is saved, and sales keep that unit cost.
 * POS payable rounding is separate: remainder 1–49 agorot drops, 50 stays,
 * 51–99 goes up.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { listStockBatches } from "../services/stockBatchService.js";
import { fetchNearExpiryItems } from "../services/expiryAlertService.js";
import { deriveStockFromLedger } from "../utils/inventoryLedger.js";
import { recordMovement } from "../utils/inventory.js";
import { withTransaction } from "../utils/dbTx.js";
import { updateAppSettings } from "../utils/settings.js";
import { addShopDays, shopTodayYmd, shopYmdToUtcBounds } from "../utils/shopTime.js";
import { businessDayFromTimestamp } from "../utils/businessDay.js";

function unwrap(body) {
  return body?.data ?? body;
}

function qtyOf(listed, expiry) {
  const row = listed.rows.find((r) => r.expiry_date === expiry);
  return row ? Number(row.quantity) : 0;
}

describe("shop scenarios — disposable database", () => {
  let ctx;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("the database file is a temp test file, not the shop database", () => {
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath).toMatch(/test\.db$/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket\.db/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/[\\/]data[\\/]/);
  });
});

describe("batch, expiry, and cost scenarios", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let customerId;
  let seq = 0;
  const sentinel = { id: null, stock: 7 };

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد سيناريو', 'S-SC', 0, 0)`
    );
    supplierId = sup.lastID;
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('زبون سيناريو', 'C-SC', 0, 0)`
    );
    customerId = cust.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(shift.status).toBe(201);
    const other = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('88000000', 'صنف آخر', 3, 1, 'Test', 7)`
    );
    sentinel.id = other.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  afterEach(async () => {
    const row = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [sentinel.id]);
    expect(Number(row.stock)).toBe(sentinel.stock);
  });

  async function makeProduct({ name = "صنف دفعات", price = 8, cost = 0, stock = 0, category = "Test", unit = "حبة", conversion = 1 } = {}) {
    seq += 1;
    const barcode = `88${String(seq).padStart(6, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [barcode, name, price, cost, category, stock]
    );
    await ctx.db.run(
      `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)`,
      [ins.lastID, barcode]
    );
    const unitIns = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [ins.lastID, unit, barcode, price, cost, conversion]
    );
    return { id: ins.lastID, barcode, unitId: unitIns.lastID };
  }

  async function postPurchase(items, invoiceDate = "2026-10-01") {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, invoice_date: invoiceDate, items });
    return created;
  }

  async function postDraft(created) {
    expect(created.status).toBe(201);
    const id = unwrap(created.body).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    return { id, invoice: unwrap(posted.body), draft: unwrap(created.body) };
  }

  async function receiveSeparatedLots() {
    const today = shopTodayYmd();
    const expiryA = addShopDays(today, 30);
    const expiryB = addShopDays(today, 10);
    const product = await makeProduct();
    const before = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    const first = await postDraft(
      await postPurchase([{ product_id: product.id, quantity: 10, total_cost: 40, expiry_date: expiryA }])
    );
    const mid = await listStockBatches(ctx.db, product.id);
    const second = await postDraft(
      await postPurchase([{ product_id: product.id, quantity: 8, total_cost: 40, expiry_date: expiryB }])
    );
    const after = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    return { product, expiryA, expiryB, first, second, supplierDelta: after - before, mid };
  }

  async function sell(productId, quantity, extra = {}) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: extra.price ?? 8 }],
        payment_method: extra.payment_method || "cash",
        ...extra.body,
      }, extra.key));
    return res;
  }

  test("two receipts keep separate expiries, 18 units, and ₪80 of merchandise", async () => {
    const { product, expiryA, expiryB, first, second, supplierDelta, mid } = await receiveSeparatedLots();
    expect(expiryA > expiryB).toBe(true);
    expect(Number(first.draft.total)).toBe(40);
    expect(Number(first.draft.vat)).toBe(0);
    expect(Number(second.draft.total)).toBe(40);
    expect(Number(second.draft.vat)).toBe(0);
    expect(qtyOf(mid, expiryA)).toBe(10);
    expect(qtyOf(mid, expiryB)).toBe(0);

    const listed = await listStockBatches(ctx.db, product.id);
    const lotA = listed.rows.find((r) => r.expiry_date === expiryA);
    const lotB = listed.rows.find((r) => r.expiry_date === expiryB);
    expect(lotA.quantity).toBe(10);
    expect(Number(lotA.cost)).toBe(4);
    expect(lotB.quantity).toBe(8);
    expect(Number(lotB.cost)).toBe(5);
    expect(listed.product_stock).toBe(18);
    expect(listed.dated_sum).toBe(18);
    expect(listed.unknown_quantity).toBe(0);

    const saved = await ctx.db.get("SELECT stock, cost, expiry_date FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(18);
    expect(Number(saved.cost)).toBe(4.44);
    expect(saved.expiry_date == null || saved.expiry_date === "").toBe(true);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(18);
    expect(supplierDelta).toBe(80);
    expect(Number(saved.stock) * Number(saved.cost)).toBeCloseTo(79.92, 2);

    const batches = await ctx.db.all(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date",
      [product.id]
    );
    expect(batches).toHaveLength(2);
  });

  test("selling 6 follows the sooner expiry, not the earlier receipt", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const sale = await sell(product.id, 6);
    expect(sale.status).toBe(201);
    const body = unwrap(sale.body);
    expect(body.total).toBe(48);

    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(2);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(listed.product_stock).toBe(12);

    const item = await ctx.db.get(
      "SELECT quantity, unit_price, unit_cost_at_sale, line_net, gross_profit FROM transaction_items WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(Number(item.quantity)).toBe(6);
    expect(Number(item.unit_price)).toBe(8);
    expect(Number(item.unit_cost_at_sale)).toBe(4.44);
    expect(Number(item.line_net)).toBe(48);
    expect(Number(item.gross_profit)).toBe(21.36);

    const alloc = await ctx.db.all(
      `SELECT expiry_date, quantity, direction FROM stock_batch_allocations
        WHERE reference_type = 'transaction' AND reference_id = ? ORDER BY id`,
      [body.transaction_id]
    );
    expect(alloc).toEqual([
      expect.objectContaining({ expiry_date: expiryB, quantity: 6, direction: "out" }),
    ]);
    const pay = await ctx.db.get(
      "SELECT amount FROM sale_payments WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(Number(pay.amount)).toBe(48);
    const drawer = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(Number(drawer.amount)).toBe(48);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(12);
  });

  test("a sale that crosses both lots still costs the average, not the lot costs", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const sale = await sell(product.id, 12);
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(0);
    expect(qtyOf(listed, expiryA)).toBe(6);
    expect(listed.product_stock).toBe(6);

    const alloc = await ctx.db.all(
      `SELECT expiry_date, quantity FROM stock_batch_allocations
        WHERE reference_type = 'transaction' AND reference_id = ? AND direction = 'out'
        ORDER BY expiry_date`,
      [txId]
    );
    expect(alloc.map((r) => ({ expiry_date: r.expiry_date, quantity: Number(r.quantity) }))).toEqual([
      { expiry_date: expiryB, quantity: 8 },
      { expiry_date: expiryA, quantity: 4 },
    ]);
    const item = await ctx.db.get(
      "SELECT unit_cost_at_sale, line_net, gross_profit FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(item.unit_cost_at_sale)).toBe(4.44);
    expect(Number(item.line_net)).toBe(96);
    expect(Number(item.gross_profit)).toBe(42.72);
  });

  test("one invoice with the later expiry entered first still sells the sooner lot", async () => {
    const today = shopTodayYmd();
    const expiryA = addShopDays(today, 30);
    const expiryB = addShopDays(today, 10);
    const product = await makeProduct();
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 10, total_cost: 40, expiry_date: expiryA },
      { product_id: product.id, quantity: 8, total_cost: 40, expiry_date: expiryB },
    ]));
    const sale = await sell(product.id, 6);
    expect(sale.status).toBe(201);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(2);
    expect(qtyOf(listed, expiryA)).toBe(10);
    const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(12);
    expect(Number(saved.cost)).toBe(4.44);
  });

  test("a partial refund puts units back on the lot that was sold", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const sale = await sell(product.id, 6);
    const txId = unwrap(sale.body).transaction_id;
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 2 }],
        payment_method: "cash",
        idempotency_key: `refund-lot-${product.id}-aaaa`,
      });
    expect(created.status).toBe(201);
    const mid = await listStockBatches(ctx.db, product.id);
    expect(mid.product_stock).toBe(12);
    expect(qtyOf(mid, expiryB)).toBe(2);

    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(14);
    expect(qtyOf(listed, expiryB)).toBe(4);
    expect(qtyOf(listed, expiryA)).toBe(10);
    const dates = await ctx.db.all(
      "SELECT DISTINCT expiry_date FROM product_batches WHERE product_id = ?",
      [product.id]
    );
    expect(dates.map((r) => r.expiry_date).sort()).toEqual([expiryA, expiryB].sort());
    const item = await ctx.db.get(
      "SELECT unit_cost_at_sale, gross_profit, line_net FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(item.unit_cost_at_sale)).toBe(4.44);
    expect(Number(item.line_net)).toBe(48);
    expect(Number(item.gross_profit)).toBe(21.36);
    const cost = await ctx.db.get("SELECT cost FROM products WHERE id = ?", [product.id]);
    expect(Number(cost.cost)).toBe(4.44);
    const refund = await ctx.db.get(
      "SELECT total FROM refunds WHERE original_transaction_id = ? AND status = 'approved'",
      [txId]
    );
    expect(Number(refund.total)).toBe(16);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(14);
  });

  test("refund quantity cannot exceed the units still eligible", async () => {
    const { product } = await receiveSeparatedLots();
    const sale = await sell(product.id, 6);
    const txId = unwrap(sale.body).transaction_id;
    async function ask(qty, key) {
      return request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: txId,
          lines: [{ product_id: product.id, quantity: qty }],
          payment_method: "cash",
          idempotency_key: key,
        });
    }
    const first = await ask(4, `refund-cap-a-${product.id}`);
    expect(first.status).toBe(201);
    await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(first.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    const second = await ask(3, `refund-cap-b-${product.id}`);
    expect(second.status).toBeGreaterThanOrEqual(400);
    const stock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    expect(stock).toBe(16);
    const refunded = await ctx.db.get(
      "SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE original_transaction_id = ? AND status = 'approved'",
      [txId]
    );
    expect(Number(refunded.s)).toBe(32);
  });

  test("supplier return of the sooner lot reduces that lot and the supplier balance", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
    const main = warehouses.find((w) => w.type === "main");
    const returnsWh = warehouses.find((w) => w.type === "returns");
    const move = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 3, expiry_date: expiryB, batch_source: "dated" }],
      });
    expect(move.status).toBe(201);
    const moved = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(move.body).id}/post`)
      .set(authHeader(adminToken));
    expect(moved.status).toBe(200);
    const balBefore = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: "2026-10-02",
        items: [{ product_id: product.id, quantity: 3, total_cost: 15, expiry_date: expiryB }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(5);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(listed.product_stock).toBe(15);
    const saved = await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(15);
    expect(Number(saved.cost)).toBe(4.33);
    const balAfter = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    expect(balAfter - balBefore).toBe(-15);
    const sales = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transactions t JOIN transaction_items ti ON ti.transaction_id = t.id WHERE ti.product_id = ?",
      [product.id]
    );
    expect(Number(sales.n)).toBe(0);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(15);
  });

  test("a return larger than the quantity in مرتجعات is rejected and stock stays unchanged", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const balBefore = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: "2026-10-02",
        items: [{ product_id: product.id, quantity: 30, total_cost: 150, expiry_date: expiryB }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(400);
    const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(18);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(8);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(18);
    const balAfter = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    expect(balAfter).toBe(balBefore);
    const postedReturn = await ctx.db.get(
      "SELECT status FROM purchase_returns WHERE id = ?",
      [unwrap(created.body).id]
    );
    expect(postedReturn.status).not.toBe("posted");
  });

  test("a warehouse transfer keeps company stock and does not retag lots", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
    const main = warehouses.find((w) => w.type === "main");
    const returnsWh = warehouses.find((w) => w.type === "returns");
    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 4 }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    const saved = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(18);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(qtyOf(listed, expiryB)).toBe(8);
    const lines = unwrap((await request(ctx.app).get("/api/v1/warehouses/stock").set(authHeader(adminToken))).body);
    const mainQty = lines
      .filter((row) => Number(row.product_id) === product.id && Number(row.warehouse_id) === main.id)
      .reduce((s, row) => s + Number(row.quantity), 0);
    const storeQty = lines
      .filter((row) => Number(row.product_id) === product.id && Number(row.warehouse_id) === returnsWh.id)
      .reduce((s, row) => s + Number(row.quantity), 0);
    expect(mainQty).toBe(14);
    expect(storeQty).toBe(4);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(18);
    const ledgerTransfers = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM inventory_ledger
        WHERE product_id = ? AND movement_type IN ('warehouse_transfer_in', 'warehouse_transfer_out')`,
      [product.id]
    );
    expect(Number(ledgerTransfers.n)).toBe(0);
  });

  test("damage of the earlier lot reduces that lot and leaves the later lot", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const txBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);
    const doc = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        document_date: "2026-10-03",
        reason: "damaged",
        items: [{
          product_id: product.id,
          quantity: 2,
          unit_id: product.unitId,
          batch_source: "dated",
          expiry_date: expiryB,
        }],
      });
    expect(doc.status).toBe(201);
    const saved = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(16);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(qtyOf(listed, expiryB)).toBe(6);
    expect(listed.dated_sum).toBe(16);
    expect(listed.unknown_quantity).toBe(0);
    const ledger = await ctx.db.get(
      `SELECT movement_type, quantity_delta FROM inventory_ledger
        WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [product.id]
    );
    expect(ledger.movement_type).toBe("manual_adjustment");
    expect(Number(ledger.quantity_delta)).toBe(-2);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(txBefore);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(16);
  });

  test("damage from the earlier lot, then a sale and a refund, keeps the later lot intact", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const allocBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_batch_allocations WHERE product_id = ?",
      [product.id]
    )).n);

    const doc = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        document_date: "2026-10-03",
        reason: "damaged",
        items: [{
          product_id: product.id,
          quantity: 2,
          unit_id: product.unitId,
          batch_source: "dated",
          expiry_date: expiryB,
        }],
      });
    expect(doc.status).toBe(201);
    const damaged = await listStockBatches(ctx.db, product.id);
    expect(damaged.product_stock).toBe(16);
    expect(qtyOf(damaged, expiryA)).toBe(10);
    expect(qtyOf(damaged, expiryB)).toBe(6);
    expect(damaged.dated_sum).toBe(16);
    expect(damaged.unknown_quantity).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_batch_allocations WHERE product_id = ?",
      [product.id]
    )).n)).toBe(allocBefore + 1);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(16);

    const sale = await sell(product.id, 4, { key: `after-damage-${product.id}-aaaa` });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const sold = await listStockBatches(ctx.db, product.id);
    expect(sold.product_stock).toBe(12);
    expect(qtyOf(sold, expiryB)).toBe(2);
    expect(qtyOf(sold, expiryA)).toBe(10);
    expect(sold.dated_sum).toBe(12);
    expect(sold.unknown_quantity).toBe(0);
    const out = await ctx.db.get(
      `SELECT expiry_date, quantity FROM stock_batch_allocations
        WHERE reference_type = 'transaction' AND reference_id = ? AND direction = 'out'`,
      [txId]
    );
    expect(out.expiry_date).toBe(expiryB);
    expect(Number(out.quantity)).toBe(4);

    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        idempotency_key: `after-damage-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const restored = await listStockBatches(ctx.db, product.id);
    expect(restored.product_stock).toBe(13);
    expect(qtyOf(restored, expiryB)).toBe(3);
    expect(qtyOf(restored, expiryA)).toBe(10);
    expect(restored.dated_sum).toBe(13);
    expect(restored.unknown_quantity).toBe(0);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(13);
    const back = await ctx.db.get(
      `SELECT expiry_date, quantity FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'refund' AND direction = 'in'
        ORDER BY id DESC LIMIT 1`,
      [product.id]
    );
    expect(back.expiry_date).toBe(expiryB);
    expect(Number(back.quantity)).toBe(1);
  });

  test("a signed correction changes only the named lot, then a sale and refund follow that lot", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const down = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "correction",
        adjustment_date: "2026-10-03",
        post: true,
        items: [{ product_id: product.id, quantity: -2, batch_source: "dated", expiry_date: expiryB }],
      });
    expect(down.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(16);
    expect(qtyOf(listed, expiryB)).toBe(6);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(listed.unknown_quantity).toBe(0);

    const up = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "correction",
        adjustment_date: "2026-10-03",
        post: true,
        items: [{ product_id: product.id, quantity: 1, batch_source: "dated", expiry_date: expiryB }],
      });
    expect(up.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(17);
    expect(qtyOf(listed, expiryB)).toBe(7);
    expect(qtyOf(listed, expiryA)).toBe(10);

    const sale = await sell(product.id, 4, { key: `after-correction-${product.id}-aaaa` });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(13);
    expect(qtyOf(listed, expiryB)).toBe(3);
    expect(qtyOf(listed, expiryA)).toBe(10);

    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        idempotency_key: `after-correction-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(14);
    expect(qtyOf(listed, expiryB)).toBe(4);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(listed.dated_sum).toBe(14);
    expect(listed.unknown_quantity).toBe(0);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(14);
  });

  test("advancing the shop clock expires only the sooner lot and leaves its quantity", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const later = addShopDays(shopTodayYmd(), 15);
    const probe = new Date(new Date(shopYmdToUtcBounds(later).startIso).getTime() + 3 * 3600 * 1000);
    jest.useFakeTimers({
      now: probe,
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
    });
    try {
      expect(shopTodayYmd()).toBe(later);
      const listed = await listStockBatches(ctx.db, product.id);
      const lotA = listed.rows.find((r) => r.expiry_date === expiryA);
      const lotB = listed.rows.find((r) => r.expiry_date === expiryB);
      expect(lotB.status).toBe("expired");
      expect(lotB.quantity).toBe(8);
      expect(lotA.status).not.toBe("expired");
      expect(lotA.quantity).toBe(10);
      expect(listed.product_stock).toBe(18);
    } finally {
      jest.useRealTimers();
    }
  });

  test("expired stock stays on hand and is excluded from sale until it is moved", async () => {
    const product = await makeProduct();
    const created = await postPurchase([
      { product_id: product.id, quantity: 4, total_cost: 16, expiry_date: "2020-01-15" },
    ]);
    expect(created.status).toBe(201);
    await postDraft(created);
    const before = await listStockBatches(ctx.db, product.id);
    expect(before.rows.find((r) => r.expiry_date === "2020-01-15").status).toBe("expired");
    expect(before.product_stock).toBe(4);
    const sale = await sell(product.id, 1);
    expect(sale.status).toBe(201);
    const after = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(after, "2020-01-15")).toBe(4);
    expect(after.product_stock).toBe(3);
    const sales = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?",
      [product.id]
    );
    expect(Number(sales.n)).toBe(1);
  });

  test("the same expiry adds quantity onto one lot and product cost stays weighted", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 4, total_cost: 24, expiry_date: expiryB },
    ]));
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(12);
    expect(qtyOf(listed, expiryA)).toBe(10);
    const rows = await ctx.db.all(
      "SELECT id, cost, quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, expiryB]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(12);
    expect(Number(rows[0].cost)).toBe(6);
    const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(22);
    expect(Number(saved.cost)).toBe(4.72);
  });

  test("a receipt without an expiry increases undated stock only", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 5, total_cost: 15 },
    ]));
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(qtyOf(listed, expiryB)).toBe(8);
    expect(listed.unknown_quantity).toBe(5);
    expect(listed.product_stock).toBe(23);
    const dated = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM product_batches
        WHERE product_id = ? AND (expiry_date IS NULL OR TRIM(expiry_date) = '')`,
      [product.id]
    );
    expect(Number(dated.n)).toBe(0);
  });

  test("an impossible or unreadable expiry is rejected and posts no stock", async () => {
    const product = await makeProduct();
    for (const expiry of ["2026-02-31", "not-a-date", "2026-13-01"]) {
      const created = await postPurchase([
        { product_id: product.id, quantity: 3, total_cost: 9, expiry_date: expiry },
      ]);
      expect(created.status).toBe(400);
    }
    const stock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    expect(stock).toBe(0);
    const lots = await ctx.db.get("SELECT COUNT(*) AS n FROM product_batches WHERE product_id = ?", [product.id]);
    expect(Number(lots.n)).toBe(0);
  });

  test("the office expiry report does not list batch dates stored only on lots", async () => {
    const { product, expiryB } = await receiveSeparatedLots();
    const report = await request(ctx.app)
      .get("/api/v1/inventory/expiry")
      .query({ days: 60 })
      .set(authHeader(adminToken));
    expect(report.status).toBe(200);
    const rows = unwrap(report.body);
    const list = Array.isArray(rows) ? rows : rows.items || rows.products || [];
    expect(list.some((row) => Number(row.id) === product.id)).toBe(false);
    const alerts = await fetchNearExpiryItems(ctx.db, 40);
    expect(alerts.batches.some((row) => row.expiry_date === expiryB && row.barcode === product.barcode)).toBe(true);
  });

  test("an unposted purchase can be corrected and a posted one cannot", async () => {
    const product = await makeProduct();
    const expiry = addShopDays(shopTodayYmd(), 20);
    const created = await postPurchase([
      { product_id: product.id, quantity: 2, total_cost: 8, expiry_date: expiry },
    ]);
    expect(created.status).toBe(201);
    const id = unwrap(created.body).id;
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(0);
    const edited = await request(ctx.app)
      .put(`/api/v1/purchases/invoices/${id}`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: "2026-10-01",
        items: [{ product_id: product.id, quantity: 5, total_cost: 20, expiry_date: expiry }],
      });
    expect(edited.status).toBe(200);
    expect(Number(unwrap(edited.body).total)).toBe(20);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(0);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(5);
    const again = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(again.status).toBe(400);
    const locked = await request(ctx.app)
      .put(`/api/v1/purchases/invoices/${id}`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: product.id, quantity: 9, total_cost: 27, expiry_date: expiry }],
      });
    expect(locked.status).toBe(400);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(5);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(5);
  });

  test("replaying a checkout does not move stock or cash a second time", async () => {
    const { product, expiryB } = await receiveSeparatedLots();
    const key = `batch-replay-${product.id}`;
    const body = withCheckoutKey({
      items: [{ product_id: product.id, quantity: 6, price: 8 }],
      payment_method: "cash",
    }, key);
    const first = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    const second = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(unwrap(second.body).transaction_id).toBe(unwrap(first.body).transaction_id);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(12);
    expect(qtyOf(listed, expiryB)).toBe(2);
    const pays = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM sale_payments WHERE transaction_id = ?",
      [unwrap(first.body).transaction_id]
    );
    expect(Number(pays.n)).toBe(1);
  });

  test("selling the last units then overselling matches the ledger, and the office invoice stops", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const exact = await sell(product.id, 18);
    expect(exact.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(0);
    expect(qtyOf(listed, expiryA)).toBe(0);
    expect(qtyOf(listed, expiryB)).toBe(0);
    expect(listed.unknown_quantity).toBe(0);

    const over = await sell(product.id, 2);
    expect(over.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(-2);
    expect(qtyOf(listed, expiryA)).toBe(0);
    expect(qtyOf(listed, expiryB)).toBe(0);
    expect(listed.unknown_quantity).toBe(-2);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(-2);

    const fresh = await makeProduct();
    await postDraft(await postPurchase([
      { product_id: fresh.id, quantity: 1, total_cost: 4, expiry_date: addShopDays(shopTodayYmd(), 12) },
    ]));
    const draft = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        invoice_date: "2026-10-04",
        items: [{ product_id: fresh.id, quantity: 3, total_price: 24 }],
      });
    expect(draft.status).toBe(201);
    const office = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(office.status).toBe(400);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [fresh.id])).stock)).toBe(1);
  });

  test("two checkouts of the last unit both persist and the ledger matches the final stock", async () => {
    const product = await makeProduct({ price: 8 });
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 1, total_cost: 4 },
    ]));
    const [a, b] = await Promise.all([
      sell(product.id, 1, { key: `last-a-${product.id}-xxxx` }),
      sell(product.id, 1, { key: `last-b-${product.id}-yyyy` }),
    ]);
    const ok = [a, b].filter((res) => res.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const stock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    expect(stock).toBe(1 - ok.length);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(stock);
    const txs = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM transactions t
         JOIN transaction_items ti ON ti.transaction_id = t.id
        WHERE ti.product_id = ?`,
      [product.id]
    );
    expect(Number(txs.n)).toBe(ok.length);
  });

  test("a weighed sale consumes a fractional quantity from the sooner lot", async () => {
    const today = shopTodayYmd();
    const expiryA = addShopDays(today, 30);
    const expiryB = addShopDays(today, 10);
    const product = await makeProduct({ unit: "كغم", price: 8 });
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 2.5, total_cost: 10, expiry_date: expiryA },
      { product_id: product.id, quantity: 1.5, total_cost: 9, expiry_date: expiryB },
    ]));
    const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBeCloseTo(4, 6);
    expect(Number(saved.cost)).toBe(4.75);
    const sale = await sell(product.id, 0.5);
    expect(sale.status).toBe(201);
    expect(unwrap(sale.body).total).toBe(4);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBeCloseTo(1, 6);
    expect(qtyOf(listed, expiryA)).toBeCloseTo(2.5, 6);
    expect(listed.product_stock).toBeCloseTo(3.5, 6);
    const item = await ctx.db.get(
      "SELECT unit_cost_at_sale, gross_profit, line_net FROM transaction_items WHERE transaction_id = ?",
      [unwrap(sale.body).transaction_id]
    );
    expect(Number(item.line_net)).toBe(4);
    expect(Number(item.unit_cost_at_sale)).toBe(4.75);
    expect(Number(item.gross_profit)).toBe(1.63);
  });

  test("a purchase in a larger unit receives base units on the lot", async () => {
    const product = await makeProduct();
    const carton = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'كرتون', ?, 48, 24, 6, 0)`,
      [product.id, `${product.barcode}-C`]
    );
    const expiry = addShopDays(shopTodayYmd(), 40);
    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 2, unit_id: carton.lastID, total_cost: 48, expiry_date: expiry },
    ]));
    const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(12);
    expect(Number(saved.cost)).toBe(4);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiry)).toBe(12);
  });

  test("a complete count down to 16 reduces the earlier lot and the company stock", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ notes: "جرد سيناريو", department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const line = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: expiryA, counted_qty: 10 },
          { batch_source: "dated", expiry_date: expiryB, counted_qty: 6 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(line.status).toBe(200);
    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const saved = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(16);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(qtyOf(listed, expiryB)).toBe(6);
    expect(listed.unknown_quantity).toBe(0);
    const ledger = await ctx.db.get(
      `SELECT movement_type, quantity_delta FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'stock_count_correction'`,
      [product.id]
    );
    expect(Number(ledger.quantity_delta)).toBe(-2);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(16);
  });

  test("a count that lowers the earlier lot, then a sale and a refund, keeps the later lot intact", async () => {
    const { product, expiryA, expiryB } = await receiveSeparatedLots();
    const allocBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_batch_allocations WHERE product_id = ?",
      [product.id]
    )).n);
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ notes: "جرد بعد الاستلام", department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const line = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: expiryA, counted_qty: 10 },
          { batch_source: "dated", expiry_date: expiryB, counted_qty: 6 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(line.status).toBe(200);
    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);

    const counted = await listStockBatches(ctx.db, product.id);
    expect(counted.product_stock).toBe(16);
    expect(qtyOf(counted, expiryA)).toBe(10);
    expect(qtyOf(counted, expiryB)).toBe(6);
    expect(counted.dated_sum).toBe(16);
    expect(counted.unknown_quantity).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_batch_allocations WHERE product_id = ?",
      [product.id]
    )).n)).toBe(allocBefore + 1);

    const sale = await sell(product.id, 4, { key: `after-count-${product.id}-aaaa` });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const sold = await listStockBatches(ctx.db, product.id);
    expect(sold.product_stock).toBe(12);
    expect(qtyOf(sold, expiryB)).toBe(2);
    expect(qtyOf(sold, expiryA)).toBe(10);
    expect(sold.unknown_quantity).toBe(0);

    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        idempotency_key: `after-count-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const restored = await listStockBatches(ctx.db, product.id);
    expect(restored.product_stock).toBe(13);
    expect(qtyOf(restored, expiryB)).toBe(3);
    expect(qtyOf(restored, expiryA)).toBe(10);
    expect(restored.dated_sum).toBe(13);
    expect(restored.unknown_quantity).toBe(0);
    expect(await deriveStockFromLedger(ctx.db, product.id)).toBe(13);
  });

  test("weighted-average rounding leaves a tracked gap between purchases, cost, and stock value", async () => {
    const today = shopTodayYmd();
    const expiryA = addShopDays(today, 30);
    const expiryB = addShopDays(today, 10);
    const expiryC = addShopDays(today, 20);
    const product = await makeProduct({ price: 8, cost: 0 });

    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 10, total_cost: 40, expiry_date: expiryA },
    ]));
    let saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(10);
    expect(Number(saved.cost)).toBe(4);
    expect(Number(saved.stock) * Number(saved.cost)).toBe(40);

    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 8, total_cost: 40, expiry_date: expiryB },
    ]));
    saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(18);
    expect(Number(saved.cost)).toBe(4.44);
    const afterSecond = Number(saved.stock) * Number(saved.cost);
    expect(afterSecond).toBe(79.92);
    expect(80 - afterSecond).toBeCloseTo(0.08, 2);

    const sale = await sell(product.id, 7, { key: `wac-gap-${product.id}-aaaa` });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const soldItem = await ctx.db.get(
      "SELECT unit_cost_at_sale, quantity FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(soldItem.unit_cost_at_sale)).toBe(4.44);
    const agora = (n) => Math.round(n * 100) / 100;
    const recognized = agora(7 * 4.44);
    expect(recognized).toBe(31.08);
    saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(11);
    expect(Number(saved.cost)).toBe(4.44);
    const afterSale = agora(11 * 4.44);
    expect(afterSale).toBe(48.84);
    expect(agora(80 - recognized - afterSale)).toBe(0.08);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(listed, expiryB)).toBe(1);
    expect(qtyOf(listed, expiryA)).toBe(10);

    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 3 }],
        payment_method: "cash",
        idempotency_key: `wac-gap-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const netRecognized = agora(31.08 - agora(3 * 4.44));
    expect(netRecognized).toBe(17.76);
    saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(14);
    expect(Number(saved.cost)).toBe(4.44);
    const afterRefund = agora(14 * 4.44);
    expect(afterRefund).toBe(62.16);
    expect(agora(80 - netRecognized - afterRefund)).toBe(0.08);
    const restored = await listStockBatches(ctx.db, product.id);
    expect(qtyOf(restored, expiryB)).toBe(4);
    expect(qtyOf(restored, expiryA)).toBe(10);

    await postDraft(await postPurchase([
      { product_id: product.id, quantity: 6, total_cost: 33, expiry_date: expiryC },
    ]));
    saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(20);
    expect(Number(saved.cost)).toBe(4.76);
    const remaining = agora(20 * 4.76);
    expect(remaining).toBe(95.2);
    const purchases = 40 + 40 + 33;
    expect(agora(purchases - netRecognized - remaining)).toBe(0.04);
    const firstLine = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(firstLine.unit_cost_at_sale)).toBe(4.44);
  });

  test("a stock write that fails midway leaves stock and the ledger unchanged", async () => {
    const product = await makeProduct({ stock: 5, cost: 2 });
    const ledgerBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [product.id]
    )).n);
    await expect(withTransaction(ctx.db, async () => {
      await recordMovement(ctx.db, {
        productId: product.id,
        movementType: "sale",
        quantity: -2,
        refType: "transaction",
        refId: 1,
        notes: "فشل متعمد",
        applyStock: true,
      });
      throw new Error("posting failed");
    })).rejects.toThrow("posting failed");
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(5);
    const ledgerAfter = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [product.id]
    )).n);
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  test("inclusive purchase VAT keeps merchandise net separate from the payable used as cost", async () => {
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0.16')");
    try {
      const product = await makeProduct();
      const created = await postPurchase([
        { product_id: product.id, quantity: 10, total_cost: 92.8, vat_rate: 0.16 },
      ]);
      expect(created.status).toBe(201);
      const draft = unwrap(created.body);
      expect(Number(draft.subtotal)).toBe(80);
      expect(Number(draft.vat)).toBe(12.8);
      expect(Number(draft.total)).toBe(92.8);
      await postDraft(created);
      const saved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
      expect(Number(saved.stock)).toBe(10);
      expect(Number(saved.cost)).toBe(9.28);
    } finally {
      await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    }
  });
});

describe("one business day across money, credit, bakery, and the cutoff", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let customerId;
  let milk;
  let bread;
  let roundItem;
  let sentinelId;
  let shiftId;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6, default_opening_cash: 500 });
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد اليوم', 'S-DAY', 0, 0)`
    );
    supplierId = sup.lastID;
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('زبون اليوم', 'C-DAY', 0, 0)`
    );
    customerId = cust.lastID;
    const other = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('88999999', 'بعيد', 1, 1, 'Test', 4)`
    );
    sentinelId = other.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct({ barcode, name, price, cost, category, unit = "حبة" }) {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
      [barcode, name, price, cost, category]
    );
    await ctx.db.run(
      `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)`,
      [ins.lastID, barcode]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [ins.lastID, unit, barcode, price, cost]
    );
    return ins.lastID;
  }

  test("purchases, tenders, credit, bakery, refunds, and the cutoff reconcile", async () => {
    const early = new Date(new Date(shopYmdToUtcBounds("2026-10-05").startIso).getTime() + 2 * 3600 * 1000);
    expect(businessDayFromTimestamp(early.toISOString(), 6)).toBe("2026-10-04");
    // The nearer milk lot expires on 2026-10-14. Allocation uses the shop
    // calendar date, so the whole scenario stays on that morning. Restoring
    // the wall clock would expire the lot and leave its purchased quantity.
    jest.useFakeTimers({
      now: early,
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
    });
    try {
    expect(shopTodayYmd()).toBe("2026-10-05");
    const opened = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(opened.status).toBe(201);
    shiftId = unwrap(opened.body).shift_id ?? unwrap(opened.body).id;
    const shift = await ctx.db.get("SELECT business_day, opening_cash FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(shift.business_day).toBe("2026-10-04");
    expect(Number(shift.opening_cash)).toBe(500);

    milk = await makeProduct({ barcode: "88100001", name: "حليب اليوم", price: 8, cost: 0, category: "ألبان" });
    await ctx.db.run("INSERT OR IGNORE INTO product_categories (name) VALUES ('مخبز')");
    bread = await makeProduct({ barcode: "88100002", name: "خبز اليوم", price: 6, cost: 0, category: "مخبز" });
    roundItem = await makeProduct({ barcode: "88100003", name: "سعر مكسر", price: 21.3, cost: 1, category: "Test" });
    await ctx.db.run("UPDATE products SET stock = 10, cost_known = 1, cost = 1 WHERE id = ?", [roundItem]);

    const expiryA = "2026-11-03";
    const expiryB = "2026-10-14";
    async function purchase(productId, qty, total, expiry, date) {
      const created = await request(ctx.app)
        .post("/api/v1/purchases/invoices")
        .set(authHeader(adminToken))
        .send({
          supplier_id: supplierId,
          invoice_date: date,
          items: [{ product_id: productId, quantity: qty, total_cost: total, expiry_date: expiry }],
        });
      expect(created.status).toBe(201);
      const posted = await request(ctx.app)
        .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
        .set(authHeader(adminToken))
        .send({});
      expect(posted.status).toBe(200);
      return unwrap(created.body);
    }

    const lotA = await purchase(milk, 10, 40, expiryA, "2026-10-04");
    const lotB = await purchase(milk, 8, 40, expiryB, "2026-10-04");
    expect(Number(lotA.total) + Number(lotB.total)).toBe(80);
    expect(Number(lotA.vat) + Number(lotB.vat)).toBe(0);
    const breadIn = await purchase(bread, 5, 10, null, "2026-10-04");
    expect(Number(breadIn.total)).toBe(10);
    const tomorrowOnly = await makeProduct({ barcode: "88100004", name: "وارد الغد", price: 3, cost: 0, category: "Test" });
    await purchase(tomorrowOnly, 1, 3, null, "2026-10-05");

    const milkSaved = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [milk]);
    expect(Number(milkSaved.stock)).toBe(18);
    expect(Number(milkSaved.cost)).toBe(4.44);

    async function checkout(body) {
      const res = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(withCheckoutKey(body));
      return res;
    }

    const cash = await checkout({
      items: [{ product_id: milk, quantity: 2, price: 8 }],
      payments: [{ method: "cash", amount: 20 }],
    });
    expect(cash.status).toBe(201);
    const cashBody = unwrap(cash.body);
    expect(cashBody.total).toBe(16);
    const cashTx = await ctx.db.get(
      `SELECT t.total, t.change_amount, t.business_day AS own_day, cs.business_day AS shift_day
         FROM transactions t JOIN cashier_shifts cs ON cs.id = t.shift_id
        WHERE t.id = ?`,
      [cashBody.transaction_id]
    );
    expect(Number(cashTx.total)).toBe(16);
    expect(Number(cashTx.change_amount)).toBe(4);
    expect(cashTx.shift_day).toBe("2026-10-04");
    const cashLedger = await ctx.db.get(
      `SELECT business_day FROM inventory_ledger
        WHERE reference_type = 'transaction' AND reference_id = ? AND movement_type = 'sale'`,
      [cashBody.transaction_id]
    );
    expect(cashLedger.business_day).toBe("2026-10-04");
    const cashMove = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [cashBody.transaction_id]
    );
    expect(Number(cashMove.amount)).toBe(16);

    const visa = await checkout({
      items: [{ product_id: milk, quantity: 1, price: 8 }],
      payment_method: "visa",
    });
    expect(visa.status).toBe(201);
    const visaId = unwrap(visa.body).transaction_id;
    const visaMove = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE transaction_id = ?",
      [visaId]
    );
    expect(Number(visaMove.n)).toBe(0);
    const nextNoon = new Date(new Date(shopYmdToUtcBounds("2026-10-05").startIso).getTime() + 12 * 3600 * 1000);
    await ctx.db.run("UPDATE transactions SET created_at = ? WHERE id = ?", [nextNoon.toISOString(), visaId]);

    const mixed = await checkout({
      items: [{ product_id: milk, quantity: 2, price: 8 }],
      payments: [
        { method: "cash", amount: 10 },
        { method: "visa", amount: 6 },
      ],
    });
    expect(mixed.status).toBe(201);
    expect(unwrap(mixed.body).total).toBe(16);
    const mixedMove = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [unwrap(mixed.body).transaction_id]
    );
    expect(Number(mixedMove.amount)).toBe(10);

    const bakerySale = await checkout({
      items: [{ product_id: bread, quantity: 2, price: 6 }],
      payment_method: "cash",
    });
    expect(bakerySale.status).toBe(201);
    expect(unwrap(bakerySale.body).total).toBe(12);
    const breadLedger = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'`,
      [bread]
    );
    expect(Number(breadLedger.n)).toBe(1);
    const breadTx = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?`,
      [bread]
    );
    expect(Number(breadTx.n)).toBe(1);

    const onAccount = await checkout({
      items: [{ product_id: milk, quantity: 2, price: 8 }],
      payment_method: "on_account",
      customer_id: customerId,
    });
    expect(onAccount.status).toBe(202);
    const pendingId = unwrap(onAccount.body).request_id;
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(13);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(0);
    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${pendingId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const oaRow = await ctx.db.get("SELECT transaction_id FROM on_account_requests WHERE id = ?", [pendingId]);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(16);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(11);

    const replay = await checkout({
      items: [{ product_id: milk, quantity: 2, price: 8 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: `oa-replay-${milk}-zzzzzz`,
    });
    const replay2 = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: milk, quantity: 2, price: 8 }],
        payment_method: "on_account",
        customer_id: customerId,
        idempotency_key: `oa-replay-${milk}-zzzzzz`,
      });
    expect(replay.status).toBe(202);
    expect(replay2.status).toBe(202);
    expect(unwrap(replay2.body).request_id).toBe(unwrap(replay.body).request_id);
    expect(unwrap(replay2.body).idempotent_replay).toBe(true);
    const pendingRows = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM on_account_requests WHERE idempotency_key = ?",
      [`oa-replay-${milk}-zzzzzz`]
    );
    expect(Number(pendingRows.n)).toBe(1);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(16);

    const receipt = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "receipt",
        voucher_date: "2026-10-04",
        lines: [{ line_type: "cash", amount: 6, currency: "NIS", customer_id: customerId }],
      });
    expect(receipt.status).toBe(201);
    const receiptPost = await request(ctx.app)
      .post(`/api/v1/vouchers/${unwrap(receipt.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(receiptPost.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(10);

    const refundReq = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: oaRow.transaction_id,
        lines: [{ product_id: milk, quantity: 1 }],
        payment_method: "on_account",
        idempotency_key: `day-refund-${milk}-aaaa`,
      });
    expect(refundReq.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(11);
    const refundOk = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refundReq.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(refundOk.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(2);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(12);

    const settle = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "receipt",
        voucher_date: "2026-10-04",
        lines: [{ line_type: "cash", amount: 2, currency: "NIS", customer_id: customerId }],
      });
    expect(settle.status).toBe(201);
    const settlePost = await request(ctx.app)
      .post(`/api/v1/vouchers/${unwrap(settle.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(settlePost.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(0);

    const listed = await listStockBatches(ctx.db, milk);
    const nearer = listed.rows.find((row) => row.expiry_date === expiryB);
    expect(nearer.status).not.toBe("expired");
    expect(qtyOf(listed, expiryB)).toBe(2);
    expect(qtyOf(listed, expiryA)).toBe(10);
    expect(listed.product_stock).toBe(12);

    const pay = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 20,
        notes: "دفعة اليوم",
        idempotency_key: "day-supplier-20-aaaa",
      });
    expect(pay.status).toBe(201);
    const payBody = unwrap(pay.body);
    const approvedPay = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${payBody.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(approvedPay.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(73);

    const salesBeforeExpense = Number((await ctx.db.get(
      "SELECT COALESCE(SUM(total), 0) AS s FROM transactions WHERE shift_id = ?",
      [shiftId]
    )).s);
    const movesBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ?",
      [shiftId]
    )).n);
    const expense = await request(ctx.app)
      .post("/api/v1/finance/operating-expenses")
      .set(authHeader(adminToken))
      .send({
        category: "utilities",
        amount: 15,
        paid_on: "2026-10-04",
        payment_method: "cash",
        reference_note: "كهرباء",
      });
    expect(expense.status).toBe(201);
    const salesAfterExpense = Number((await ctx.db.get(
      "SELECT COALESCE(SUM(total), 0) AS s FROM transactions WHERE shift_id = ?",
      [shiftId]
    )).s);
    expect(salesAfterExpense).toBe(salesBeforeExpense);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ?",
      [shiftId]
    )).n)).toBe(movesBefore);

    const r1 = await checkout({
      items: [{ product_id: roundItem, quantity: 1, price: 21.3 }],
      payment_method: "cash",
    });
    expect(unwrap(r1.body).total).toBe(21);
    expect(unwrap(r1.body).amount_before_rounding).toBe(21.3);
    const firstItem = await ctx.db.get(
      "SELECT unit_price, unit_cost_at_sale, line_net FROM transaction_items WHERE transaction_id = ?",
      [unwrap(r1.body).transaction_id]
    );
    await ctx.db.run("UPDATE products SET price = 45.6, cost = 9 WHERE id = ?", [roundItem]);
    const r2 = await checkout({
      items: [{ product_id: roundItem, quantity: 1, price: 45.6 }],
      payment_method: "cash",
    });
    expect(unwrap(r2.body).total).toBe(46);
    expect(unwrap(r2.body).amount_before_rounding).toBe(45.6);
    const firstStill = await ctx.db.get(
      "SELECT unit_price, unit_cost_at_sale, line_net, gross_profit FROM transaction_items WHERE transaction_id = ?",
      [unwrap(r1.body).transaction_id]
    );
    expect(Number(firstStill.unit_price)).toBe(Number(firstItem.unit_price));
    expect(Number(firstStill.unit_cost_at_sale)).toBe(1);
    expect(Number(firstStill.line_net)).toBe(21.3);
    expect(Number(firstStill.gross_profit)).toBe(20.3);
    const secondItem = await ctx.db.get(
      "SELECT unit_cost_at_sale, line_net FROM transaction_items WHERE transaction_id = ?",
      [unwrap(r2.body).transaction_id]
    );
    expect(Number(secondItem.unit_cost_at_sale)).toBe(9);
    expect(Number(secondItem.line_net)).toBe(45.6);

    await ctx.db.run("UPDATE products SET price = 2.5 WHERE id = ?", [roundItem]);
    const r3 = await checkout({
      items: [{ product_id: roundItem, quantity: 1, price: 2.5 }],
      payment_method: "cash",
    });
    expect(unwrap(r3.body).total).toBe(2.5);
    expect(unwrap(r3.body).amount_before_rounding).toBe(2.5);

    const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
    const main = warehouses.find((w) => w.type === "main");
    const returnsWh = warehouses.find((w) => w.type === "returns");
    const transfer = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        transfer_date: "2026-10-04",
        items: [{ product_id: milk, quantity: 2, expiry_date: expiryA, batch_source: "dated" }],
      });
    expect(transfer.status).toBe(201);
    expect((await request(ctx.app).post(`/api/v1/warehouses/transfers/${unwrap(transfer.body).id}/post`).set(authHeader(adminToken))).status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(12);

    const damage = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        document_date: "2026-10-04",
        reason: "damaged",
        items: [{
          product_id: milk,
          quantity: 1,
          unit_id: (await ctx.db.get("SELECT id FROM product_units WHERE product_id = ? AND is_default = 1", [milk])).id,
          batch_source: "dated",
          expiry_date: expiryB,
        }],
      });
    expect(damage.status).toBe(201);

    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(11);
    expect(await deriveStockFromLedger(ctx.db, milk)).toBe(11);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread])).stock)).toBe(3);
    expect(await deriveStockFromLedger(ctx.db, bread)).toBe(3);
    const lots = await listStockBatches(ctx.db, milk);
    expect(lots.dated_sum).toBe(11);
    expect(lots.unknown_quantity).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [sentinelId])).stock)).toBe(4);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [tomorrowOnly])).stock)).toBe(1);

    const day = unwrap((await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-04" }).set(authHeader(adminToken))).body);
    const next = unwrap((await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-05" }).set(authHeader(adminToken))).body);
    expect(day.total_sales).toBe(137.5);
    expect(day.refunds_total).toBe(8);
    expect(day.net_sales).toBe(129.5);
    expect(day.item_revenue).toBe(137.4);
    expect(day.rounding_adjustment).toBe(0.1);
    expect(next.total_sales).toBe(0);
    expect(next.refunds_total).toBe(0);
    expect(day.cost).toBe(49.64);
    expect(day.profit).toBe(79.86);

    const bakery = unwrap((await request(ctx.app).get("/api/v1/reports/bakery").query({ from: "2026-10-04", to: "2026-10-04" }).set(authHeader(adminToken))).body);
    const breadRow = (bakery.products || []).find((row) => Number(row.product_id) === bread);
    const milkRow = (bakery.products || []).find((row) => Number(row.product_id) === milk);
    expect(breadRow).toBeTruthy();
    expect(Number(breadRow.net_revenue)).toBe(12);
    expect(milkRow).toBeFalsy();

    const moves = await ctx.db.all(
      "SELECT amount FROM shift_cash_movements WHERE shift_id = ?",
      [shiftId]
    );
    const movementSum = moves.reduce((s, row) => Math.round((s + Number(row.amount)) * 100) / 100, 0);
    expect(movementSum).toBe(587.5);

    const rejectedReplay = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(replay.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(rejectedReplay.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk])).stock)).toBe(11);

    const ended = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(ended.status).toBe(200);
    expect(unwrap(ended.body).status).toBe("pending_count");
    expect(Number(unwrap(ended.body).expected_cash)).toBe(587.5);

    const counted = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: 587.5 });
    expect(counted.status).toBe(200);

    const late = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        idempotency_key: "day-supplier-late-aa",
      });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(73);
    } finally {
      jest.useRealTimers();
    }
  });
});
