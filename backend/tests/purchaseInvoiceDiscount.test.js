import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  moveStockToReturns,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import { cacheInvalidate, CACHE_KEYS } from "../utils/cache.js";
import {
  applyPurchaseDocumentDiscount,
  computePurchaseInvoiceTotals,
  parsePurchaseDiscountPercent,
} from "../utils/tax.js";
import { allocateProportionalMoney } from "../utils/money.js";

function unwrap(res) {
  const body = res?.body ?? res;
  return body?.data ?? body;
}

describe("purchase discount math", () => {
  test("example A: 10% line then 5% invoice", () => {
    const priced = applyPurchaseDocumentDiscount(
      [{ total_cost: 100, discount_pct: 10, quantity: 1 }],
      5
    );
    expect(priced.lines[0].after_line_discount).toBe(90);
    expect(priced.lineDiscountTotal).toBe(10);
    expect(priced.invoiceDiscountAmount).toBe(4.5);
    expect(priced.payableTotal).toBe(85.5);
    const totals = computePurchaseInvoiceTotals(
      [{ total_cost: 100, discount_pct: 10, vat_rate: 0 }],
      0,
      { invoiceDiscountPct: 5 }
    );
    expect(totals.total).toBe(85.5);
    expect(totals.lines[0].line_total).toBe(85.5);
    expect(totals.subtotal + totals.vat).toBeCloseTo(85.5, 2);
  });

  test("example B allocates 9 and 4 and keeps unit nets 40.50 and 36", () => {
    const totals = computePurchaseInvoiceTotals(
      [
        { total_cost: 100, discount_pct: 10, quantity: 2, vat_rate: 0 },
        { total_cost: 50, discount_pct: 20, quantity: 1, vat_rate: 0 },
      ],
      0,
      { invoiceDiscountPct: 10 }
    );
    expect(totals.lines.map((line) => line.after_line_discount)).toEqual([90, 40]);
    expect(totals.afterLineDiscount).toBe(130);
    expect(totals.invoiceDiscountAmount).toBe(13);
    expect(totals.lines.map((line) => line.invoice_discount_amount)).toEqual([9, 4]);
    expect(totals.total).toBe(117);
    expect(totals.lines[0].line_total / 2).toBeCloseTo(40.5, 2);
    expect(totals.lines[1].line_total).toBe(36);
    expect(allocateProportionalMoney([90, 40], 13)).toEqual([9, 4]);
  });

  test("100 percent discounts and a zero base do not divide by zero", () => {
    const fullLine = computePurchaseInvoiceTotals(
      [{ total_cost: 80, discount_pct: 100, vat_rate: 0.16 }],
      0.16,
      { invoiceDiscountPct: 50 }
    );
    expect(fullLine.total).toBe(0);
    expect(fullLine.lines[0].line_vat).toBe(0);
    expect(fullLine.invoiceDiscountAmount).toBe(0);
    const fullInvoice = computePurchaseInvoiceTotals(
      [{ total_cost: 40, discount_pct: 0, vat_rate: 0 }],
      0,
      { invoiceDiscountPct: 100 }
    );
    expect(fullInvoice.total).toBe(0);
    expect(fullInvoice.lines[0].invoice_discount_amount).toBe(40);
  });

  test("line-only discounts stay on the previous payable", () => {
    const totals = computePurchaseInvoiceTotals(
      [{ total_cost: 50, discount_pct: 10, vat_rate: 0.16 }],
      0.16
    );
    expect(totals.lines[0].line_total).toBe(45);
    expect(totals.lines[0].line_net).toBe(38.79);
    expect(totals.lines[0].line_vat).toBe(6.21);
    expect(totals.invoiceDiscountAmount).toBe(0);
  });

  test("percent parser accepts blank and decimals and rejects the rest", () => {
    expect(parsePurchaseDiscountPercent(null).value).toBe(0);
    expect(parsePurchaseDiscountPercent("").value).toBe(0);
    expect(parsePurchaseDiscountPercent("  ").value).toBe(0);
    expect(parsePurchaseDiscountPercent("10.5").value).toBe(10.5);
    expect(parsePurchaseDiscountPercent(0).value).toBe(0);
    expect(parsePurchaseDiscountPercent(100).value).toBe(100);
    for (const bad of [-1, 100.01, "abc", "10%", true, Infinity, Number.NaN]) {
      expect(parsePurchaseDiscountPercent(bad).ok).toBe(false);
    }
  });
});

