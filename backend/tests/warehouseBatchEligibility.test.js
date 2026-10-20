/**
 * Eligibility, expired-stock transfer, supplier return, and legacy reconciliation.
 * Uses a disposable database and a fixed Asia/Hebron calendar date.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";
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

const CLOCK = "2026-10-05";
const EXPIRED = "2026-09-01";
const FRESH = "2026-12-01";

function unwrap(body) {
  return body?.data ?? body;
}

function noonOf(ymd) {
  return new Date(shopYmdToUtcBounds(ymd).startIso).getTime() + 12 * 60 * 60 * 1000;
}

jest.setTimeout(60000);

describe("warehouse batch eligibility", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let main;
  let returnsWh;

  beforeEach(async () => {
    jest.useFakeTimers({
      now: noonOf(CLOCK),
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
    });
    ctx = await createTestContext();
    if (!/abo-shalbak-test-/.test(ctx.dbPath)) throw new Error("refusing non-temporary database");
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    supplierId = (await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد الأهلية', 'S-ELIG', 0, 0)"
    )).lastID;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 200 });
    expect(shift.status).toBe(201);
    const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
    main = warehouses.find((row) => row.type === "main");
    returnsWh = warehouses.find((row) => row.type === "returns");
    expect(shopTodayYmd()).toBe(CLOCK);
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (ctx) await destroyTestContext(ctx);
  });

  async function makeProduct(name = "صنف الأهلية") {
    const barcode = `88${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 9)}`;
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

  async function receive(productId, lines) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, invoice_date: CLOCK, items: lines.map((line) => ({ product_id: productId, ...line })) });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
  }

  async function posStock(product) {
    const search = await request(ctx.app)
      .get("/api/v1/pos/search")
      .query({ q: product.barcode })
      .set(authHeader(cashierToken));
    const hit = (unwrap(search.body) || []).find((row) => Number(row.id) === product.id);
    return hit ? Number(hit.stock) : null;
  }

  async function sell(productId, quantity, key) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: 8 }],
        payment_method: "cash",
      }, key));
  }

  async function locations(productId) {
    const rows = await ctx.db.all(
      `SELECT w.type, s.expiry_date, s.quantity
         FROM warehouse_batch_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ?
        ORDER BY w.type, s.expiry_date`,
      [productId]
    );
    return rows.map((row) => ({
      type: row.type,
      expiry_date: row.expiry_date || null,
      quantity: Number(row.quantity),
    }));
  }

  test("a sale before the physical transfer consumes only the fresh lot", async () => {
    const product = await makeProduct();
    await receive(product.id, [
      { quantity: 5, total_cost: 20, expiry_date: EXPIRED },
      { quantity: 10, total_cost: 40, expiry_date: FRESH },
    ]);
    expect(await posStock(product)).toBe(10);
    const sale = await sell(product.id, 3, "elig-before-transfer");
    expect(sale.status).toBe(201);
    expect(await locations(product.id)).toEqual([
      { type: "main", expiry_date: EXPIRED, quantity: 5 },
      { type: "main", expiry_date: FRESH, quantity: 7 },
    ]);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(12);
  });

  test("the expiry action moves only the selected expired quantity and leaves company stock", async () => {
    const product = await makeProduct();
    await receive(product.id, [
      { quantity: 5, total_cost: 20, expiry_date: EXPIRED },
      { quantity: 10, total_cost: 40, expiry_date: FRESH },
    ]);
    const listed = await request(ctx.app)
      .get("/api/v1/warehouses/expired-on-main")
      .set(authHeader(adminToken));
    const rows = unwrap(listed.body).filter((row) => Number(row.product_id) === product.id);
    expect(rows).toEqual([expect.objectContaining({ expiry_date: EXPIRED, quantity: 5, batch_source: "dated" })]);

    const invalid = await request(ctx.app)
      .post("/api/v1/warehouses/transfers/expired")
      .set(authHeader(adminToken))
      .send({ items: [{ product_id: product.id, quantity: 0, expiry_date: EXPIRED, batch_source: "dated" }] });
    expect(invalid.status).toBe(400);
    expect(unwrap(invalid.body).code).toBe("VALIDATION_ERROR");
    const tooMuch = await request(ctx.app)
      .post("/api/v1/warehouses/transfers/expired")
      .set(authHeader(adminToken))
      .send({ items: [{ product_id: product.id, quantity: 8, expiry_date: EXPIRED, batch_source: "dated" }] });
    expect(tooMuch.status).toBe(400);
    expect(unwrap(tooMuch.body).code).toBe("INSUFFICIENT_WAREHOUSE_QTY");
    expect(await locations(product.id)).toEqual([
      { type: "main", expiry_date: EXPIRED, quantity: 5 },
      { type: "main", expiry_date: FRESH, quantity: 10 },
    ]);

    const posted = await request(ctx.app)
      .post("/api/v1/warehouses/transfers/expired")
      .set(authHeader(adminToken))
      .send({
        items: [{ product_id: product.id, quantity: 5, expiry_date: EXPIRED, batch_source: "dated" }],
      });
    expect(posted.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(15);
    expect(await locations(product.id)).toEqual([
      { type: "main", expiry_date: FRESH, quantity: 10 },
      { type: "returns", expiry_date: EXPIRED, quantity: 5 },
    ]);
    expect(await posStock(product)).toBe(10);
    const again = unwrap((await request(ctx.app).get("/api/v1/warehouses/expired-on-main").set(authHeader(adminToken))).body);
    expect(again.filter((row) => Number(row.product_id) === product.id)).toEqual([]);

    const repeat = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(posted.body).id}/post`)
      .set(authHeader(adminToken));
    expect(repeat.status).toBe(400);
    expect(await locations(product.id)).toEqual([
      { type: "main", expiry_date: FRESH, quantity: 10 },
      { type: "returns", expiry_date: EXPIRED, quantity: 5 },
    ]);
  });

  test("fresh and undated stock in مرتجعات is not sellable", async () => {
    const product = await makeProduct();
    await receive(product.id, [
      { quantity: 4, total_cost: 16, expiry_date: FRESH },
      { quantity: 3, total_cost: 12 },
    ]);
    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [
          { product_id: product.id, quantity: 4, expiry_date: FRESH, batch_source: "dated" },
          { product_id: product.id, quantity: 3, batch_source: "undated" },
        ],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    expect(await posStock(product)).toBe(0);
    const sale = await sell(product.id, 1, "elig-returns-excluded");
    expect(sale.status).toBe(201);
    expect(await locations(product.id)).toEqual([
      { type: "main", expiry_date: null, quantity: -1 },
      { type: "returns", expiry_date: null, quantity: 3 },
      { type: "returns", expiry_date: FRESH, quantity: 4 },
    ]);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(6);
  });

  test("today remains sellable and yesterday does not, including the local midnight", async () => {
    const product = await makeProduct();
    await receive(product.id, [
      { quantity: 2, total_cost: 8, expiry_date: "2026-10-04" },
      { quantity: 2, total_cost: 8, expiry_date: "2026-10-05" },
    ]);
    expect(await posStock(product)).toBe(2);
    const yesterdaySale = await sell(product.id, 2, "elig-today");
    expect(yesterdaySale.status).toBe(201);
    const expiredLeft = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = '2026-10-04'",
      [product.id]
    );
    expect(Number(expiredLeft.quantity)).toBe(2);

    jest.setSystemTime(new Date(shopYmdToUtcBounds(CLOCK).startIso).getTime() - 1000);
    expect(shopTodayYmd()).toBe("2026-10-04");
    const other = await makeProduct("قبل منتصف الليل");
    await receive(other.id, [
      { quantity: 1, total_cost: 4, expiry_date: "2026-10-04" },
    ]);
    expect(await posStock(other)).toBe(1);
  });

  test("fractional eligible quantity sells and duplicate transfer lines roll back", async () => {
    const product = await makeProduct("صنف وزني");
    await ctx.db.run("UPDATE products SET is_weighed = 1 WHERE id = ?", [product.id]);
    await ctx.db.run(
      "UPDATE product_units SET unit_name = 'كغم' WHERE product_id = ?",
      [product.id]
    );
    await receive(product.id, [
      { quantity: 0.5, total_cost: 2, expiry_date: EXPIRED },
      { quantity: 1.5, total_cost: 6, expiry_date: FRESH },
    ]);
    const sale = await sell(product.id, 1.25, "elig-fraction");
    expect(sale.status).toBe(201);
    const fresh = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, FRESH]
    );
    expect(Number(fresh.quantity)).toBeCloseTo(0.25, 6);
    const tooMuch = await sell(product.id, 0.5, "elig-fraction-over");
    expect(tooMuch.status).toBe(201);
    const freshAfter = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, FRESH]
    );
    expect(Number(freshAfter.quantity)).toBeCloseTo(0, 6);
    const expiredLeft = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, EXPIRED]
    );
    expect(Number(expiredLeft.quantity)).toBeCloseTo(0.5, 6);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBeCloseTo(0.25, 6);

    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [
          { product_id: product.id, quantity: 0.4, expiry_date: EXPIRED, batch_source: "dated" },
          { product_id: product.id, quantity: 0.4, expiry_date: EXPIRED, batch_source: "dated" },
        ],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(400);
    const saved = await ctx.db.get("SELECT status FROM warehouse_transfers WHERE id = ?", [unwrap(draft.body).id]);
    expect(saved.status).toBe("draft");
    const expired = await ctx.db.get(
      `SELECT w.type, s.quantity FROM warehouse_batch_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ? AND s.expiry_date = ?`,
      [product.id, EXPIRED]
    );
    expect(expired.type).toBe("main");
    expect(Number(expired.quantity)).toBeCloseTo(0.5, 6);
  });

  test("a stale transfer quantity is rejected after an intervening sale", async () => {
    const product = await makeProduct();
    await receive(product.id, [{ quantity: 4, total_cost: 16, expiry_date: FRESH }]);
    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 4, expiry_date: FRESH, batch_source: "dated" }],
      });
    expect(draft.status).toBe(201);
    const sale = await sell(product.id, 1, "elig-stale-sale");
    expect(sale.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(400);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(3);
    const where = await locations(product.id);
    expect(where).toEqual([{ type: "main", expiry_date: FRESH, quantity: 3 }]);
  });

  test("two checkouts cannot both take the last eligible unit", async () => {
    const product = await makeProduct();
    await receive(product.id, [
      { quantity: 5, total_cost: 20, expiry_date: EXPIRED },
      { quantity: 1, total_cost: 4, expiry_date: FRESH },
    ]);
    const [a, b] = await Promise.all([
      sell(product.id, 1, "elig-race-a"),
      sell(product.id, 1, "elig-race-b"),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(4);
    const sales = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?",
      [product.id]
    );
    expect(Number(sales.n)).toBe(2);
    const fresh = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = ?",
      [product.id, FRESH]
    );
    expect(Number(fresh.quantity)).toBe(0);
  });

  test("legacy warehouse offsets stay unreconciled until an explicit physical count", async () => {
    const product = await ctx.db.get("SELECT id, stock FROM products WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, 2)",
      [returnsWh.id, product.id]
    );
    await closeSqliteConnection(ctx.db);
    ctx.db = await initDatabase(ctx.dbPath);
    const status = await ctx.db.get("SELECT location_status, stock FROM products WHERE id = ?", [product.id]);
    expect(status.location_status).toBe("needs_reconciliation");
    expect(Number(status.stock)).toBe(Number(product.stock));
    const guessed = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE product_id = ?",
      [product.id]
    );
    expect(Number(guessed.n)).toBe(0);
    await closeSqliteConnection(ctx.db);
    ctx.db = await initDatabase(ctx.dbPath);
    ctx.app = createApp(ctx.db, ctx.dbPath);
    const again = await ctx.db.get("SELECT location_status, stock FROM products WHERE id = ?", [product.id]);
    expect(again.location_status).toBe("needs_reconciliation");
    expect(Number(again.stock)).toBe(Number(product.stock));

    const sold = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: 10 }],
        payment_method: "cash",
      }, "elig-legacy-sale"));
    expect(sold.status).toBe(201);
    const afterSale = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    expect(afterSale).toBe(Number(product.stock) - 1);

    const named = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 1, batch_source: "undated" }],
      });
    expect(named.status).toBe(201);
    const namedPost = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(named.body).id}/post`)
      .set(authHeader(adminToken));
    expect(namedPost.status).toBe(400);

    const qtyOnly = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 1 }],
      });
    expect(qtyOnly.status).toBe(201);
    const qtyPost = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(qtyOnly.body).id}/post`)
      .set(authHeader(adminToken));
    expect(qtyPost.status).toBe(200);
    const still = await ctx.db.get("SELECT location_status, stock FROM products WHERE id = ?", [product.id]);
    expect(still.location_status).toBe("needs_reconciliation");
    expect(Number(still.stock)).toBe(afterSale);

    const dated = await ctx.db.get(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM product_batches WHERE product_id = ?",
      [product.id]
    );
    const undated = Number(still.stock) - Number(dated.qty);
    const badCount = await request(ctx.app)
      .post("/api/v1/warehouses/reconcile")
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        lines: [{ warehouse_id: main.id, batch_source: "undated", quantity: undated - 1 }],
      });
    expect(badCount.status).toBe(400);
    const counted = await request(ctx.app)
      .post("/api/v1/warehouses/reconcile")
      .set(authHeader(adminToken))
      .send({
        product_id: product.id,
        lines: [
          { warehouse_id: main.id, batch_source: "undated", quantity: undated - 3 },
          { warehouse_id: returnsWh.id, batch_source: "undated", quantity: 3 },
        ],
      });
    expect(counted.status).toBe(200);
    const located = await ctx.db.get("SELECT location_status, stock FROM products WHERE id = ?", [product.id]);
    expect(located.location_status).toBe("located");
    expect(Number(located.stock)).toBe(afterSale);
    const placed = await locations(product.id);
    expect(placed.reduce((sum, row) => sum + row.quantity, 0)).toBe(afterSale);
  });
});
