/**
 * Expiry-report reset waits for a stock count that explicitly verifies dates.
 * Uses the disposable test database only.
 */
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import { shopTodayYmd, addShopDays } from "../utils/shopTime.js";
import { sellableQuantity } from "../services/warehouseBatchStock.js";
import { EXPIRY_REPORT_AWAITING_MESSAGE } from "../services/expiryReportCycle.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
} from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("expiry report reset cycle", () => {
  let ctx;
  let adminToken;
  let supplierId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد صلاحية', 'S-EXP', 0, 0)"
    );
    supplierId = sup.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.db.run("DELETE FROM stock_count_sessions WHERE status = 'open'");
  });

  async function makeProduct(name, scope = "retail", { stock = 0, expiry = null } = {}) {
    seq += 1;
    const barcode = `${scope === "bakery" ? "86" : "76"}${String(seq).padStart(8, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope, expiry_date)
       VALUES (?, ?, 8, 2, 'Test', ?, ?, ?)`,
      [barcode, name, stock, scope, expiry]
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

  async function reset(scope, reason = "تواريخ خاطئة") {
    const res = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(adminToken))
      .send({ scope, confirm: true, reason });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function cycle(scope) {
    const res = await request(ctx.app)
      .get("/api/v1/inventory/expiry-cycle")
      .query({ scope })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function report(days = 30, membership = null) {
    const query = membership ? `?days=${days}&membership=${membership}` : `?days=${days}`;
    const res = await request(ctx.app)
      .get(`/api/v1/inventory/expiry${query}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  function rowsFor(rows, productId) {
    return rows.filter((row) => Number(row.product_id) === Number(productId) || Number(row.id) === Number(productId));
  }

  async function openCount(department) {
    const res = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department });
    expect(res.status).toBe(201);
    return unwrap(res.body).id;
  }

  async function saveLines(sessionId, department, productId, sources) {
    const res = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: productId, department, sources });
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function postCount(sessionId, department) {
    return request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({ department });
  }

  async function fingerprint() {
    const stock = await ctx.db.get("SELECT COALESCE(SUM(stock), 0) AS s FROM products");
    const batches = await ctx.db.get("SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM product_batches");
    const ledger = await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger");
    const tx = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const items = await ctx.db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(gross_profit), 0) AS g FROM transaction_items"
    );
    return {
      stock: Number(stock.s),
      batches: Number(batches.n),
      batchQty: Number(batches.q),
      ledger: Number(ledger.n),
      tx: Number(tx.n),
      items: Number(items.n),
      profit: Number(items.g),
    };
  }

  test("reset clears the active report and keeps stock, dates, and financial history", async () => {
    const soon = addShopDays(shopTodayYmd(), 4);
    const product = await makeProduct("صلاحية قبل الضبط");
    await receive(product.id, 6, soon);
    const beforeSellable = await sellableQuantity(ctx.db, product.id);
    const before = await fingerprint();
    const batchBefore = await ctx.db.get(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ?",
      [product.id]
    );

    const body = await reset("retail", "تواريخ خاطئة");
    expect(body.status).toBe("awaiting_count");
    expect(body.message).toBe(EXPIRY_REPORT_AWAITING_MESSAGE);
    expect(body.business_day).toBe(shopTodayYmd());
    expect(body.reset_reason).toBe("تواريخ خاطئة");

    const rows = rowsFor(await report(), product.id);
    expect(rows).toEqual([]);
    const near = unwrap((await request(ctx.app)
      .get("/api/v1/reports/near-expiry")
      .set(authHeader(adminToken))).body);
    expect(near.message).toBe(EXPIRY_REPORT_AWAITING_MESSAGE);
    expect((near.items || []).some((row) => row.barcode === product.barcode)).toBe(false);

    expect(await fingerprint()).toEqual(before);
    const batchAfter = await ctx.db.get(
      "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ?",
      [product.id]
    );
    expect(batchAfter).toEqual(batchBefore);
    expect(await sellableQuantity(ctx.db, product.id)).toBe(beforeSellable);

    const audit = await ctx.db.get(
      "SELECT user_id, action, entity_type, new_value FROM audit_logs WHERE action = 'EXPIRY_REPORT_RESET' ORDER BY id DESC LIMIT 1"
    );
    const payload = JSON.parse(audit.new_value);
    expect(audit.user_id).toBeTruthy();
    expect(audit.entity_type).toBe("expiry_report_cycles");
    expect(payload.scope).toBe("retail");
    expect(payload.reason).toBe("تواريخ خاطئة");
    expect(payload.reset_at).toBeTruthy();

    const db2 = await initDatabase(ctx.dbPath);
    const stored = await db2.get(
      "SELECT status, reset_reason FROM expiry_report_cycles WHERE scope = 'retail' AND status = 'open'"
    );
    expect(stored.reset_reason).toBe("تواريخ خاطئة");
    await closeSqliteConnection(db2);
    expect((await cycle("retail")).status).toBe("awaiting_count");
  });

  test("a second reset does not duplicate the open cycle or the stock", async () => {
    const product = await makeProduct("ضبط مكرر");
    await receive(product.id, 3, addShopDays(shopTodayYmd(), 5));
    const before = await fingerprint();
    await reset("retail", "المحاولة الأولى");
    await reset("retail", "المحاولة الثانية");
    const open = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM expiry_report_cycles WHERE scope = 'retail' AND status = 'open'"
    );
    expect(Number(open.n)).toBe(1);
    expect((await cycle("retail")).reset_reason).toBe("المحاولة الثانية");
    expect(rowsFor(await report(), product.id)).toEqual([]);
    expect(await fingerprint()).toEqual(before);
  });

  test("draft, cancelled, quantity-only, and unrelated counts do not resume the report", async () => {
    const soon = addShopDays(shopTodayYmd(), 6);
    const retail = await makeProduct("سوبرماركت معلّق");
    const bakery = await makeProduct("مخبز منفصل", "bakery");
    await receive(retail.id, 4, soon);
    await receive(bakery.id, 2, soon);
    await reset("retail", "إيقاف السوبرماركت");
    expect(rowsFor(await report(), bakery.id).length).toBeGreaterThan(0);

    const draftId = await openCount("retail");
    await saveLines(draftId, "retail", retail.id, [
      { batch_source: "dated", expiry_date: soon, counted_qty: 4, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await cycle("retail")).status).toBe("awaiting_count");
    expect(rowsFor(await report(), retail.id)).toEqual([]);
    const cancelled = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${draftId}/cancel`)
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(cancelled.status).toBe(200);
    expect((await cycle("retail")).status).toBe("awaiting_count");

    const qtyProduct = await makeProduct("كمية فقط", "retail", { stock: 5, expiry: soon });
    await reset("retail", "بعد الكمية");
    const qtySession = await openCount("retail");
    await saveLines(qtySession, "retail", qtyProduct.id, [
      { counted_qty: 2, expiry_verified: true },
    ]);
    const qtyPost = await postCount(qtySession, "retail");
    expect(qtyPost.status).toBe(200);
    const qtyRow = await ctx.db.get("SELECT stock, expiry_date FROM products WHERE id = ?", [qtyProduct.id]);
    expect(Number(qtyRow.stock)).toBe(2);
    expect(String(qtyRow.expiry_date).slice(0, 10)).toBe(soon);
    expect((await cycle("retail")).status).toBe("awaiting_count");
    expect(rowsFor(await report(), qtyProduct.id)).toEqual([]);
    const verified = await ctx.db.get(
      `SELECT COUNT(*) AS n
         FROM expiry_report_verifications v
         JOIN expiry_report_cycles c ON c.id = v.cycle_id
        WHERE c.status = 'open' AND c.scope = 'retail'`
    );
    expect(Number(verified.n)).toBe(0);

    const bakerySession = await openCount("bakery");
    await saveLines(bakerySession, "bakery", bakery.id, [
      { batch_source: "dated", expiry_date: soon, counted_qty: 2, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(bakerySession, "bakery")).status).toBe(200);
    expect((await cycle("retail")).status).toBe("awaiting_count");
    expect(rowsFor(await report(), retail.id)).toEqual([]);
  });

  test("a finalized count with a verified date tracks older stock and later receipts", async () => {
    const expired = addShopDays(shopTodayYmd(), -3);
    const soon = addShopDays(shopTodayYmd(), 8);
    const far = addShopDays(shopTodayYmd(), 50);
    const counted = await makeProduct("مجرود قديم");
    const untouched = await makeProduct("لم يُجرَد");
    await receive(counted.id, 5, expired);
    await receive(untouched.id, 4, soon);
    await reset("retail", "قبل الجرد المعتمد");

    const arrivedDuringWait = await makeProduct("وصل أثناء الانتظار");
    await receive(arrivedDuringWait.id, 2, soon);
    expect(rowsFor(await report(), arrivedDuringWait.id)).toEqual([]);
    expect(rowsFor(await report(), counted.id)).toEqual([]);

    const sessionId = await openCount("retail");
    await saveLines(sessionId, "retail", counted.id, [
      { batch_source: "dated", expiry_date: expired, counted_qty: 5, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(sessionId, "retail")).status).toBe(200);
    const again = await postCount(sessionId, "retail");
    expect(again.status).toBe(400);

    const visible = rowsFor(await report(30), counted.id);
    expect(visible).toHaveLength(1);
    expect(visible[0].expiry_date.slice(0, 10)).toBe(expired);
    expect(Number(visible[0].stock)).toBe(5);
    expect(rowsFor(await report(), untouched.id)).toEqual([]);
    expect((await cycle("retail")).status).toBe("partial");

    const later = await makeProduct("وصل بعد الجرد");
    await receive(later.id, 3, soon);
    await receive(later.id, 1, far);
    const laterRows = rowsFor(await report(30), later.id);
    expect(laterRows.map((row) => row.expiry_date.slice(0, 10))).toEqual([soon]);
    const wide = rowsFor(await report(60), later.id).map((row) => row.expiry_date.slice(0, 10)).sort();
    expect(wide).toEqual([far, soon].sort());

    const duplicate = rowsFor(await report(), counted.id);
    expect(duplicate).toHaveLength(1);
  });

  test("a verified count corrects the date without rewriting the product expiry field", async () => {
    const wrong = addShopDays(shopTodayYmd(), 3);
    const right = addShopDays(shopTodayYmd(), 12);
    const product = await makeProduct("تاريخ يُصحح", "retail", { stock: 8, expiry: wrong });
    await reset("retail", "تصحيح التاريخ");
    const sessionId = await openCount("retail");
    await saveLines(sessionId, "retail", product.id, [
      { batch_source: "dated", expiry_date: right, counted_qty: 8, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(sessionId, "retail")).status).toBe(200);
    const saved = await ctx.db.get("SELECT stock, expiry_date FROM products WHERE id = ?", [product.id]);
    expect(Number(saved.stock)).toBe(8);
    expect(String(saved.expiry_date).slice(0, 10)).toBe(wrong);
    const rows = rowsFor(await report(), product.id);
    expect(rows.map((row) => row.expiry_date.slice(0, 10))).toEqual([right]);
    expect(rows.some((row) => row.source === "product")).toBe(false);
  });

  test("verification covers only the counted warehouse", async () => {
    const soon = addShopDays(shopTodayYmd(), 9);
    const product = await makeProduct("مستودعان");
    await receive(product.id, 10, soon);
    const main = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'main' AND active = 1");
    const returnsWh = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'returns' AND active = 1");
    const located = await ctx.db.get(
      "SELECT id, quantity FROM warehouse_batch_stock WHERE product_id = ? AND warehouse_id = ? AND expiry_date = ?",
      [product.id, main.id, soon]
    );
    expect(Number(located.quantity)).toBe(10);
    await ctx.db.run("UPDATE warehouse_batch_stock SET quantity = 6 WHERE id = ?", [located.id]);
    await ctx.db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, ?, 4)`,
      [returnsWh.id, product.id, soon]
    );
    await reset("retail", "فصل المستودع");
    const sessionId = await openCount("retail");
    await saveLines(sessionId, "retail", product.id, [
      { batch_source: "dated", expiry_date: soon, counted_qty: 6, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(sessionId, "retail")).status).toBe(200);
    const rows = rowsFor(await report(), product.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].stock)).toBe(6);
    const batch = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, soon]
    );
    expect(Number(batch.quantity)).toBe(10);
  });

  test("bakery and supermarket cycles resume separately", async () => {
    const soon = addShopDays(shopTodayYmd(), 7);
    const retail = await makeProduct("بيع");
    const bakery = await makeProduct("طحين الصلاحية", "bakery");
    await receive(retail.id, 2, soon);
    await receive(bakery.id, 2, soon);
    await reset("bakery", "مخبز فقط");
    expect(rowsFor(await report(), retail.id).length).toBeGreaterThan(0);
    expect(rowsFor(await report(30, "bakery"), bakery.id)).toEqual([]);
    expect((await cycle("bakery")).message).toBe(EXPIRY_REPORT_AWAITING_MESSAGE);
    expect((await cycle("retail")).scope).toBe("retail");

    const retailSession = await openCount("retail");
    await saveLines(retailSession, "retail", retail.id, [
      { batch_source: "dated", expiry_date: soon, counted_qty: 2, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(retailSession, "retail")).status).toBe(200);
    expect(rowsFor(await report(30, "bakery"), bakery.id)).toEqual([]);

    const bakerySession = await openCount("bakery");
    await saveLines(bakerySession, "bakery", bakery.id, [
      { batch_source: "dated", expiry_date: soon, counted_qty: 2, expiry_verified: true },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect((await postCount(bakerySession, "bakery")).status).toBe(200);
    expect(rowsFor(await report(30, "bakery"), bakery.id)).toHaveLength(1);
  });

  test("users without the inventory permission cannot reset the report", async () => {
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const cashier = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(cashierToken))
      .send({ scope: "retail", confirm: true, reason: "غير مصرح" });
    expect(cashier.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "expiryonly",
      password: "acctpass123",
      permissions: { expiry: true },
    });
    const expiryToken = (await login(ctx.app, "expiryonly", "acctpass123")).body.token;
    const denied = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(expiryToken))
      .send({ scope: "retail", confirm: true, reason: "بلا جرد" });
    expect(denied.status).toBe(403);
    const stillReads = await request(ctx.app)
      .get("/api/v1/inventory/expiry?days=30")
      .set(authHeader(expiryToken));
    expect(stillReads.status).toBe(200);

    await createAccountantUser(ctx.db, {
      username: "stockonly",
      password: "acctpass123",
      permissions: { stock_count: true, expiry: true },
    });
    const stockToken = (await login(ctx.app, "stockonly", "acctpass123")).body.token;
    const missing = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(stockToken))
      .send({ scope: "retail", confirm: false, reason: "ناقص" });
    expect(missing.status).toBe(400);
    const allowed = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(stockToken))
      .send({ scope: "retail", confirm: true, reason: "مختص الجرد" });
    expect(allowed.status).toBe(201);

    await createAccountantUser(ctx.db, {
      username: "bakeryonly",
      password: "acctpass123",
      permissions: { bakery_supplies: true, expiry: true },
    });
    const bakeryToken = (await login(ctx.app, "bakeryonly", "acctpass123")).body.token;
    const retailDenied = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(bakeryToken))
      .send({ scope: "retail", confirm: true, reason: "مخبز يحاول السوبرماركت" });
    expect(retailDenied.status).toBe(403);
    const bakeryAllowed = await request(ctx.app)
      .post("/api/v1/inventory/expiry-cycle/reset")
      .set(authHeader(bakeryToken))
      .send({ scope: "bakery", confirm: true, reason: "ضبط المخبز" });
    expect(bakeryAllowed.status).toBe(201);
  });
});
