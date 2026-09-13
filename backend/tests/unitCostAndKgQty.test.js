/**
 * Tests for:
 *   Bug 1 – stale product_units.cost must never be used for COGS.
 *            COGS is always products.cost × conversion_to_base.
 *   Bug 2 – fractional KG quantities must be allowed when the sold unit
 *            is كغم, even when is_weighed = 0.
 */
import request from "supertest";
import {
  createTestContext, destroyTestContext, login, authHeader,
  withCheckoutKey,
} from "./helpers.js";
import {
  upsertProductUnit,
  syncProductFromDefaultUnit,
  refreshUnitCostCache,
  derivedUnitCost,
  resolveSoldUnitCost,
} from "../utils/productUnits.js";

describe("unit cost derivation and fractional KG quantities", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    const sup = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('مورد اختبار')");
    supplierId = sup.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  async function checkout(items) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ payment_method: "cash", items }));
  }

  async function postPurchaseInvoice(items) {
    const create = await request(ctx.app)
      .post("/api/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, items });
    expect(create.status).toBe(201);
    const post = await request(ctx.app)
      .post(`/api/purchases/invoices/${create.body.id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    return create.body.id;
  }

  async function stockOf(productId) {
    const row = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    return Number(row.stock);
  }

  async function costOf(productId) {
    const row = await ctx.db.get("SELECT cost FROM products WHERE id = ?", [productId]);
    return Number(row.cost);
  }

  async function lastSaleItem(productId) {
    return ctx.db.get(
      `SELECT unit_cost_at_sale, gross_profit, quantity, conversion_to_base
       FROM transaction_items ti
       JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'
       ORDER BY t.id DESC LIMIT 1`,
      [productId]
    );
  }

  async function ledgerDelta(productId) {
    const row = await ctx.db.get(
      `SELECT quantity_delta FROM inventory_ledger
       WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [productId]
    );
    return Number(row.quantity_delta);
  }

  // ─────────────────────────────────────────────────────────────
  // Unit helpers (pure)
  // ─────────────────────────────────────────────────────────────

  test("derivedUnitCost — base × conversion", () => {
    expect(derivedUnitCost(4, 1)).toBe(4);
    expect(derivedUnitCost(4, 2.5)).toBe(10);
    expect(derivedUnitCost(5, 1.8)).toBe(9);
    expect(derivedUnitCost(4, 0.5)).toBe(2);
  });

  test("resolveSoldUnitCost ignores unit.cost, always derives from product.cost × conversion", () => {
    const product = { cost: 4 };
    const kgUnit = { unit_name: "كغم", conversion_to_base: 1, cost: 99 };
    const pieceUnit = { unit_name: "حبة", conversion_to_base: 2.5, cost: 99 };

    // stale unit.cost = 99 must NOT appear
    expect(resolveSoldUnitCost(kgUnit, product)).toBe(4);
    expect(resolveSoldUnitCost(pieceUnit, product)).toBe(10);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 2 — syncProductFromDefaultUnit must not clobber products.cost
  // ─────────────────────────────────────────────────────────────

  test("syncProductFromDefaultUnit does not overwrite products.cost with stale unit cost", async () => {
    // Create a plain retail product
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('T200001', 'حبوب A', 12, 4, 'Test', 0)`
    );
    const pid = ins.lastID;
    // Unit with stale cost = 99
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "حبة",
      barcode: "T200001",
      price: 12,
      cost: 99,   // stale / wrong
      conversion_to_base: 2.5,
      is_default: true,
    });
    // products.cost should still be 4 after creating the unit
    // (upsertProductUnit calls syncProductFromDefaultUnit)
    const after = await ctx.db.get("SELECT cost FROM products WHERE id = ?", [pid]);
    expect(Number(after.cost)).toBeCloseTo(4, 6);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 3 — Purchase refresh + WAC
  // ─────────────────────────────────────────────────────────────

  test("purchase: 10 حبة × 2.5 kg × ₪10 each → base qty 25, products.cost = ₪4/kg", async () => {
    // Create a weighed deli product
    const prodRes = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "T300001",
        name: "مرتديلا اختبار",
        price: 6,
        cost: 0,
        stock: 0,
        is_weighed: true,
        scale_code: "2199901",
        package_conversion: 2.5,
        package_price: 12,
      });
    expect(prodRes.status).toBe(201);
    const product = prodRes.body.data ?? prodRes.body;
    const unitsRes = await request(ctx.app)
      .get(`/api/v1/products/${product.id}/units`)
      .set(authHeader(adminToken));
    const units = (unitsRes.body.data ?? unitsRes.body).units;
    const packUnit = units.find((u) => u.unit_name === "حبة");
    expect(packUnit).toBeTruthy();
    expect(Number(packUnit.conversion_to_base)).toBeCloseTo(2.5, 6);

    // Purchase: 10 حبة, total cost ₪100
    const invoiceId = await postPurchaseInvoice([
      {
        product_id: product.id,
        unit_id: packUnit.id,
        quantity: 10,
        total_cost: 100,
      },
    ]);

    // purchase_invoice_items must record purchase unit quantity, not base
    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?",
      [invoiceId, product.id]
    );
    expect(Number(line.quantity)).toBeCloseTo(10, 6);
    expect(Number(line.conversion_used)).toBeCloseTo(2.5, 6);
    expect(Number(line.base_quantity)).toBeCloseTo(25, 6);

    // Inventory must have received 25 kg, not 10
    expect(await stockOf(product.id)).toBeCloseTo(25, 3);

    // WAC: ₪100 / 25 kg = ₪4/kg
    expect(await costOf(product.id)).toBeCloseTo(4, 2);

    // Unit-cost cache must be refreshed
    const kgUnitRow = await ctx.db.get(
      "SELECT cost FROM product_units WHERE product_id = ? AND unit_name = 'كغم'",
      [product.id]
    );
    expect(Number(kgUnitRow.cost)).toBeCloseTo(4, 2);

    const packUnitRow = await ctx.db.get(
      "SELECT cost FROM product_units WHERE product_id = ? AND unit_name = 'حبة'",
      [product.id]
    );
    expect(Number(packUnitRow.cost)).toBeCloseTo(10, 2);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 4 — KG sale COGS
  // ─────────────────────────────────────────────────────────────

  test("sell 0.5 kg: unit_cost_at_sale = ₪2, gross_profit uses kg price, stock −0.5", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('T400001', 'جبن كغم', 6, 4, 'Test', 10, 1)`
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: "T400001",
      price: 6,
      cost: 4,
      conversion_to_base: 1,
      is_default: true,
    });
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [pid]);

    const res = await checkout([{ product_id: pid, unit_id: unit.id, quantity: 0.5, price: 6 }]);
    expect(res.status).toBe(201);
    expect(await stockOf(pid)).toBeCloseTo(9.5, 3);
    expect(await ledgerDelta(pid)).toBeCloseTo(-0.5, 3);

    const item = await lastSaleItem(pid);
    expect(Number(item.unit_cost_at_sale)).toBeCloseTo(4, 2);   // baseCost × 1
    expect(Number(item.gross_profit)).toBeCloseTo(3 - 2, 2);    // 0.5×6 − 0.5×4 = 1
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 5 — Piece COGS
  // ─────────────────────────────────────────────────────────────

  test("sell 1 حبة (conv 2.5, base cost ₪4): unit_cost_at_sale = ₪10, stock −2.5", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('T500001', 'مرتديلا حبة', 12, 4, 'Test', 10, 1)`
    );
    const pid = ins.lastID;
    // KG base unit
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: "T500KG1",
      price: 6,
      cost: 4,
      conversion_to_base: 1,
      is_default: true,
    });
    // Package unit with stale cost = 99 to prove it is ignored
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "حبة",
      barcode: "T500001",
      price: 12,
      cost: 99,   // deliberately wrong
      conversion_to_base: 2.5,
      is_default: false,
    });
    const packUnit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'",
      [pid]
    );

    const res = await checkout([{ product_id: pid, unit_id: packUnit.id, quantity: 1, price: 12 }]);
    expect(res.status).toBe(201);

    expect(await stockOf(pid)).toBeCloseTo(7.5, 3);    // 10 - 2.5
    expect(await ledgerDelta(pid)).toBeCloseTo(-2.5, 3);

    const item = await lastSaleItem(pid);
    expect(Number(item.unit_cost_at_sale)).toBeCloseTo(10, 2);  // 4 × 2.5 — NOT 99
    expect(Number(item.gross_profit)).toBeCloseTo(12 - 10, 2);  // ₪2
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 6 — Fractional KG without is_weighed
  // ─────────────────────────────────────────────────────────────

  test("fractional KG qty accepted when is_weighed=0 but unit is كغم", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('T600001', 'منتج كغم غير موزون', 8, 3, 'Test', 20, 0)`
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: "T600001",
      price: 8,
      cost: 3,
      conversion_to_base: 1,
      is_default: true,
    });
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [pid]);

    // 0.5 kg — must NOT be rounded to 1
    const res = await checkout([{ product_id: pid, unit_id: unit.id, quantity: 0.5, price: 8 }]);
    expect(res.status).toBe(201);
    expect(await stockOf(pid)).toBeCloseTo(19.5, 3);
    expect(await ledgerDelta(pid)).toBeCloseTo(-0.5, 3);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 7 — Fractional KG with is_weighed=1
  // ─────────────────────────────────────────────────────────────

  test("fractional KG qty 0.255 accepted with is_weighed=1", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('T700001', 'جبن موزون', 10, 5, 'Test', 5, 1)`
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: "T700001",
      price: 10,
      cost: 5,
      conversion_to_base: 1,
      is_default: true,
    });
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [pid]);

    const res = await checkout([{ product_id: pid, unit_id: unit.id, quantity: 0.255, price: 10 }]);
    expect(res.status).toBe(201);
    expect(await stockOf(pid)).toBeCloseTo(4.745, 3);
    expect(await ledgerDelta(pid)).toBeCloseTo(-0.255, 3);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 8 — Piece stays integer; conversion drives stock deduction
  // ─────────────────────────────────────────────────────────────

  test("sell 1 حبة (not KG): integer quantity, stock deduction uses conversion", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('T800001', 'مرتديلا حبة INT', 15, 5, 'Test', 10, 1)`
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: "T800KG0001",
      price: 6,
      cost: 5,
      conversion_to_base: 1,
      is_default: true,
    });
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "حبة",
      barcode: "T800001001",
      price: 15,
      cost: 5,
      conversion_to_base: 3,
      is_default: false,
    });
    const packUnit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'",
      [pid]
    );

    const res = await checkout([{ product_id: pid, unit_id: packUnit.id, quantity: 1, price: 15 }]);
    expect(res.status).toBe(201);
    // 1 حبة × 3 kg = 3 kg deducted
    expect(await stockOf(pid)).toBeCloseTo(7, 3);
    expect(await ledgerDelta(pid)).toBeCloseTo(-3, 3);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 9 — Different conversion (1 حبة = 1.8 kg)
  // ─────────────────────────────────────────────────────────────

  test("different conversion: 1 حبة = 1.8 kg, cost ₪5/kg → piece cost ₪9", async () => {
    const product = { cost: 5 };
    const pieceUnit = { unit_name: "حبة", conversion_to_base: 1.8, cost: 0 };
    expect(resolveSoldUnitCost(pieceUnit, product)).toBeCloseTo(9, 2);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 10 — Two products are independent
  // ─────────────────────────────────────────────────────────────

  test("two products with different conversions have independent costs and inventory", async () => {
    // Product A: 1 حبة = 2.5 kg, cost ₪4/kg
    const insA = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('8881000001', 'منتج أ', 6, 4, 'Test', 10, 1)`
    );
    const pidA = insA.lastID;
    await upsertProductUnit(ctx.db, pidA, {
      unit_name: "كغم", barcode: "8881000002", price: 6, cost: 4, conversion_to_base: 1, is_default: true,
    });
    await upsertProductUnit(ctx.db, pidA, {
      unit_name: "حبة", barcode: "8881000003", price: 12, cost: 0, conversion_to_base: 2.5, is_default: false,
    });

    // Product B: 1 حبة = 1.8 kg, cost ₪5/kg
    const insB = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('8882000001', 'منتج ب', 7, 5, 'Test', 10, 1)`
    );
    const pidB = insB.lastID;
    await upsertProductUnit(ctx.db, pidB, {
      unit_name: "كغم", barcode: "8882000002", price: 7, cost: 5, conversion_to_base: 1, is_default: true,
    });
    await upsertProductUnit(ctx.db, pidB, {
      unit_name: "حبة", barcode: "8882000003", price: 14, cost: 0, conversion_to_base: 1.8, is_default: false,
    });

    const packA = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'", [pidA]
    );
    const packB = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'", [pidB]
    );

    // Sell 1 حبة of each
    const resA = await checkout([{ product_id: pidA, unit_id: packA.id, quantity: 1, price: 12 }]);
    expect(resA.status).toBe(201);
    const resB = await checkout([{ product_id: pidB, unit_id: packB.id, quantity: 1, price: 14 }]);
    expect(resB.status).toBe(201);

    // Stock A: 10 - 2.5 = 7.5; Stock B: 10 - 1.8 = 8.2
    expect(await stockOf(pidA)).toBeCloseTo(7.5, 3);
    expect(await stockOf(pidB)).toBeCloseTo(8.2, 3);

    // COGS A: 4 × 2.5 = 10; COGS B: 5 × 1.8 = 9
    const itemA = await lastSaleItem(pidA);
    const itemB = await lastSaleItem(pidB);
    expect(Number(itemA.unit_cost_at_sale)).toBeCloseTo(10, 2);
    expect(Number(itemB.unit_cost_at_sale)).toBeCloseTo(9, 2);
  });

  // ─────────────────────────────────────────────────────────────
  // TEST 1 — Dynamic piece COGS ignores stale unit.cost
  // ─────────────────────────────────────────────────────────────

  test("unit_cost_at_sale = 10 even when product_units.cost = 99 (stale)", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES ('8883000001', 'مرتديلا COGS', 12, 4, 'Test', 10, 1)`
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم", barcode: "8883000002", price: 6, cost: 4,
      conversion_to_base: 1, is_default: true,
    });
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "حبة", barcode: "8883000003", price: 12, cost: 99,  // stale
      conversion_to_base: 2.5, is_default: false,
    });
    // Force stale unit cost directly into DB (bypassing any cache refresh)
    const packUnit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'", [pid]
    );
    await ctx.db.run("UPDATE product_units SET cost = 99 WHERE id = ?", [packUnit.id]);

    const res = await checkout([{ product_id: pid, unit_id: packUnit.id, quantity: 1, price: 12 }]);
    expect(res.status).toBe(201);

    const item = await lastSaleItem(pid);
    // Must be 10 (4 × 2.5), NOT 99
    expect(Number(item.unit_cost_at_sale)).toBeCloseTo(10, 2);
    expect(Number(item.gross_profit)).toBeCloseTo(2, 2);   // 12 - 10
  });

  // ─────────────────────────────────────────────────────────────
  // refreshUnitCostCache
  // ─────────────────────────────────────────────────────────────

  test("refreshUnitCostCache updates all unit costs from products.cost", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('T900001', 'منتج ذاكرة تخزين', 10, 5, 'Test', 0)`
    );
    const pid = ins.lastID;
    // Two units: base (conv=1) and carton (conv=12)
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', 'T900001', 10, 0, 1, 1)`,
      [pid]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'كرتون', NULL, 120, 0, 12, 0)`,
      [pid]
    );

    await refreshUnitCostCache(ctx.db, pid);

    const piece = await ctx.db.get(
      "SELECT cost FROM product_units WHERE product_id = ? AND unit_name = 'حبة'", [pid]
    );
    const carton = await ctx.db.get(
      "SELECT cost FROM product_units WHERE product_id = ? AND unit_name = 'كرتون'", [pid]
    );
    expect(Number(piece.cost)).toBeCloseTo(5, 2);    // 5 × 1
    expect(Number(carton.cost)).toBeCloseTo(60, 2);  // 5 × 12
  });
});
