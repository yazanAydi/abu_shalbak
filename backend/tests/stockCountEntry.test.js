/**
 * Stock-count entry contract: separate expiry rows, undated blanks, and
 * department filters. Uses the disposable test database only.
 */
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { shopTodayYmd, addShopDays } from "../utils/shopTime.js";
import { sellableQuantity, moveWarehouseQuantity, operationalWarehouses } from "../services/warehouseBatchStock.js";
import { withTransaction } from "../utils/dbTx.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("stock count entry rows", () => {
  let ctx;
  let adminToken;
  let supplierId;
  let seq = 0;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد جرد', 'S-CNT', 0, 0)"
    );
    supplierId = sup.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, scope = "retail") {
    seq += 1;
    const barcode = `${scope === "bakery" ? "88" : "77"}${String(seq).padStart(8, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
       VALUES (?, ?, 8, 2, 'Test', 0, ?)`,
      [barcode, name, scope]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, 8, 2, 1, 1)`,
      [ins.lastID, barcode]
    );
    return { id: ins.lastID, barcode };
  }

  async function receive(productId, quantity, expiry) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: shopTodayYmd(),
        items: [{ product_id: productId, quantity, total_cost: quantity * 2, expiry_date: expiry }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
  }

  async function openCount() {
    const open = await ctx.db.get("SELECT id FROM stock_count_sessions WHERE status = 'open'");
    if (open) await ctx.db.run("DELETE FROM stock_count_sessions WHERE id = ?", [open.id]);
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(session.status).toBe(201);
    return unwrap(session.body).id;
  }

  test("count units are product-specific, saved as snapshots, and post base stock only once", async () => {
    const product = await makeProduct("جرد كرتونة");
    const other = await makeProduct("وحدة صنف آخر");
    await ctx.db.run("UPDATE products SET unit = 'حبة' WHERE id = ?", [product.id]);
    const carton = await ctx.db.run(
      "INSERT INTO product_units (product_id,unit_name,conversion_to_base,price,cost) VALUES (?, 'كرتونة', 6, 48, 12)", [product.id]);
    const foreign = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [other.id]);
    await receive(product.id, 18, null);
    const picture = unwrap((await request(ctx.app).get(`/api/v1/inventory/stock-sources?product_id=${product.id}`).set(authHeader(adminToken))).body);
    expect(picture.count_units.find((u) => u.id === carton.lastID)).toEqual({ id: carton.lastID, unit_name: "كرتونة", conversion_to_base: 6 });
    expect(picture.count_units.every((u) => !("price" in u) && !("cost" in u))).toBe(true);
    const sessionId = await openCount();
    const save = (unitId, conversion, qty = 12) => request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`).set(authHeader(adminToken))
      .send({ product_id: product.id, sources: [{ counted_qty: qty,
        count_unit_snapshot: { unit_id: unitId, conversion_to_base: conversion } }] });
    expect((await save(carton.lastID, 6)).status).toBe(200);
    expect((await save(foreign.id, 1)).status).toBe(400);
    expect((await save(carton.lastID, 100, 200)).status).toBe(400);
    let line = await ctx.db.get("SELECT * FROM stock_count_lines WHERE session_id = ? AND product_id = ?", [sessionId, product.id]);
    expect(line.counted_qty).toBe(12);
    expect(JSON.parse(line.count_unit_snapshot)).toEqual({ unit_id: carton.lastID, unit_name: "كرتونة", conversion_to_base: 6 });
    const reopened = unwrap((await request(ctx.app).get(`/api/v1/inventory/counts/${sessionId}`).set(authHeader(adminToken))).body);
    expect(reopened.lines.find((l) => l.product_id === product.id).count_unit_snapshot).toBe(line.count_unit_snapshot);
    // Subsequent catalog changes must not reinterpret a saved count at posting.
    await ctx.db.run("UPDATE product_units SET conversion_to_base = 10 WHERE id = ?", [carton.lastID]);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock).toBe(12);
    line = await ctx.db.get("SELECT * FROM stock_count_lines WHERE id = ?", [line.id]);
    expect(JSON.parse(line.count_unit_snapshot).conversion_to_base).toBe(6);
  });

  test("two expiry dates stay separate, a blank is undated, and the count replaces stock", async () => {
    const product = await makeProduct("جرد تاريخين");
    const later = addShopDays(shopTodayYmd(), 40);
    const earlier = addShopDays(shopTodayYmd(), 12);
    const productDate = "2031-01-15";
    await receive(product.id, 10, later);
    await receive(product.id, 8, earlier);
    await receive(product.id, 2, null);
    await ctx.db.run("UPDATE products SET expiry_date = ? WHERE id = ?", [productDate, product.id]);

    const sessionId = await openCount();
    const saved = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: later, counted_qty: 4 },
          { batch_source: "dated", expiry_date: earlier, counted_qty: 5 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(saved.status).toBe(200);

    const again = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: later, counted_qty: 4 },
          { batch_source: "dated", expiry_date: earlier, counted_qty: 5 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(again.status).toBe(200);
    const stored = await ctx.db.all(
      `SELECT batch_source, expiry_date, counted_qty
         FROM stock_count_lines WHERE session_id = ? AND product_id = ?
        ORDER BY expiry_date`,
      [sessionId, product.id]
    );
    expect(stored).toHaveLength(3);
    expect(stored.map((line) => Number(line.counted_qty)).sort((a, b) => a - b)).toEqual([0, 4, 5]);

    const reopened = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${sessionId}`)
      .set(authHeader(adminToken))).body);
    const mine = reopened.lines.filter((line) => line.product_id === product.id);
    expect(mine).toHaveLength(3);
    expect(mine.find((line) => line.batch_source === "undated").expiry_date).toBeNull();
    expect(Number(mine.find((line) => line.batch_source === "undated").counted_qty)).toBe(0);
    expect(mine.filter((line) => line.batch_source === "dated").map((line) => line.expiry_date).sort())
      .toEqual([earlier, later].sort());

    const before = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    expect(before).toBe(20);
    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const after = await ctx.db.get("SELECT stock, expiry_date FROM products WHERE id = ?", [product.id]);
    expect(Number(after.stock)).toBe(9);
    expect(after.expiry_date).toBe(productDate);
    const batches = await ctx.db.all(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date",
      [product.id]
    );
    expect(batches.map((batch) => [batch.expiry_date, Number(batch.quantity)])).toEqual([
      [earlier, 5],
      [later, 4],
    ]);
    const warehouse = await ctx.db.get(
      "SELECT SUM(quantity) AS qty FROM warehouse_stock WHERE product_id = ?",
      [product.id]
    );
    expect(Number(warehouse.qty)).toBe(9);
  });

  test("an entered dated count replaces omitted undated stock without requiring a zero row", async () => {
    const product = await makeProduct("جرد ناقص الواجهة");
    const later = addShopDays(shopTodayYmd(), 20);
    const earlier = addShopDays(shopTodayYmd(), 8);
    await receive(product.id, 6, later);
    await receive(product.id, 3, null);
    const sessionId = await openCount();
    const partial = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [{ batch_source: "dated", expiry_date: later, counted_qty: 6 }],
      });
    expect(partial.status).toBe(200);
    const post = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(stock.stock)).toBe(6);
    const undatedLines = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM stock_count_lines
        WHERE session_id = ? AND product_id = ? AND batch_source = 'undated'`,
      [sessionId, product.id]
    );
    expect(Number(undatedLines.n)).toBe(0);
  });

  test("only entered dates replace main stock; returns, other products and receipt identity stay intact", async () => {
    const product = await makeProduct("استبدال تاريخ قديم");
    const untouched = await makeProduct("صنف لم يجرد");
    const oldDate = "2027-01-01", newDate = "2028-02-01";
    await receive(product.id, 10, oldDate);
    await receive(untouched.id, 7, oldDate);
    const { main, returns } = await operationalWarehouses(ctx.db);
    await withTransaction(ctx.db, () => moveWarehouseQuantity(ctx.db, { productId: product.id,
      fromWarehouseId: main.id, toWarehouseId: returns.id, expiryDate: oldDate, quantity: 4 }));
    const history = await ctx.db.all("SELECT * FROM inventory_ledger WHERE product_id = ? ORDER BY id", [product.id]);
    const sessionId = await openCount();
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/lines`).set(authHeader(adminToken))
      .send({ product_id: product.id, sources: [{ expiry_date: newDate, counted_qty: 4, expiry_verified: true }] })).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock).toBe(8);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [untouched.id])).stock).toBe(7);
    const located = await ctx.db.all("SELECT warehouse_id,expiry_date,quantity FROM warehouse_batch_stock WHERE product_id = ? ORDER BY warehouse_id", [product.id]);
    expect(located).toEqual([
      { warehouse_id: main.id, expiry_date: newDate, quantity: 4 },
      { warehouse_id: returns.id, expiry_date: oldDate, quantity: 4 },
    ].sort((a, b) => a.warehouse_id - b.warehouse_id));
    const source = await ctx.db.get("SELECT supplier_id,purchase_invoice_item_id,quantity FROM stock_source_lots WHERE product_id = ? AND warehouse_id = ? AND expiry_date = ? AND quantity > 0", [product.id, main.id, newDate]);
    expect(source.supplier_id).toBe(supplierId);
    expect(source.purchase_invoice_item_id).toBeTruthy();
    expect(source.quantity).toBe(4);
    expect(await ctx.db.all("SELECT * FROM inventory_ledger WHERE product_id = ? AND id <= ? ORDER BY id", [product.id, history[history.length - 1].id])).toEqual(history);
  });

  test("a late stale product rolls back every earlier product in the same posting", async () => {
    const a = await makeProduct("أول جرد"), b = await makeProduct("آخر جرد");
    await receive(a.id, 3, null);
    await receive(b.id, 5, null);
    const sessionId = await openCount();
    for (const [product, quantity, expiry_date] of [[a, 2, null], [b, 4, "2028-03-01"]]) {
      expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/lines`).set(authHeader(adminToken))
        .send({ product_id: product.id, sources: [{ counted_qty: quantity, expiry_date }] })).status).toBe(200);
    }
    await receive(b.id, 1, null);
    const post = await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({});
    expect(post.status).toBe(400);
    expect(post.body.code || unwrap(post.body).code).toBe("STALE_COUNT");
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [a.id])).stock).toBe(3);
    expect((await ctx.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [sessionId])).status).toBe("open");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reference_type = 'stock_count_session' AND reference_id = ?", [sessionId])).n).toBe(0);
  });

  test("an explicit zero count cancels a pre-existing floating residue exactly", async () => {
    const product = await makeProduct("صفر فعلي");
    await ctx.db.run("UPDATE products SET stock = ? WHERE id = ?", [-1.42e-14, product.id]);
    const sessionId = await openCount();
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/lines`).set(authHeader(adminToken))
      .send({ product_id: product.id, counted_qty: 0 })).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock).toBe(0);
  });

  test("a failed completion audit rolls quantities, allocations and session status back", async () => {
    const product = await makeProduct("فشل سجل الجرد");
    await receive(product.id, 3, "2027-01-01");
    const sessionId = await openCount();
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/lines`).set(authHeader(adminToken))
      .send({ product_id: product.id, sources: [{ expiry_date: "2028-01-01", counted_qty: 2 }] })).status).toBe(200);
    await ctx.db.exec(`CREATE TRIGGER reject_count_audit BEFORE INSERT ON audit_logs
      WHEN NEW.entity_type = 'stock_count_sessions' BEGIN SELECT RAISE(ABORT, 'forced count audit failure'); END;`);
    try {
      const post = await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({});
      expect(post.status).toBe(500);
      expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock).toBe(3);
      expect((await ctx.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [sessionId])).status).toBe("open");
      expect((await ctx.db.get("SELECT COUNT(*) AS n FROM stock_batch_allocations WHERE reference_type = 'stock_count' AND reference_id = ?", [sessionId])).n).toBe(0);
    } finally { await ctx.db.exec("DROP TRIGGER reject_count_audit"); }
  });

  test("retail and bakery counts are separate documents", async () => {
    const retail = await makeProduct("متجر", "retail");
    const bakery = await makeProduct("طحين", "bakery");
    const retailSession = await openCount();
    const bakerySession = unwrap((await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department: "bakery" })).body).id;
    expect(bakerySession).not.toBe(retailSession);
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: retail.id, counted_qty: 2, department: "retail" })).status).toBe(200);
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: bakery.id, counted_qty: 0, department: "bakery" })).status).toBe(200);
    const injected = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: bakery.id, counted_qty: 1, department: "retail" });
    expect(injected.status).toBe(400);
    expect(unwrap(injected.body).code).toBe("COUNT_SCOPE");

    const retailView = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${retailSession}?department=retail`)
      .set(authHeader(adminToken))).body);
    const bakeryView = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${bakerySession}?department=bakery`)
      .set(authHeader(adminToken))).body);
    expect(retailView.department).toBe("retail");
    expect(retailView.lines.map((line) => line.product_id)).toEqual([retail.id]);
    expect(Number(retailView.lines[0].counted_qty)).toBe(2);
    expect(bakeryView.department).toBe("bakery");
    expect(bakeryView.lines.map((line) => line.product_id)).toEqual([bakery.id]);
    expect(Number(bakeryView.lines[0].counted_qty)).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [retail.id])).stock)).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakery.id])).stock)).toBe(0);
  });

  async function balances(productId) {
    const product = await ctx.db.get(
      "SELECT stock, expiry_date, inventory_scope FROM products WHERE id = ?",
      [productId]
    );
    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    const invoices = await ctx.db.get("SELECT COUNT(*) AS n FROM purchase_invoices");
    const batches = await ctx.db.all(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date",
      [productId]
    );
    const places = await ctx.db.all(
      `SELECT w.type, s.expiry_date, s.quantity
         FROM warehouse_batch_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ?
        ORDER BY w.type, s.expiry_date`,
      [productId]
    );
    const lots = await ctx.db.all(
      `SELECT expiry_date, quantity, supplier_id, provenance, purchase_invoice_id
         FROM stock_source_lots
        WHERE product_id = ? AND quantity > 0.0000001
        ORDER BY expiry_date, id`,
      [productId]
    );
    return {
      stock: Number(product.stock),
      productExpiry: product.expiry_date,
      scope: product.inventory_scope,
      supplierBalance: Number(supplier.balance),
      invoices: Number(invoices.n),
      batches: batches.map((row) => [row.expiry_date, Number(row.quantity)]),
      places: places.map((row) => [row.type, row.expiry_date || null, Number(row.quantity)]),
      lots: lots.map((row) => ({
        expiry: row.expiry_date || null,
        quantity: Number(row.quantity),
        supplier_id: row.supplier_id,
        provenance: row.provenance,
        purchase_invoice_id: row.purchase_invoice_id,
      })),
    };
  }

  test("a new expiry on undated stock is saved, reopened, and posted as a reclassification", async () => {
    const product = await makeProduct("جرد تاريخ جديد");
    const discovered = "2027-01-15";
    await receive(product.id, 10, null);
    await ctx.db.run("UPDATE products SET expiry_date = ? WHERE id = ?", ["2031-03-03", product.id]);
    const before = await balances(product.id);
    expect(before.stock).toBe(10);
    expect(before.batches).toEqual([]);

    const sessionId = await openCount();
    const saved = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        sources: [
          { batch_source: "dated", expiry_date: discovered, counted_qty: 10 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(saved.status).toBe(200);
    const drafted = await balances(product.id);
    expect(drafted.stock).toBe(before.stock);
    expect(drafted.supplierBalance).toBe(before.supplierBalance);
    expect(drafted.invoices).toBe(before.invoices);
    expect(drafted.batches).toEqual([]);

    const reopened = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${sessionId}`)
      .set(authHeader(adminToken))).body);
    const mine = reopened.lines.filter((line) => line.product_id === product.id);
    expect(mine).toHaveLength(2);
    expect(mine.find((line) => line.batch_source === "dated")).toMatchObject({
      expiry_date: discovered,
      counted_qty: 10,
    });
    expect(Number(mine.find((line) => line.batch_source === "undated").counted_qty)).toBe(0);

    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const after = await balances(product.id);
    expect(after.stock).toBe(10);
    expect(after.productExpiry).toBe("2031-03-03");
    expect(after.batches).toEqual([[discovered, 10]]);
    expect(after.supplierBalance).toBe(before.supplierBalance);
    expect(after.invoices).toBe(before.invoices);
    expect(after.places).toEqual([["main", discovered, 10]]);
    expect(after.lots).toEqual([
      expect.objectContaining({
        expiry: discovered,
        quantity: 10,
        supplier_id: supplierId,
        provenance: "receipt",
      }),
    ]);
    expect(after.lots[0].purchase_invoice_id).toBeTruthy();
    const again = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(again.status).toBe(400);
    expect(await balances(product.id)).toMatchObject({ stock: 10, batches: [[discovered, 10]] });
  });

  test("new dates, blank expiry, explicit zero, invalid dates, and an extra batch stay consistent", async () => {
    const fresh = await makeProduct("جرد أول تاريخ");
    const sessionId = await openCount();
    const first = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: fresh.id,
        sources: [{ batch_source: "dated", expiry_date: "2027-08-01", counted_qty: 5 }],
      });
    expect(first.status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sessionId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const created = await balances(fresh.id);
    expect(created.stock).toBe(5);
    expect(created.batches).toEqual([["2027-08-01", 5]]);
    expect(created.lots).toEqual([
      expect.objectContaining({ expiry: "2027-08-01", quantity: 5, supplier_id: null, provenance: "unknown", purchase_invoice_id: null }),
    ]);

    const held = await makeProduct("جرد تاريخ قائم");
    const existing = addShopDays(shopTodayYmd(), 30);
    const extra = "2028-02-02";
    await receive(held.id, 4, existing);
    const beforeInvoices = (await balances(held.id)).invoices;
    const beforeBalance = (await balances(held.id)).supplierBalance;
    const second = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${second}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: held.id,
        sources: [
          { batch_source: "dated", expiry_date: existing, counted_qty: 4 },
          { batch_source: "dated", expiry_date: extra, counted_qty: 3 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      })).status).toBe(200);
    const duplicate = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${second}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: held.id,
        sources: [
          { batch_source: "dated", expiry_date: extra, counted_qty: 1 },
          { batch_source: "dated", expiry_date: extra, counted_qty: 2 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
          { batch_source: "dated", expiry_date: existing, counted_qty: 4 },
        ],
      });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code || unwrap(duplicate.body).code).toBe("DUPLICATE_SOURCE");
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${second}/post`)
      .set(authHeader(adminToken))
      .send({})).status).toBe(200);
    const heldAfter = await balances(held.id);
    expect(heldAfter.stock).toBe(7);
    expect(heldAfter.batches).toEqual([[existing, 4], [extra, 3]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(heldAfter.invoices).toBe(beforeInvoices);
    expect(heldAfter.supplierBalance).toBe(beforeBalance);
    expect(heldAfter.lots.find((lot) => lot.expiry === existing)).toMatchObject({
      quantity: 4,
      supplier_id: supplierId,
      provenance: "receipt",
    });
    expect(heldAfter.lots.find((lot) => lot.expiry === extra)).toMatchObject({
      quantity: 3,
      supplier_id: null,
      provenance: "unknown",
    });

    const split = await makeProduct("جرد تاريخان جديدان");
    await receive(split.id, 10, null);
    const third = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${third}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: split.id,
        sources: [
          { batch_source: "dated", expiry_date: "2027-03-01", counted_qty: 6 },
          { batch_source: "dated", expiry_date: "2027-09-01", counted_qty: 4 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      })).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${third}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const splitAfter = await balances(split.id);
    expect(splitAfter.stock).toBe(10);
    expect(splitAfter.batches).toEqual([["2027-03-01", 6], ["2027-09-01", 4]]);
    expect(splitAfter.places.filter((row) => row[0] === "main").map((row) => row[2]).reduce((sum, qty) => sum + qty, 0)).toBe(10);
    expect(splitAfter.lots.reduce((sum, lot) => sum + lot.quantity, 0)).toBe(10);

    const omitted = await makeProduct("جرد ناقص تاريخ جديد");
    await receive(omitted.id, 10, null);
    const fourth = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${fourth}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: omitted.id,
        sources: [{ expiry_date: "2027-01-15", counted_qty: 10 }],
      })).status).toBe(200);
    const incomplete = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${fourth}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(incomplete.status).toBe(200);
    expect((await balances(omitted.id)).stock).toBe(10);
    expect((await balances(omitted.id)).batches).toEqual([["2027-01-15", 10]]);

    const invalidId = await openCount();
    const invalid = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${invalidId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: fresh.id,
        sources: [{ batch_source: "dated", expiry_date: "2026-02-31", counted_qty: 1 }],
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code || unwrap(invalid.body).code).toBe("INVALID_EXPIRY");
    const storedToday = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM stock_count_lines
        WHERE session_id = ? AND IFNULL(expiry_date, '') = ?`,
      [invalidId, shopTodayYmd()]
    );
    expect(Number(storedToday.n)).toBe(0);

    const zeroDate = await makeProduct("جرد صفر لتاريخ جديد");
    await ctx.db.run("UPDATE products SET stock = 4 WHERE id = ?", [zeroDate.id]);
    const fifth = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${fifth}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: zeroDate.id,
        sources: [
          { batch_source: "dated", expiry_date: "2027-05-05", counted_qty: 0 },
          { batch_source: "undated", expiry_date: null, counted_qty: 4 },
        ],
      })).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${fifth}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const zeroAfter = await balances(zeroDate.id);
    expect(zeroAfter.stock).toBe(4);
    expect(zeroAfter.batches).toEqual([]);

    const expiredProduct = await makeProduct("جرد منتهي");
    await receive(expiredProduct.id, 10, null);
    const sixth = await openCount();
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sixth}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: expiredProduct.id,
        sources: [
          { batch_source: "dated", expiry_date: "2020-01-15", counted_qty: 10 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      })).status).toBe(200);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${sixth}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    expect((await balances(expiredProduct.id)).batches).toEqual([["2020-01-15", 10]]);
    expect(await sellableQuantity(ctx.db, expiredProduct.id)).toBe(0);
  });

  test("bakery and retail keep their own new expiry lines", async () => {
    const retail = await makeProduct("متجر بتاريخ", "retail");
    const bakery = await makeProduct("طحين بتاريخ", "bakery");
    const retailSession = await openCount();
    const bakerySession = unwrap((await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department: "bakery" })).body).id;
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: retail.id,
        sources: [{ batch_source: "dated", expiry_date: "2027-04-04", counted_qty: 2 }],
      })).status).toBe(200);
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: bakery.id,
        department: "bakery",
        sources: [{ batch_source: "dated", expiry_date: "2027-05-05", counted_qty: 1 }],
      })).status).toBe(200);
    const retailView = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${retailSession}?department=retail`)
      .set(authHeader(adminToken))).body);
    const bakeryView = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${bakerySession}?department=bakery`)
      .set(authHeader(adminToken))).body);
    expect(retailView.department).toBe("retail");
    expect(retailView.lines.map((line) => [line.product_id, line.expiry_date, Number(line.counted_qty)]))
      .toEqual([[retail.id, "2027-04-04", 2]]);
    expect(bakeryView.department).toBe("bakery");
    expect(bakeryView.lines.map((line) => [line.product_id, line.expiry_date, Number(line.counted_qty)]))
      .toEqual([[bakery.id, "2027-05-05", 1]]);
    expect((await balances(retail.id)).scope).toBe("retail");
    expect((await balances(bakery.id)).scope).toBe("bakery");
  });

  test("stock sources expose each warehouse quantity instead of a company total", async () => {
    const product = await makeProduct("جرد مستودعين");
    await ctx.db.run("UPDATE products SET unit = ? WHERE id = ?", ["حبة", product.id]);
    await receive(product.id, 10, "2027-08-01");
    const places = await balances(product.id);
    const main = places.places.find((row) => row[0] === "main");
    expect(main).toBeTruthy();
    const returnsWh = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'returns'");
    await ctx.db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, '2027-08-01', 3)`,
      [returnsWh.id, product.id]
    );
    const res = await request(ctx.app)
      .get("/api/v1/inventory/stock-sources")
      .query({ product_id: product.id })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = unwrap(res.body);
    expect(body.unit).toBeTruthy();
    expect(body.main_warehouse_id).toBeTruthy();
    const dated = body.locations.filter((row) => row.expiry_date === "2027-08-01");
    expect(dated.map((row) => [row.warehouse_type, row.quantity]).sort()).toEqual([
      ["main", main[2]],
      ["returns", 3],
    ]);
    expect(dated.reduce((sum, row) => sum + row.quantity, 0)).not.toBe(body.product_stock);
  });
});
