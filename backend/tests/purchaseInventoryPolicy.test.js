import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { round2 } from "../utils/money.js";

describe("purchase inventory policy (returns, discount, fractional)", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let barcodeSeq = 8800100000;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    const sup = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('مورد سياسة')");
    supplierId = sup.lastID;
    await ctx.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')"
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function postInvoice(items) {
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

  async function postReturn(items) {
    const create = await request(ctx.app)
      .post("/api/purchases/returns")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, items });
    expect(create.status).toBe(201);
    const post = await request(ctx.app)
      .post(`/api/purchases/returns/${create.body.id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    return create.body.id;
  }

  function nextBarcode() {
    barcodeSeq += 1;
    return String(barcodeSeq);
  }

  async function makeKgProduct(_label, { stock = 0, cost = 0 } = {}) {
    const barcode = nextBarcode();
    const kgBarcode = nextBarcode();
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, is_weighed)
       VALUES (?, ?, 6, ?, 'Test', ?, 1)`,
      [barcode, `منتج ${barcode}`, cost, stock]
    );
    const pid = ins.lastID;
    await upsertProductUnit(ctx.db, pid, {
      unit_name: "كغم",
      barcode: kgBarcode,
      price: 6,
      cost,
      conversion_to_base: 1,
      is_default: true,
    });
    const kg = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'كغم'",
      [pid]
    );
    return { id: pid, kgId: kg.id };
  }

  async function makePieceKgProduct(_label, conversion, { stock = 0, cost = 0 } = {}) {
    const p = await makeKgProduct(_label, { stock, cost });
    await upsertProductUnit(ctx.db, p.id, {
      unit_name: "حبة",
      barcode: nextBarcode(),
      price: 12,
      cost: 0,
      conversion_to_base: conversion,
      is_default: false,
    });
    const pack = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'حبة'",
      [p.id]
    );
    return { ...p, pieceId: pack.id };
  }

  async function productState(productId) {
    const row = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [productId]);
    const units = await ctx.db.all(
      "SELECT unit_name, cost, conversion_to_base FROM product_units WHERE product_id = ?",
      [productId]
    );
    const ledger = await ctx.db.get(
      `SELECT quantity_delta FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [productId]
    );
    return {
      stock: Number(row.stock),
      cost: Number(row.cost),
      units,
      ledgerDelta: ledger ? Number(ledger.quantity_delta) : null,
    };
  }

  test("schema declares inventory quantities as REAL", async () => {
    const stock = await ctx.db.get(
      `SELECT type FROM pragma_table_info('products') WHERE name = 'stock'`
    );
    const delta = await ctx.db.get(
      `SELECT type FROM pragma_table_info('inventory_ledger') WHERE name = 'quantity_delta'`
    );
    expect(String(stock.type).toUpperCase()).toBe("REAL");
    expect(String(delta.type).toUpperCase()).toBe("REAL");
  });

  test("A: 10 حبة × 2.5kg @ ₪100 — qty preserved, stock +25, cost ₪4/kg", async () => {
    const p = await makePieceKgProduct("POLA0001", 2.5);
    const invoiceId = await postInvoice([
      { product_id: p.id, unit_id: p.pieceId, quantity: 10, total_cost: 100 },
    ]);
    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(Number(line.quantity)).toBe(10);
    expect(Number(line.base_quantity)).toBeCloseTo(25, 6);
    expect(Number(line.unit_cost)).toBeCloseTo(10, 6);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(25, 3);
    expect(after.cost).toBeCloseTo(4, 2);
    expect(after.ledgerDelta).toBeCloseTo(25, 3);
    const piece = after.units.find((u) => u.unit_name === "حبة");
    expect(Number(piece.cost)).toBeCloseTo(10, 2);
  });

  test("B: discounted mixed-unit purchase uses line_total for WAC", async () => {
    const p = await makePieceKgProduct("POLB0001", 2.5);
    const invoiceId = await postInvoice([
      {
        product_id: p.id,
        unit_id: p.pieceId,
        quantity: 10,
        total_cost: 100,
        discount_pct: 10,
      },
    ]);
    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(Number(line.quantity)).toBe(10);
    expect(Number(line.unit_cost)).toBeCloseTo(10, 6);
    expect(Number(line.line_total)).toBeCloseTo(90, 2);
    expect(Number(line.base_quantity)).toBeCloseTo(25, 6);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(25, 3);
    expect(after.cost).toBeCloseTo(3.6, 2);
    const piece = after.units.find((u) => u.unit_name === "حبة");
    expect(Number(piece.cost)).toBeCloseTo(9, 2);
  });

  test.each([
    ["C 12.5kg", 12.5, 62.5, 5],
    ["D 0.5kg", 0.5, 2.5, 5],
    ["D 2.75kg", 2.75, 13.75, 5],
  ])("%s survives full post pipeline", async (_label, qty, total, expectedCost) => {
    const p = await makeKgProduct(`POLF${String(qty).replace(".", "")}`);
    const invoiceId = await postInvoice([
      { product_id: p.id, unit_id: p.kgId, quantity: qty, total_cost: total },
    ]);
    const line = await ctx.db.get(
      "SELECT quantity, base_quantity FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(Number(line.quantity)).toBeCloseTo(qty, 6);
    expect(Number(line.base_quantity)).toBeCloseTo(qty, 6);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(qty, 3);
    expect(after.ledgerDelta).toBeCloseTo(qty, 3);
    expect(after.cost).toBeCloseTo(expectedCost, 2);
  });

  test("E: bonus quantity spreads cost over paid+bonus base qty", async () => {
    const p = await makePieceKgProduct("POLE0001", 2.5);
    await postInvoice([
      {
        product_id: p.id,
        unit_id: p.pieceId,
        quantity: 5,
        bonus_quantity: 1,
        total_cost: 50,
      },
    ]);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(15, 3);
    expect(after.cost).toBeCloseTo(round2(50 / 15), 2);
    const piece = after.units.find((u) => u.unit_name === "حبة");
    expect(Number(piece.cost)).toBeCloseTo(round2(after.cost * 2.5), 2);
  });

  test("fractional KG with discount and bonus", async () => {
    const p = await makeKgProduct("POLMIX01");
    await postInvoice([
      {
        product_id: p.id,
        unit_id: p.kgId,
        quantity: 12.5,
        bonus_quantity: 2.5,
        total_cost: 90,
        discount_pct: 10,
      },
    ]);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(15, 3);
    expect(after.cost).toBeCloseTo(round2(81 / 15), 2);
  });

  test("F: WAC inbound mixed purchases", async () => {
    const p = await makeKgProduct("POLWAC01", { stock: 25, cost: 4 });
    await ctx.db.run("UPDATE product_units SET cost = 4 WHERE product_id = ?", [p.id]);
    await postInvoice([
      { product_id: p.id, unit_id: p.kgId, quantity: 25, total_cost: 150 },
    ]);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(50, 3);
    expect(after.cost).toBeCloseTo(5, 2);
  });

  test("G: WAC return reverses documented return value, not a hidden batch", async () => {
    const p = await makeKgProduct("POLRET01", { stock: 25, cost: 4 });
    await postInvoice([
      { product_id: p.id, unit_id: p.kgId, quantity: 25, total_cost: 150 },
    ]);
    expect((await productState(p.id)).cost).toBeCloseTo(5, 2);

    await postReturn([
      { product_id: p.id, unit_id: p.kgId, quantity: 5, total_cost: 30 },
    ]);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(45, 3);
    expect(after.ledgerDelta).toBeCloseTo(-5, 3);
    expect(after.cost).toBeCloseTo(4.89, 2);
  });

  test("H: discounted purchase then proportional discounted return", async () => {
    const p = await makePieceKgProduct("POLDSC01", 2.5);
    await postInvoice([
      {
        product_id: p.id,
        unit_id: p.pieceId,
        quantity: 10,
        total_cost: 100,
        discount_pct: 10,
      },
    ]);
    await postReturn([
      {
        product_id: p.id,
        unit_id: p.pieceId,
        quantity: 2,
        total_cost: 20,
        discount_pct: 10,
      },
    ]);
    const after = await productState(p.id);
    expect(after.stock).toBeCloseTo(20, 3);
    expect(after.cost).toBeCloseTo(3.6, 2);
    const piece = after.units.find((u) => u.unit_name === "حبة");
    expect(Number(piece.cost)).toBeCloseTo(9, 2);
  });

  test("I: historical sale COGS snapshot is not rewritten after later purchase/return", async () => {
    const p = await makeKgProduct("POLCOG01", { stock: 20, cost: 4 });
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        payment_method: "cash",
        items: [{ product_id: p.id, unit_id: p.kgId, quantity: 1, price: 6 }],
      });
    expect(sale.status).toBe(201);
    const before = await ctx.db.get(
      `SELECT unit_cost_at_sale, gross_profit FROM transaction_items
       WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [p.id]
    );
    expect(Number(before.unit_cost_at_sale)).toBeCloseTo(4, 2);

    await postInvoice([
      { product_id: p.id, unit_id: p.kgId, quantity: 10, total_cost: 80 },
    ]);
    await postReturn([
      { product_id: p.id, unit_id: p.kgId, quantity: 2, total_cost: 16 },
    ]);

    const after = await ctx.db.get(
      `SELECT unit_cost_at_sale, gross_profit FROM transaction_items
       WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [p.id]
    );
    expect(Number(after.unit_cost_at_sale)).toBe(Number(before.unit_cost_at_sale));
    expect(Number(after.gross_profit)).toBe(Number(before.gross_profit));
  });

  test("J: purchase/return on A leaves B stock/cost/unit cache unchanged", async () => {
    const a = await makeKgProduct("POLIND01", { stock: 10, cost: 3 });
    const b = await makeKgProduct("POLIND02", { stock: 8, cost: 7 });
    await ctx.db.run("UPDATE product_units SET cost = 7 WHERE product_id = ?", [b.id]);
    const beforeB = await productState(b.id);

    await postInvoice([
      { product_id: a.id, unit_id: a.kgId, quantity: 5, total_cost: 20 },
    ]);
    await postReturn([
      { product_id: a.id, unit_id: a.kgId, quantity: 1, total_cost: 4 },
    ]);

    const afterB = await productState(b.id);
    expect(afterB.stock).toBeCloseTo(beforeB.stock, 6);
    expect(afterB.cost).toBeCloseTo(beforeB.cost, 6);
    expect(Number(afterB.units[0].cost)).toBeCloseTo(Number(beforeB.units[0].cost), 6);
  });

  test("VAT-inclusive payable still values inventory (policy unchanged)", async () => {
    await ctx.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0.16')"
    );
    const p = await makeKgProduct("POLVAT01");
    const invoiceId = await postInvoice([
      { product_id: p.id, unit_id: p.kgId, quantity: 10, total_cost: 100, vat_rate: 0.16 },
    ]);
    const line = await ctx.db.get(
      "SELECT line_total, line_net, line_vat FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(Number(line.line_total)).toBeCloseTo(100, 2);
    expect(Number(line.line_net)).toBeCloseTo(84, 2);
    expect((await productState(p.id)).cost).toBeCloseTo(10, 2);
    await ctx.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')"
    );
  });

  test("last-purchase-cost keeps pre-discount unit_cost semantics", async () => {
    const p = await makePieceKgProduct("POLLPC01", 2.5);
    await postInvoice([
      {
        product_id: p.id,
        unit_id: p.pieceId,
        quantity: 10,
        total_cost: 100,
        discount_pct: 10,
      },
    ]);
    const res = await request(ctx.app)
      .get(`/api/products/${p.id}/last-purchase-cost`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(Number(res.body.last_purchase.unit_cost)).toBeCloseTo(10, 2);
  });
});
