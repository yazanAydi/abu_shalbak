/**
 * Batch-aware issues and counts on a disposable database.
 * Quantities below are the physical amounts on the documents, not a copy of
 * the allocator under test.
 */
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
import { ISSUE_REASON_CODES } from "../utils/inventoryDocumentReasons.js";
import { addShopDays, shopTodayYmd } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("batch-aware issues and counts", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let seq = 0;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد دفعات', 'S-BAT', 0, 0)`
    );
    supplierId = sup.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    const shift = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(shift.status).toBe(201);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name) {
    seq += 1;
    const barcode = `77${String(seq).padStart(6, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, 8, 0, 'Test', 0)`,
      [barcode, name]
    );
    const unit = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, 8, 0, 1, 1)`,
      [ins.lastID, barcode]
    );
    return { id: ins.lastID, unitId: unit.lastID, barcode };
  }

  async function receive(productId, quantity, total, expiry) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: shopTodayYmd(),
        items: [{ product_id: productId, quantity, total_cost: total, expiry_date: expiry }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
  }

  async function separatedLots(name = "صنف إخراج") {
    const product = await makeProduct(name);
    const later = addShopDays(shopTodayYmd(), 30);
    const earlier = addShopDays(shopTodayYmd(), 10);
    await receive(product.id, 10, 40, later);
    await receive(product.id, 8, 40, earlier);
    return { product, later, earlier };
  }

  async function issue(product, items, reason = "damaged") {
    return request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({ document_date: shopTodayYmd(), reason, items });
  }

  async function sell(productId, quantity) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: 8 }],
        payment_method: "cash",
      }, `bat-sale-${productId}-${quantity}-${seq}`));
  }

  async function openCount() {
    const open = await ctx.db.get("SELECT id FROM stock_count_sessions WHERE status = 'open'");
    if (open) await ctx.db.run("DELETE FROM stock_count_sessions WHERE id = ?", [open.id]);
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ notes: "جرد دفعات", department: "retail" });
    expect(session.status).toBe(201);
    return unwrap(session.body).id;
  }

  function fullCount(product, later, earlier, counts) {
    return {
      product_id: product.id,
      sources: [
        { batch_source: "dated", expiry_date: later, counted_qty: counts.later },
        { batch_source: "dated", expiry_date: earlier, counted_qty: counts.earlier },
        { batch_source: "undated", expiry_date: null, counted_qty: counts.undated },
      ],
    };
  }

  test("damaging the earlier lot, selling, and refunding follows that lot", async () => {
    const { product, later, earlier } = await separatedLots();
    const damaged = await issue(product, [{
      product_id: product.id,
      unit_id: product.unitId,
      quantity: 2,
      batch_source: "dated",
      expiry_date: earlier,
    }]);
    expect(damaged.status).toBe(201);
    expect(unwrap(damaged.body).items[0].batch_source).toBe("dated");
    expect(unwrap(damaged.body).items[0].expiry_date).toBe(earlier);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(16);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(6);
    expect(listed.unknown_quantity).toBe(0);

    const sale = await sell(product.id, 4);
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(12);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(2);

    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        idempotency_key: `bat-refund-${product.id}`,
      });
    expect(refund.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(13);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(3);
    expect(listed.unknown_quantity).toBe(0);
    const alloc = await ctx.db.get(
      `SELECT expiry_date, quantity, direction FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'inventory_issue'`,
      [product.id]
    );
    expect(alloc.expiry_date).toBe(earlier);
    expect(Number(alloc.quantity)).toBe(2);
    expect(alloc.direction).toBe("out");
  });

  test("damage can come from undated stock or be split across sources", async () => {
    const product = await makeProduct("غير محدد");
    const later = addShopDays(shopTodayYmd(), 30);
    const earlier = addShopDays(shopTodayYmd(), 10);
    await receive(product.id, 10, 40, later);
    await receive(product.id, 4, 12, null);
    const fromUndated = await issue(product, [{
      product_id: product.id,
      unit_id: product.unitId,
      quantity: 2,
      batch_source: "undated",
      expiry_date: null,
    }]);
    expect(fromUndated.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(12);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.unknown_quantity).toBe(2);

    await receive(product.id, 8, 40, earlier);
    const split = await issue(product, [
      {
        product_id: product.id,
        unit_id: product.unitId,
        quantity: 1,
        batch_source: "dated",
        expiry_date: earlier,
      },
      {
        product_id: product.id,
        unit_id: product.unitId,
        quantity: 2,
        batch_source: "undated",
        expiry_date: null,
      },
    ]);
    expect(split.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(17);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(7);
    expect(listed.unknown_quantity).toBe(0);
  });

  test("every issue reason requires a source and reduces that lot", async () => {
    const { product, earlier } = await separatedLots("كل الأسباب");
    for (const reason of ISSUE_REASON_CODES) {
      const res = await issue(product, [{
        product_id: product.id,
        unit_id: product.unitId,
        quantity: 1,
        batch_source: "dated",
        expiry_date: earlier,
      }], reason);
      expect(res.status).toBe(201);
    }
    const listed = await listStockBatches(ctx.db, product.id);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(8 - ISSUE_REASON_CODES.length);
    expect(listed.product_stock).toBe(18 - ISSUE_REASON_CODES.length);
  });

  test("a missing source is rejected and duplicate lines cannot overdraw a lot", async () => {
    const { product, earlier } = await separatedLots("رفض");
    const missing = await issue(product, [{
      product_id: product.id,
      unit_id: product.unitId,
      quantity: 1,
    }]);
    expect(missing.status).toBe(400);
    expect(unwrap(missing.body).code || missing.body.code).toBe("BATCH_SOURCE_REQUIRED");

    const over = await issue(product, [
      { product_id: product.id, unit_id: product.unitId, quantity: 5, batch_source: "dated", expiry_date: earlier },
      { product_id: product.id, unit_id: product.unitId, quantity: 5, batch_source: "dated", expiry_date: earlier },
    ]);
    expect(over.status).toBe(400);
    const listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(18);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(8);
    const docs = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM inventory_document_items WHERE product_id = ?`,
      [product.id]
    );
    expect(Number(docs.n)).toBe(0);
  });

  test("a product with no dated lots still issues without a source", async () => {
    const product = await makeProduct("بلا دفعة");
    await receive(product.id, 5, 15, null);
    const res = await issue(product, [{
      product_id: product.id,
      unit_id: product.unitId,
      quantity: 2,
    }], "internal");
    expect(res.status).toBe(201);
    expect(unwrap(res.body).items[0].batch_source).toBeNull();
    const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(stock.stock)).toBe(3);
  });

  test("a legacy issue line stays unassigned and is not read as undated", async () => {
    const product = await makeProduct("سند قديم");
    await receive(product.id, 4, 8, null);
    const doc = await ctx.db.run(
      `INSERT INTO inventory_documents
         (document_number, document_type, document_date, reason, status)
       VALUES ('GOUT-LEGACY1', 'issue', ?, 'damaged', 'completed')`,
      [shopTodayYmd()]
    );
    await ctx.db.run(
      `INSERT INTO inventory_document_items
         (document_id, product_id, product_unit_id, quantity, conversion_to_base, base_quantity, product_name_snapshot)
       VALUES (?, ?, ?, 1, 1, 1, 'سند قديم')`,
      [doc.lastID, product.id, product.unitId]
    );
    const loaded = await request(ctx.app)
      .get(`/api/v1/inventory-issues/${doc.lastID}`)
      .set(authHeader(adminToken));
    expect(loaded.status).toBe(200);
    const item = unwrap(loaded.body).items[0];
    expect(item.batch_source).toBeNull();
    expect(item.expiry_date).toBeNull();
    expect(item.source_label).toBeNull();
    const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(stock.stock)).toBe(4);
  });

  test("counts can lower, raise, and zero a lot, and a reshuffle does not move company stock", async () => {
    const { product, later, earlier } = await separatedLots("جرد");
    const downId = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${downId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 6, undated: 0 }))).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${downId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(16);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(6);

    const upId = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${upId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 7, undated: 0 }))).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${upId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(17);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(7);

    const zeroId = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${zeroId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 0, undated: 0 }))).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${zeroId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const zeroRow = await ctx.db.get(
      "SELECT id, quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, earlier]
    );
    expect(zeroRow).toBeTruthy();
    expect(Number(zeroRow.quantity)).toBe(0);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(10);

    const againId = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${againId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 8, earlier: 2, undated: 0 }))).status).toBe(200);
    const ledgerBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND movement_type = 'stock_count_correction'",
      [product.id]
    )).n);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${againId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const ledgerAfter = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND movement_type = 'stock_count_correction'",
      [product.id]
    )).n);
    expect(ledgerAfter).toBe(ledgerBefore);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(8);
    const moved = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'stock_count' AND reference_id = ?`,
      [product.id, againId]
    );
    expect(Number(moved.n)).toBeGreaterThan(0);
    const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(stock.stock)).toBe(10);
  });

  test("incomplete, stale, and repeated counts do not post", async () => {
    const { product, later, earlier } = await separatedLots("جرد ناقص");
    const sessionId = await openCount();
    const partial = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        batch_source: "dated",
        expiry_date: earlier,
        counted_qty: 6,
      });
    expect(partial.status).toBe(200);
    const incomplete = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(incomplete.status).toBe(400);
    expect(unwrap(incomplete.body).code || incomplete.body.code).toBe("INCOMPLETE_COUNT");
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(18);

    await ctx.db.run("DELETE FROM stock_count_lines WHERE session_id = ?", [sessionId]);
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 8, undated: 0 }))).status).toBe(200);
    await ctx.db.run(
      "UPDATE product_batches SET quantity = quantity - 1 WHERE product_id = ? AND expiry_date = ?",
      [product.id, earlier]
    );
    await ctx.db.run("UPDATE products SET stock = stock - 1 WHERE id = ?", [product.id]);
    const stale = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(stale.status).toBe(400);
    expect(unwrap(stale.body).code || stale.body.code).toBe("STALE_COUNT");
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(7);
    expect(listed.product_stock).toBe(17);

    await ctx.db.run("DELETE FROM stock_count_sessions WHERE id = ?", [sessionId]);
    const fresh = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${fresh}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 7, undated: 0 }))).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${fresh}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const again = await request(ctx.app).post(`/api/v1/inventory/counts/${fresh}/post`).set(authHeader(adminToken)).send({});
    expect(again.status).toBe(400);
    const corrections = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'stock_count_session' AND reference_id = ?`,
      [product.id, fresh]
    );
    expect(Number(corrections.n)).toBe(0);
  });

  test("a posted count reconciles a negative undated remainder without inventing stock", async () => {
    const product = await makeProduct("تصحيح");
    const later = addShopDays(shopTodayYmd(), 30);
    const earlier = addShopDays(shopTodayYmd(), 10);
    await ctx.db.run("UPDATE products SET stock = 16 WHERE id = ?", [product.id]);
    await ctx.db.run(
      `INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, ?, 10), (?, ?, 8)`,
      [product.id, later, product.id, earlier]
    );
    const before = await listStockBatches(ctx.db, product.id);
    expect(before.unknown_quantity).toBe(-2);
    const batchesRes = await request(ctx.app)
      .get(`/api/v1/products/${product.id}/batches`)
      .set(authHeader(adminToken));
    expect(batchesRes.status).toBe(200);
    expect(unwrap(batchesRes.body).unknown_quantity).toBe(-2);
    const sessionId = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send(fullCount(product, later, earlier, { later: 10, earlier: 6, undated: 0 }))).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const after = await listStockBatches(ctx.db, product.id);
    expect(after.product_stock).toBe(16);
    expect(after.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(after.rows.find((r) => r.expiry_date === earlier).quantity).toBe(6);
    expect(after.unknown_quantity).toBe(0);
    const ledger = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND movement_type = 'stock_count_correction'",
      [product.id]
    );
    expect(Number(ledger.n)).toBe(0);
    const audit = await ctx.db.get(
      "SELECT id FROM audit_logs WHERE entity_type = 'stock_count_sessions' AND entity_id = ?",
      [sessionId]
    );
    expect(audit).toBeTruthy();
  });

  test("a lot with quantity or allocation history cannot be deleted", async () => {
    const { product, earlier } = await separatedLots("حذف");
    const row = await ctx.db.get(
      "SELECT id FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, earlier]
    );
    const blocked = await request(ctx.app)
      .delete(`/api/v1/inventory/batches/${row.id}`)
      .set(authHeader(adminToken));
    expect(blocked.status).toBe(400);
    expect(unwrap(blocked.body).code || blocked.body.code).toBe("BATCH_HAS_QUANTITY");

    await ctx.db.run("UPDATE product_batches SET quantity = 0 WHERE id = ?", [row.id]);
    const historic = await request(ctx.app)
      .delete(`/api/v1/inventory/batches/${row.id}`)
      .set(authHeader(adminToken));
    expect(historic.status).toBe(400);
    expect(unwrap(historic.body).code || historic.body.code).toBe("BATCH_HAS_HISTORY");
    const still = await ctx.db.get("SELECT id FROM product_batches WHERE id = ?", [row.id]);
    expect(still).toBeTruthy();

    const empty = await ctx.db.run(
      `INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, ?, 0)`,
      [product.id, addShopDays(shopTodayYmd(), 90)]
    );
    const removed = await request(ctx.app)
      .delete(`/api/v1/inventory/batches/${empty.lastID}`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(200);
    expect(await ctx.db.get("SELECT id FROM product_batches WHERE id = ?", [empty.lastID])).toBeUndefined();
  });

  test("alerts and the office report count a product date only for the undated remainder", async () => {
    const product = await makeProduct("تقرير");
    const soon = addShopDays(shopTodayYmd(), 3);
    await ctx.db.run(
      "UPDATE products SET stock = 10, expiry_date = ? WHERE id = ?",
      [soon, product.id]
    );
    await ctx.db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, 'R1', ?, 6)`,
      [product.id, soon]
    );
    const alerts = await fetchNearExpiryItems(ctx.db, 30);
    const productRow = alerts.products.find((row) => row.id === product.id);
    const batchRow = alerts.batches.find((row) => row.batch_no === "R1");
    expect(productRow).toBeTruthy();
    expect(Number(productRow.stock)).toBe(4);
    expect(batchRow).toBeTruthy();
    expect(Number(batchRow.quantity)).toBe(6);

    const report = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/expiry?days=30")
      .set(authHeader(adminToken))).body);
    const mine = report.filter((row) => row.product_id === product.id || row.id === product.id);
    expect(mine.reduce((sum, row) => sum + Number(row.stock), 0)).toBe(10);

    const near = unwrap((await request(ctx.app)
      .get("/api/v1/reports/near-expiry")
      .set(authHeader(adminToken))).body);
    const dash = (near.items || []).filter((row) => row.barcode === product.barcode);
    expect(dash.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(10);
  });
});