describe("purchase invoice and return discounts", () => {
  let ctx;
  let adminToken;
  let supplierId;
  let barcodeSeq = 7700100000;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد الخصم', 'DISC-1', 0, 0)"
    );
    supplierId = sup.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    cacheInvalidate(CACHE_KEYS.SETTINGS);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function nextBarcode() {
    barcodeSeq += 1;
    return String(barcodeSeq);
  }

  async function makeProduct(name) {
    const barcode = nextBarcode();
    const ins = await ctx.db.run(
      "INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, 8, 0, 'Test', 0)",
      [barcode, name]
    );
    const unit = await upsertProductUnit(ctx.db, ins.lastID, {
      unit_name: "حبة",
      barcode,
      price: 8,
      cost: 0,
      conversion_to_base: 1,
      is_default: true,
    });
    return { id: ins.lastID, unitId: unit.id };
  }

  async function supplierBalance() {
    const row = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    return Number(row.balance);
  }

  test("draft save ignores browser totals and does not move stock or the supplier balance", async () => {
    const product = await makeProduct("مسودة خصم");
    const beforeStock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const beforeBalance = await supplierBalance();
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        total: 1,
        subtotal: 1,
        vat: 1,
        invoice_discount_amount: 999,
        invoice_discount_pct: 5,
        items: [{ product_id: product.id, unit_id: product.unitId, quantity: 1, total_cost: 100, discount_pct: 10 }],
      });
    expect(created.status).toBe(201);
    const invoice = unwrap(created.body);
    expect(invoice.status).toBe("draft");
    expect(Number(invoice.total)).toBeCloseTo(85.5, 2);
    expect(Number(invoice.discount_pct)).toBe(5);
    expect(Number(invoice.invoice_discount_amount)).toBeCloseTo(4.5, 2);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(beforeStock);
    expect(await supplierBalance()).toBeCloseTo(beforeBalance, 2);
    const loaded = unwrap(await request(ctx.app)
      .get(`/api/v1/purchases/invoices/${invoice.id}`)
      .set(authHeader(adminToken)));
    expect(Number(loaded.total)).toBeCloseTo(85.5, 2);
    expect(Number(loaded.items[0].discount_pct)).toBe(10);
    expect(Number(loaded.items[0].line_total)).toBeCloseTo(85.5, 2);
    expect(Number(loaded.items[0].unit_cost)).toBeCloseTo(100, 2);
  });

  test("confirmed duplicate lines keep independent price, discount, expiry, and source", async () => {
    const product = await makeProduct("صنف مكرر");
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_discount_pct: 0,
        items: [
          { product_id: product.id, unit_id: product.unitId, quantity: 1, total_cost: 10, discount_pct: 0, expiry_date: "2027-01-01" },
          { product_id: product.id, unit_id: product.unitId, quantity: 2, total_cost: 30, discount_pct: 10, expiry_date: "2028-06-15" },
        ],
      });
    expect(created.status).toBe(201);
    const loaded = unwrap(await request(ctx.app)
      .get(`/api/v1/purchases/invoices/${unwrap(created.body).id}`)
      .set(authHeader(adminToken)));
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items.map((it) => Number(it.product_id))).toEqual([product.id, product.id]);
    expect(loaded.items.map((it) => Number(it.total_cost))).toEqual([10, 30]);
    expect(loaded.items.map((it) => Number(it.discount_pct))).toEqual([0, 10]);
    expect(loaded.items.map((it) => String(it.expiry_date).slice(0, 10))).toEqual(["2027-01-01", "2028-06-15"]);
    expect(Number(loaded.items[1].line_total)).toBeCloseTo(27, 2);
  });

  test("rejects invalid percentages and a missing price, and allows a 100% net of zero", async () => {
    const product = await makeProduct("تحقق الخصم");
    const base = { supplier_id: supplierId, items: [{ product_id: product.id, quantity: 1, total_cost: 20 }] };
    for (const invoice_discount_pct of [-1, 101, "abc", true]) {
      const res = await request(ctx.app)
        .post("/api/v1/purchases/invoices")
        .set(authHeader(adminToken))
        .send({ ...base, invoice_discount_pct });
      expect(res.status).toBe(400);
      expect(unwrap(res.body).error || res.body.error).toMatch(/نسبة الخصم/);
    }
    const lineBad = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: product.id, quantity: 1, total_cost: 20, discount_pct: "10%" }],
      });
    expect(lineBad.status).toBe(400);
    const missing = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, items: [{ product_id: product.id, quantity: 1 }] });
    expect(missing.status).toBe(400);
    expect(unwrap(missing.body).error || missing.body.error).toMatch(/سعر الوحدة مطلوب/);
    const explicitZero = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: product.id, quantity: 1, total_cost: 0 }],
      });
    expect(explicitZero.status).toBe(201);
    const full = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: product.id, quantity: 1, total_cost: 100, discount_pct: 100 }],
      });
    expect(full.status).toBe(201);
    const row = await ctx.db.get(
      "SELECT unit_cost, line_total, discount_pct FROM purchase_invoice_items WHERE invoice_id = ?",
      [unwrap(full.body).id]
    );
    expect(Number(row.unit_cost)).toBeCloseTo(100, 2);
    expect(Number(row.line_total)).toBe(0);
    expect(Number(row.discount_pct)).toBe(100);
  });

  test("posted example B then a partial return uses 40.50 once", async () => {
    const a = await makeProduct("بند أ");
    const b = await makeProduct("بند ب");
    const before = await supplierBalance();
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_discount_pct: 10,
        items: [
          { product_id: a.id, unit_id: a.unitId, quantity: 2, total_cost: 100, discount_pct: 10 },
          { product_id: b.id, unit_id: b.unitId, quantity: 1, total_cost: 50, discount_pct: 20 },
        ],
      });
    expect(created.status).toBe(201);
    const invoiceId = unwrap(created.body).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const again = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(again.status).toBe(400);

    const lines = await ctx.db.all(
      "SELECT product_id, quantity, unit_cost, discount_pct, invoice_discount_amount, line_total FROM purchase_invoice_items WHERE invoice_id = ? ORDER BY id",
      [invoiceId]
    );
    expect(lines.map((line) => Number(line.invoice_discount_amount))).toEqual([9, 4]);
    expect(lines.map((line) => Number(line.line_total))).toEqual([81, 36]);
    expect(Number(lines[0].unit_cost)).toBeCloseTo(50, 2);
    const costA = Number((await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [a.id])).cost);
    const costB = Number((await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [b.id])).cost);
    expect(costA).toBeCloseTo(40.5, 2);
    expect(costB).toBeCloseTo(36, 2);
    expect(await supplierBalance()).toBeCloseTo(before + 117, 2);

    const ret = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_discount_pct: 0,
        items: [{
          product_id: a.id,
          unit_id: a.unitId,
          quantity: 1,
          total_cost: 40.5,
          discount_pct: 0,
        }],
      });
    expect(ret.status).toBe(201);
    const returnId = unwrap(ret.body).id;
    const draftItem = await ctx.db.get(
      "SELECT discount_pct, invoice_discount_amount, line_total, unit_cost FROM purchase_return_items WHERE return_id = ?",
      [returnId]
    );
    expect(Number(draftItem.discount_pct)).toBe(0);
    expect(Number(draftItem.invoice_discount_amount)).toBe(0);
    expect(Number(draftItem.unit_cost)).toBeCloseTo(40.5, 2);
    expect(Number(draftItem.line_total)).toBeCloseTo(40.5, 2);
    expect(await supplierBalance()).toBeCloseTo(before + 117, 2);

    await moveStockToReturns(ctx.app, ctx.db, adminToken, [
      { product_id: a.id, unit_id: a.unitId, quantity: 1 },
    ], supplierId);
    const retPost = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${returnId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(retPost.status).toBe(200);
    const retAgain = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${returnId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(retAgain.status).toBe(400);
    expect(await supplierBalance()).toBeCloseTo(before + 117 - 40.5, 2);
    const afterA = await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [a.id]);
    expect(Number(afterA.stock)).toBeCloseTo(1, 3);
    expect(Number(afterA.cost)).toBeCloseTo(40.5, 2);
    const afterB = await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [b.id]);
    expect(Number(afterB.stock)).toBeCloseTo(1, 3);
    expect(Number(afterB.cost)).toBeCloseTo(36, 2);
    const movement = await ctx.db.get(
      `SELECT unit_cost_after, quantity_delta, movement_type FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'supplier_return'
        ORDER BY id DESC LIMIT 1`,
      [a.id]
    );
    expect(movement.movement_type).toBe("supplier_return");
    expect(Number(movement.quantity_delta)).toBeCloseTo(-1, 3);
    expect(Number(movement.unit_cost_after)).toBeCloseTo(40.5, 2);
  });

  test("duplicate return lines cannot exceed one source lot, and a failed post rolls back", async () => {
    const product = await makeProduct("مصدر مكرر");
    const balanceBeforePurchase = await supplierBalance();
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: product.id, unit_id: product.unitId, quantity: 2, total_cost: 20 }],
      });
    const invoiceId = unwrap(created.body).id;
    expect((await request(ctx.app).post(`/api/v1/purchases/invoices/${invoiceId}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    await moveStockToReturns(ctx.app, ctx.db, adminToken, [
      { product_id: product.id, unit_id: product.unitId, quantity: 2 },
    ], supplierId);
    const lot = await ctx.db.get(
      `SELECT id, quantity FROM stock_source_lots
        WHERE product_id = ? AND supplier_id = ? AND quantity > 0
        ORDER BY id DESC LIMIT 1`,
      [product.id, supplierId]
    );
    expect(Number(lot.quantity)).toBeCloseTo(2, 3);
    const balanceBeforeReturn = await supplierBalance();
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock);
    const ret = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [
          { product_id: product.id, quantity: 2, total_cost: 20, batch_source: "undated", source_lot_id: lot.id },
          { product_id: product.id, quantity: 2, total_cost: 20, batch_source: "undated", source_lot_id: lot.id },
        ],
      });
    expect(ret.status).toBe(201);
    const returnId = unwrap(ret.body).id;
    const failed = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${returnId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await supplierBalance()).toBeCloseTo(balanceBeforeReturn, 2);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBeCloseTo(stockBefore, 3);
    expect(Number((await ctx.db.get("SELECT quantity FROM stock_source_lots WHERE id = ?", [lot.id])).quantity)).toBeCloseTo(2, 3);
    expect((await ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [returnId])).status).toBe("draft");
    expect(balanceBeforePurchase).toEqual(expect.any(Number));
  });

  test("repeating database init keeps stored discounts and totals", async () => {
    const row = await ctx.db.get(
      `SELECT id, total, discount_pct, invoice_discount_amount, status
         FROM purchase_invoices WHERE invoice_discount_amount > 0 ORDER BY id DESC LIMIT 1`
    );
    expect(Number(row.total)).toBeCloseTo(117, 2);
    const db2 = await initDatabase(ctx.dbPath);
    await closeSqliteConnection(db2);
    const after = await ctx.db.get(
      "SELECT total, discount_pct, invoice_discount_amount, status FROM purchase_invoices WHERE id = ?",
      [row.id]
    );
    expect(Number(after.total)).toBeCloseTo(Number(row.total), 2);
    expect(Number(after.discount_pct)).toBe(Number(row.discount_pct));
    expect(Number(after.invoice_discount_amount)).toBeCloseTo(Number(row.invoice_discount_amount), 2);
    expect(after.status).toBe(row.status);
    const cols = await ctx.db.all("PRAGMA table_info(purchase_invoices)");
    expect(cols.some((col) => col.name === "discount_pct")).toBe(true);
    expect(cols.some((col) => col.name === "invoice_discount_amount")).toBe(true);
  });
});
