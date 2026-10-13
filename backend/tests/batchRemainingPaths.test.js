/**
 * Adjustment, bakery consumption, zero-all, and inventory receipts on a disposable database.
 * Expected quantities are calculated from the documents, not copied from the allocator.
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
import { listOfficeExpiryReport } from "../services/expiryAlertService.js";
import { addShopDays, shopTodayYmd } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("remaining batch mutation paths", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد تسوية', 'S-ADJ', 0, 0)"
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
    const barcode = `88${String(seq).padStart(6, "0")}`;
    const ins = await ctx.db.run(
      "INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, 8, 0, 'Test', 0)",
      [barcode, name]
    );
    const unit = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, 8, 0, 1, 1)`,
      [ins.lastID, barcode]
    );
    return { id: ins.lastID, unitId: unit.lastID, barcode };
  }

  async function purchase(productId, quantity, total, expiry) {
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

  async function lots(name) {
    const product = await makeProduct(name);
    const later = addShopDays(shopTodayYmd(), 30);
    const earlier = addShopDays(shopTodayYmd(), 10);
    await purchase(product.id, 10, 40, later);
    await purchase(product.id, 8, 32, earlier);
    return { product, later, earlier };
  }

  function adjust(body) {
    return request(ctx.app).post("/api/v1/inventory/adjustments").set(authHeader(adminToken)).send(body);
  }

  async function sell(productId, quantity) {
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: 8 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    return unwrap(sale.body).transaction_id;
  }

  async function refund(productId, transactionId, quantity) {
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: productId, quantity }],
        payment_method: "cash",
        idempotency_key: `adj-refund-${productId}-${quantity}-${seq}`,
      });
    expect(created.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
  }

  test("dated and undated damage on the adjustment screen update that source", async () => {
    const { product, later, earlier } = await lots("تالف تسوية");
    const dated = await adjust({
      adjustment_type: "damage",
      adjustment_date: shopTodayYmd(),
      post: true,
      items: [{ product_id: product.id, quantity: 2, batch_source: "dated", expiry_date: earlier }],
    });
    expect(dated.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(16);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(6);
    expect(listed.unknown_quantity).toBe(0);

    const missing = await adjust({
      adjustment_type: "damage",
      post: true,
      items: [{ product_id: product.id, quantity: 1 }],
    });
    expect(missing.status).toBe(400);
    expect(unwrap(missing.body).code || missing.body.code).toBe("BATCH_SOURCE_REQUIRED");
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(16);

    const receipt = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: product.id, product_unit_id: product.unitId, quantity: 3 }],
      });
    expect(receipt.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(19);
    expect(listed.unknown_quantity).toBe(3);

    const undated = await adjust({
      adjustment_type: "damage",
      post: true,
      items: [{ product_id: product.id, quantity: 1, batch_source: "undated", expiry_date: null }],
    });
    expect(undated.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(18);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(6);
    expect(listed.unknown_quantity).toBe(2);

    const txId = await sell(product.id, 4);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(14);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(2);
    expect(listed.unknown_quantity).toBe(2);
    await refund(product.id, txId, 1);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(15);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(3);

    const report = await listOfficeExpiryReport(ctx.db, 30);
    const earlierRow = report.find((row) => row.product_id === product.id && row.expiry_date === earlier);
    expect(Number(earlierRow.stock)).toBe(3);
  });

  test("bakery consumption takes the earliest lot and then the next", async () => {
    const { product, later, earlier } = await lots("استهلاك مخبز");
    const first = await adjust({
      adjustment_type: "consumption",
      post: true,
      items: [{ product_id: product.id, quantity: 4 }],
    });
    expect(first.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(14);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(4);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(10);
    expect(listed.unknown_quantity).toBe(0);

    const second = await adjust({
      adjustment_type: "consumption",
      post: true,
      items: [{ product_id: product.id, quantity: 6 }],
    });
    expect(second.status).toBe(201);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(8);
    const earlierLeft = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, earlier]
    );
    expect(Number(earlierLeft.quantity)).toBe(0);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(8);

    const txId = await sell(product.id, 2);
    listed = await listStockBatches(ctx.db, product.id);
    expect(Number((await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, earlier]
    )).quantity)).toBe(0);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(6);
    await refund(product.id, txId, 1);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(7);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(7);
  });

  test("zero-all clears dated and undated sources and records one stock movement", async () => {
    const { product, later, earlier } = await lots("تصفير");
    const extra = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: product.id, product_unit_id: product.unitId, quantity: 4 }],
      });
    expect(extra.status).toBe(201);
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(22);
    expect(listed.unknown_quantity).toBe(4);

    const zeroed = await request(ctx.app).post("/api/v1/inventory/zero-all-stock").set(authHeader(adminToken)).send({});
    expect(zeroed.status).toBe(200);
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(0);
    const kept = await ctx.db.all(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date",
      [product.id]
    );
    expect(kept.map((row) => [row.expiry_date, Number(row.quantity)])).toEqual([
      [earlier, 0],
      [later, 0],
    ]);
    expect(listed.unknown_quantity).toBe(0);
    const ledger = await ctx.db.get(
      "SELECT COUNT(*) AS n, SUM(quantity_delta) AS delta FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [product.id]
    );
    expect(Number(ledger.n)).toBe(1);
    expect(Number(ledger.delta)).toBe(-22);
    const alloc = await ctx.db.all(
      "SELECT expiry_date, quantity, direction FROM stock_batch_allocations WHERE product_id = ? AND reference_type = 'zero_all_stock' ORDER BY expiry_date",
      [product.id]
    );
    expect(alloc.map((row) => [row.expiry_date, Number(row.quantity), row.direction])).toEqual([
      [null, 4, "out"],
      [earlier, 8, "out"],
      [later, 10, "out"],
    ]);

    const again = await request(ctx.app).post("/api/v1/inventory/zero-all-stock").set(authHeader(adminToken)).send({});
    expect(again.status).toBe(200);
    const ledgerAfter = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ? AND reference_type = 'zero_all_stock'",
      [product.id]
    );
    expect(Number(ledgerAfter.n)).toBe(1);
  });

  test("a receipt keeps a supplied expiry and leaves a blank expiry undated", async () => {
    const product = await makeProduct("سند إدخال");
    const expiry = addShopDays(shopTodayYmd(), 12);
    const dated = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: product.id, product_unit_id: product.unitId, quantity: 5, expiry_date: expiry }],
      });
    expect(dated.status).toBe(201);
    expect(unwrap(dated.body).items[0].expiry_date).toBe(expiry);
    const plain = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: product.id, product_unit_id: product.unitId, quantity: 2 }],
      });
    expect(plain.status).toBe(201);
    expect(unwrap(plain.body).items[0].expiry_date).toBeFalsy();
    const listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(7);
    expect(listed.rows.find((r) => r.expiry_date === expiry).quantity).toBe(5);
    expect(listed.unknown_quantity).toBe(2);
    const invalid = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: product.id, product_unit_id: product.unitId, quantity: 1, expiry_date: "2026-02-31" }],
      });
    expect(invalid.status).toBe(400);
    expect((await listStockBatches(ctx.db, product.id)).product_stock).toBe(7);
  });

  test("an over-allocation rolls back the adjustment and a second post does not move stock again", async () => {
    const { product, later, earlier } = await lots("تراجع");
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM stock_adjustments");
    const failed = await adjust({
      adjustment_type: "damage",
      post: true,
      items: [
        { product_id: product.id, quantity: 2, batch_source: "dated", expiry_date: earlier },
        { product_id: product.id, quantity: 7, batch_source: "dated", expiry_date: earlier },
      ],
    });
    expect(failed.status).toBe(400);
    expect(unwrap(failed.body).code || failed.body.code).toBe("INSUFFICIENT_BATCH");
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM stock_adjustments");
    expect(Number(after.n)).toBe(Number(before.n));
    let listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(18);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(8);

    const draft = await adjust({
      adjustment_type: "out",
      post: false,
      items: [{ product_id: product.id, quantity: 1, batch_source: "dated", expiry_date: later }],
    });
    expect(draft.status).toBe(201);
    const id = unwrap(draft.body).id;
    const first = await request(ctx.app).post(`/api/v1/inventory/adjustments/${id}/post`).set(authHeader(adminToken)).send({});
    expect(first.status).toBe(200);
    const second = await request(ctx.app).post(`/api/v1/inventory/adjustments/${id}/post`).set(authHeader(adminToken)).send({});
    expect(second.status).toBe(400);
    expect(unwrap(second.body).code || second.body.code).toBe("ALREADY_POSTED");
    listed = await listStockBatches(ctx.db, product.id);
    expect(listed.product_stock).toBe(17);
    expect(listed.rows.find((r) => r.expiry_date === later).quantity).toBe(9);
    expect(listed.rows.find((r) => r.expiry_date === earlier).quantity).toBe(8);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reference_type = 'stock_adjustment' AND reference_id = ?",
      [id]
    );
    expect(Number(moves.n)).toBe(1);
  });

  test("the count-source unique index rejects a second undated or dated line and keeps a legacy row", async () => {
    const session = await ctx.db.run("INSERT INTO stock_count_sessions (status) VALUES ('open')");
    const sessionId = session.lastID;
    const productId = ctx.productId;
    await ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 4, 4, 0, 'undated', NULL)`,
      [sessionId, productId]
    );
    await expect(ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 1, 0, -1, 'undated', NULL)`,
      [sessionId, productId]
    )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });

    const expiry = "2026-10-20";
    await ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 10, 10, 0, 'dated', ?)`,
      [sessionId, productId, expiry]
    );
    await expect(ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 1, 1, 0, 'dated', ?)`,
      [sessionId, productId, expiry]
    )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
    await ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 3, 3, 0, 'dated', '2026-11-01')`,
      [sessionId, productId]
    );
    await ctx.db.run(
      `INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
       VALUES (?, ?, 9, 9, 0, NULL, NULL)`,
      [sessionId, productId]
    );
    const rows = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_count_lines WHERE session_id = ?",
      [sessionId]
    );
    expect(Number(rows.n)).toBe(4);
  });
});
