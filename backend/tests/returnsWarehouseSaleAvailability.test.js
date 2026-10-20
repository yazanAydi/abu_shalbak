/**
 * Observes the current purchase → warehouse transfer → POS sale → supplier-return
 * path on a disposable database. It does not change production behavior.
 *
 * The required result is that units in مرتجعات are not sellable. Comparisons
 * below use that requirement. A sale the current code accepts is recorded as
 * a mismatch.
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
import { shopTodayYmd, shopYmdToUtcBounds } from "../utils/shopTime.js";

const CLOCK = "2026-10-05";
const EXPIRED = "2026-09-01";
const FRESH = "2026-12-01";
const UNIT_COST = 4;
const SALE_PRICE = 8;

function unwrap(body) {
  return body?.data ?? body;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function qtyOf(rows, expiry) {
  return rows
    .filter((row) => row.expiry_date === expiry)
    .reduce((sum, row) => sum + num(row.quantity), 0);
}

jest.setTimeout(60000);

describe("returns warehouse is not sellable", () => {
  const findings = [];

  function compare(step, field, actual, expected) {
    const left = typeof actual === "number" ? num(actual) : actual;
    const right = typeof expected === "number" ? num(expected) : expected;
    findings.push({
      step,
      field,
      expected: right,
      actual: left,
      ok: JSON.stringify(left) === JSON.stringify(right),
    });
  }

  async function openShop() {
    const noon = new Date(shopYmdToUtcBounds(CLOCK).startIso).getTime() + 12 * 60 * 60 * 1000;
    jest.useFakeTimers({
      now: noon,
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
    });
    const ctx = await createTestContext();
    if (!/abo-shalbak-test-/.test(ctx.dbPath) || !/test\.db$/.test(ctx.dbPath)) {
      throw new Error(`refusing non-temporary database ${ctx.dbPath}`);
    }
    if (/supermarket\.db|[\\/]data[\\/]/i.test(ctx.dbPath)) {
      throw new Error(`refusing shop database ${ctx.dbPath}`);
    }
    const adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const supplier = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد التحقق', 'S-RET', 0, 0)`
    );
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    if (shift.status !== 201) throw new Error(`shift start ${shift.status}`);
    return { ctx, adminToken, cashierToken, supplierId: supplier.lastID };
  }

  async function closeShop(shop) {
    jest.useRealTimers();
    if (shop?.ctx) await destroyTestContext(shop.ctx);
  }

  async function makeProduct(ctx) {
    const barcode = `77${Date.now().toString().slice(-8)}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
       VALUES (?, 'صنف تحقق المرتجعات', ?, 0, 'Test', 0, 0)`,
      [barcode, SALE_PRICE]
    );
    await ctx.db.run(
      `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)`,
      [ins.lastID, barcode]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, ?, 0, 1, 1)`,
      [ins.lastID, barcode, SALE_PRICE]
    );
    return { id: ins.lastID, barcode };
  }

  async function postPurchase(shop, product) {
    const created = await request(shop.ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(shop.adminToken))
      .send({
        supplier_id: shop.supplierId,
        invoice_date: CLOCK,
        items: [
          { product_id: product.id, quantity: 5, total_cost: 5 * UNIT_COST, expiry_date: EXPIRED },
          { product_id: product.id, quantity: 10, total_cost: 10 * UNIT_COST, expiry_date: FRESH },
        ],
      });
    if (created.status !== 201) throw new Error(`purchase draft ${created.status} ${JSON.stringify(created.body)}`);
    const posted = await request(shop.ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(shop.adminToken))
      .send({});
    if (posted.status !== 200) throw new Error(`purchase post ${posted.status} ${JSON.stringify(posted.body)}`);
    return unwrap(posted.body);
  }

  async function warehousesOf(shop) {
    const rows = unwrap(
      (await request(shop.ctx.app).get("/api/v1/warehouses").set(authHeader(shop.adminToken))).body
    );
    return {
      main: rows.find((row) => row.type === "main"),
      returnsWh: rows.find((row) => row.type === "returns"),
    };
  }

  async function displayedWarehouses(shop, productId) {
    const overview = unwrap(
      (await request(shop.ctx.app)
        .get(`/api/v1/products/${productId}/overview`)
        .set(authHeader(shop.adminToken))).body
    );
    const lines = overview.warehouses || [];
    const qty = (type) => {
      const row = lines.find((line) => line.type === type);
      return row ? num(row.quantity) : 0;
    };
    return { main: qty("main"), returns: qty("returns"), lines };
  }

  async function posStock(shop, product) {
    const search = await request(shop.ctx.app)
      .get("/api/v1/pos/search")
      .query({ q: product.barcode })
      .set(authHeader(shop.cashierToken));
    const lookup = await request(shop.ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: product.barcode })
      .set(authHeader(shop.cashierToken));
    const searchRows = unwrap(search.body) || [];
    const searchHit = (Array.isArray(searchRows) ? searchRows : []).find(
      (row) => Number(row.id) === product.id
    );
    const lookupBody = unwrap(lookup.body) || {};
    return {
      searchStatus: search.status,
      lookupStatus: lookup.status,
      searchStock: searchHit ? num(searchHit.stock) : null,
      lookupStock: lookupBody.stock != null ? num(lookupBody.stock) : num(lookupBody.product?.stock),
      searchHit,
      lookupBody,
    };
  }

  async function batchesOf(db, productId) {
    return db.all(
      `SELECT id, expiry_date, quantity FROM product_batches
        WHERE product_id = ? ORDER BY expiry_date, id`,
      [productId]
    );
  }

  async function activityCounts(db, productId) {
    const sales = await db.get(
      `SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?`,
      [productId]
    );
    const payments = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(sp.amount), 0) AS amount
         FROM sale_payments sp
         JOIN transaction_items ti ON ti.transaction_id = sp.transaction_id
        WHERE ti.product_id = ?`,
      [productId]
    );
    const ledger = await db.get(
      `SELECT COUNT(*) AS n FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'sale'`,
      [productId]
    );
    const allocations = await db.get(
      `SELECT COUNT(*) AS n FROM stock_batch_allocations
        WHERE product_id = ? AND reference_type = 'transaction' AND direction = 'out'`,
      [productId]
    );
    return {
      sales: Number(sales.n),
      payments: Number(payments.n),
      paymentAmount: num(payments.amount),
      saleLedger: Number(ledger.n),
      saleAllocations: Number(allocations.n),
    };
  }

  async function receiveAndTransfer(shop, product) {
    await postPurchase(shop, product);
    const received = await displayedWarehouses(shop, product.id);
    const receivedBatches = await batchesOf(shop.ctx.db, product.id);
    const company = num((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    if (company !== 15 || qtyOf(receivedBatches, EXPIRED) !== 5 || qtyOf(receivedBatches, FRESH) !== 10) {
      throw new Error(
        `purchase fixture is not 5 expired + 10 fresh on company stock 15: ${JSON.stringify({
          company,
          received,
          receivedBatches,
        })}`
      );
    }
    compare("after purchase", "company stock", company, 15);
    compare("after purchase", "المخزن الرئيسي", received.main, 15);
    compare("after purchase", "مرتجعات", received.returns, 0);

    const { main, returnsWh } = await warehousesOf(shop);
    const columns = await shop.ctx.db.all("PRAGMA table_info(warehouse_transfer_items)");
    const probe = await request(shop.ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(shop.adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        transfer_date: CLOCK,
        items: [{
          product_id: product.id,
          quantity: 5,
          expiry_date: EXPIRED,
          batch_id: receivedBatches.find((row) => row.expiry_date === EXPIRED)?.id,
        }],
      });
    const probeRow = unwrap(probe.body);
    const probeItems = probe.status === 201
      ? await shop.ctx.db.all(
        "SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?",
        [probeRow.id]
      )
      : [];
    if (probe.status === 201) {
      await request(shop.ctx.app)
        .delete(`/api/v1/warehouses/transfers/${probeRow.id}`)
        .set(authHeader(shop.adminToken));
    }

    const draft = await request(shop.ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(shop.adminToken))
      .send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        transfer_date: CLOCK,
        items: [{ product_id: product.id, quantity: 5 }],
      });
    if (draft.status !== 201) throw new Error(`transfer draft ${draft.status} ${JSON.stringify(draft.body)}`);
    const posted = await request(shop.ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft.body).id}/post`)
      .set(authHeader(shop.adminToken));
    if (posted.status !== 200) throw new Error(`transfer post ${posted.status} ${JSON.stringify(posted.body)}`);
    const savedItems = await shop.ctx.db.all(
      "SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?",
      [unwrap(draft.body).id]
    );
    const batchColumns = await shop.ctx.db.all("PRAGMA table_info(product_batches)");
    return {
      probeStatus: probe.status,
      probeItemKeys: probeItems[0] ? Object.keys(probeItems[0]).sort() : [],
      transferColumns: columns.map((col) => col.name).sort(),
      savedItemKeys: savedItems[0] ? Object.keys(savedItems[0]).sort() : [],
      batchHasWarehouse: batchColumns.some((col) => col.name === "warehouse_id"),
      savedItems,
    };
  }

  let salesShop;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    process.env.NODE_ENV = "test";
    process.env.ZKTECO_ENABLED = "0";
    process.env.DISABLE_AUTO_BACKUP = "1";
    process.env.DISABLE_EXPIRY_TELEGRAM_ALERT = "1";
  });

  afterAll(() => {
    const failed = findings.filter((row) => !row.ok);
    console.log(`RETURNS_WAREHOUSE_FINDINGS ${JSON.stringify({ failed, all: findings })}`);
  });

  afterEach(async () => {
    if (salesShop) await closeShop(salesShop);
    salesShop = null;
  });

  test("the temporary database and fixed shop day stay isolated", async () => {
    salesShop = await openShop();
    expect(salesShop.ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(salesShop.ctx.dbPath.toLowerCase()).not.toMatch(/supermarket\.db/);
    expect(process.env.NODE_ENV).toBe("test");
    expect(Object.keys(process.env).some((key) => key.startsWith("TELEGRAM_"))).toBe(false);
    expect(shopTodayYmd()).toBe(CLOCK);
    const health = await request(salesShop.ctx.app).get("/api/v1/health");
    expect(unwrap(health.body).approvalsTelegram.tokenConfigured).toBe(false);
  });

  test("POS availability and allocation after moving the expired lot to مرتجعات", async () => {
    salesShop = await openShop();
    const product = await makeProduct(salesShop.ctx);
    const transferFacts = await receiveAndTransfer(salesShop, product);
    compare(
      "transfer document",
      "transfer line can name the expiry batch",
      transferFacts.transferColumns.some((name) => /expiry|batch/i.test(name))
        || transferFacts.probeItemKeys.some((name) => /expiry|batch/i.test(name))
        || transferFacts.batchHasWarehouse,
      true
    );

    const warehouses = await displayedWarehouses(salesShop, product.id);
    const batches = await batchesOf(salesShop.ctx.db, product.id);
    const company = num((await salesShop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const pos = await posStock(salesShop, product);
    const supplier = num((await salesShop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [salesShop.supplierId])).balance);

    compare("after transfer", "company stock", company, 15);
    compare("after transfer", "المخزن الرئيسي", warehouses.main, 10);
    compare("after transfer", "مرتجعات", warehouses.returns, 5);
    compare("after transfer", "expired batch", qtyOf(batches, EXPIRED), 5);
    compare("after transfer", "fresh batch", qtyOf(batches, FRESH), 10);
    compare("after transfer", "POS search stock", pos.searchStock, 10);
    compare("after transfer", "POS lookup stock", pos.lookupStock, 10);
    compare("after transfer", "supplier balance", supplier, 60);

    const sell = async (quantity, key) => request(salesShop.ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(salesShop.cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity, price: SALE_PRICE }],
        payment_method: "cash",
      }, key));

    const first = await sell(3, "returns-wh-sale-3");
    const after3Batches = await batchesOf(salesShop.ctx.db, product.id);
    const after3Wh = await displayedWarehouses(salesShop, product.id);
    const after3Company = num((await salesShop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const firstAlloc = first.status === 201
      ? await salesShop.ctx.db.all(
        `SELECT expiry_date, quantity FROM stock_batch_allocations
          WHERE reference_type = 'transaction' AND reference_id = ? AND direction = 'out'
          ORDER BY expiry_date`,
        [unwrap(first.body).transaction_id]
      )
      : [];
    compare("sell 3", "checkout status", first.status, 201);
    compare("sell 3", "company stock", after3Company, 12);
    compare("sell 3", "المخزن الرئيسي", after3Wh.main, 7);
    compare("sell 3", "مرتجعات", after3Wh.returns, 5);
    compare("sell 3", "expired batch", qtyOf(after3Batches, EXPIRED), 5);
    compare("sell 3", "fresh batch", qtyOf(after3Batches, FRESH), 7);
    compare("sell 3", "allocation", firstAlloc.map((row) => ({
      expiry_date: row.expiry_date,
      quantity: num(row.quantity),
    })), [{ expiry_date: FRESH, quantity: 3 }]);

    const second = await sell(7, "returns-wh-sale-7");
    const after7Batches = await batchesOf(salesShop.ctx.db, product.id);
    const after7Wh = await displayedWarehouses(salesShop, product.id);
    const after7Company = num((await salesShop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const secondAlloc = second.status === 201
      ? await salesShop.ctx.db.all(
        `SELECT expiry_date, quantity FROM stock_batch_allocations
          WHERE reference_type = 'transaction' AND reference_id = ? AND direction = 'out'
          ORDER BY expiry_date`,
        [unwrap(second.body).transaction_id]
      )
      : [];
    compare("sell 7", "checkout status", second.status, 201);
    compare("sell 7", "company stock", after7Company, 5);
    compare("sell 7", "المخزن الرئيسي", after7Wh.main, 0);
    compare("sell 7", "مرتجعات", after7Wh.returns, 5);
    compare("sell 7", "expired batch", qtyOf(after7Batches, EXPIRED), 5);
    compare("sell 7", "fresh batch", qtyOf(after7Batches, FRESH), 0);
    compare("sell 7", "allocation", secondAlloc.map((row) => ({
      expiry_date: row.expiry_date,
      quantity: num(row.quantity),
    })), [{ expiry_date: FRESH, quantity: 7 }]);

    const beforeExtra = await activityCounts(salesShop.ctx.db, product.id);
    const extra = await sell(1, "returns-wh-sale-extra");
    const afterExtra = await activityCounts(salesShop.ctx.db, product.id);
    const afterExtraCompany = num((await salesShop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const afterExtraBatches = await batchesOf(salesShop.ctx.db, product.id);
    const afterExtraWh = await displayedWarehouses(salesShop, product.id);
    compare("sell 1 more", "checkout status", extra.status, 201);
    compare("sell 1 more", "new sale line", afterExtra.sales, beforeExtra.sales + 1);
    compare("sell 1 more", "new payment", afterExtra.payments, beforeExtra.payments + 1);
    compare("sell 1 more", "new stock movement", afterExtra.saleLedger, beforeExtra.saleLedger + 1);
    compare("sell 1 more", "company stock", afterExtraCompany, 4);
    compare("sell 1 more", "المخزن الرئيسي", afterExtraWh.main, -1);
    compare("sell 1 more", "مرتجعات", afterExtraWh.returns, 5);
    compare("sell 1 more", "expired batch", qtyOf(afterExtraBatches, EXPIRED), 5);
    compare("sell 1 more", "fresh batch", qtyOf(afterExtraBatches, FRESH), 0);
    findings.push({
      step: "sell 1 more",
      field: "shortage does not touch returns or the expired batch",
      expected: "sale posted, returns 5, expired 5, main -1",
      actual: {
        status: extra.status,
        company: afterExtraCompany,
        main: afterExtraWh.main,
        returns: afterExtraWh.returns,
        expired: qtyOf(afterExtraBatches, EXPIRED),
      },
      ok: extra.status === 201
        && afterExtraWh.returns === 5
        && qtyOf(afterExtraBatches, EXPIRED) === 5
        && afterExtraWh.main === -1,
    });

    const failed = findings.filter((row) => !row.ok && row.step !== "after purchase");
    expect(failed).toEqual([]);
  });

  test("supplier return of the expired units on a fresh post-transfer fixture", async () => {
    const shop = await openShop();
    try {
      const product = await makeProduct(shop.ctx);
      await receiveAndTransfer(shop, product);
      const beforeWh = await displayedWarehouses(shop, product.id);
      const beforeBatches = await batchesOf(shop.ctx.db, product.id);
      const beforeCompany = num((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
      const beforeBalance = num((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierId])).balance);
      const beforePos = await posStock(shop, product);
      compare("return fixture", "company stock", beforeCompany, 15);
      compare("return fixture", "المخزن الرئيسي", beforeWh.main, 10);
      compare("return fixture", "مرتجعات", beforeWh.returns, 5);
      compare("return fixture", "expired batch", qtyOf(beforeBatches, EXPIRED), 5);
      compare("return fixture", "fresh batch", qtyOf(beforeBatches, FRESH), 10);

      const returnColumns = (await shop.ctx.db.all("PRAGMA table_info(purchase_returns)")).map((col) => col.name);
      const created = await request(shop.ctx.app)
        .post("/api/v1/purchases/returns")
        .set(authHeader(shop.adminToken))
        .send({
          supplier_id: shop.supplierId,
          return_date: CLOCK,
          items: [{
            product_id: product.id,
            quantity: 5,
            total_cost: 5 * UNIT_COST,
            expiry_date: EXPIRED,
          }],
        });
      expect(created.status).toBe(201);
      const returnId = unwrap(created.body).id;
      const posted = await request(shop.ctx.app)
        .post(`/api/v1/purchases/returns/${returnId}/post`)
        .set(authHeader(shop.adminToken))
        .send({});
      expect(posted.status).toBe(200);

      const afterWh = await displayedWarehouses(shop, product.id);
      const afterBatches = await batchesOf(shop.ctx.db, product.id);
      const afterCompany = num((await shop.ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
      const afterBalance = num((await shop.ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [shop.supplierId])).balance);
      const afterPos = await posStock(shop, product);
      const ledger = await shop.ctx.db.all(
        `SELECT movement_type, quantity_delta, warehouse_id, reference_type, reference_id
           FROM inventory_ledger
          WHERE product_id = ? AND movement_type = 'supplier_return'`,
        [product.id]
      );
      const alloc = await shop.ctx.db.all(
        `SELECT expiry_date, quantity, direction FROM stock_batch_allocations
          WHERE product_id = ? AND reference_type = 'purchase_return' AND reference_id = ?
          ORDER BY id`,
        [product.id, returnId]
      );
      const rawStock = await shop.ctx.db.all(
        `SELECT w.type, ws.quantity
           FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
          WHERE ws.product_id = ?`,
        [product.id]
      );

      compare("after supplier return", "company stock", afterCompany, 10);
      compare("after supplier return", "المخزن الرئيسي", afterWh.main, 10);
      compare("after supplier return", "مرتجعات", afterWh.returns, 0);
      compare("after supplier return", "expired batch", qtyOf(afterBatches, EXPIRED), 0);
      compare("after supplier return", "fresh batch", qtyOf(afterBatches, FRESH), 10);
      compare("after supplier return", "supplier balance delta", num(afterBalance - beforeBalance), -20);
      compare("after supplier return", "POS search stock", afterPos.searchStock, 10);
      compare("after supplier return", "POS lookup stock", afterPos.lookupStock, 10);
      compare("after supplier return", "return allocation", alloc.map((row) => ({
        expiry_date: row.expiry_date,
        quantity: num(row.quantity),
        direction: row.direction,
      })), [{ expiry_date: EXPIRED, quantity: 5, direction: "out" }]);
      findings.push({
        step: "after supplier return",
        field: "warehouse and batch actually used",
        expected: "returns warehouse and the expired batch",
        actual: {
          returnHasWarehouseColumn: returnColumns.includes("warehouse_id"),
          ledger,
          allocation: alloc,
          rawWarehouseStock: rawStock,
          displayed: afterWh,
          posBefore: beforePos.searchStock,
          posAfter: afterPos.searchStock,
        },
        ok: afterWh.returns === 0
          && afterWh.main === 10
          && ledger.length === 1
          && ledger[0].warehouse_id != null
          && qtyOf(afterBatches, EXPIRED) === 0
          && qtyOf(afterBatches, FRESH) === 10,
      });

      const failed = findings.filter((row) => row.step.startsWith("after supplier") || row.step === "return fixture");
      expect(failed.filter((row) => !row.ok)).toEqual([]);
    } finally {
      await closeShop(shop);
    }
  });
});
