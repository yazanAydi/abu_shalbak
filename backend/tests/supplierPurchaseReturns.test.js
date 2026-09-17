import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { convertPurchaseUnitCost } from "../utils/supplierPurchasePrice.js";
import { cacheInvalidate, CACHE_KEYS } from "../utils/cache.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("supplier purchase returns and balances", () => {
  let ctx;
  let adminToken;
  let supplierA;
  let supplierB;
  let productId;
  let pieceId;
  let cartonId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    cacheInvalidate(CACHE_KEYS.SETTINGS);

    const a = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد أ', 'SA-1', 0, 0)"
    );
    supplierA = a.lastID;
    const b = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد ب', 'SB-1', 0, 0)"
    );
    supplierB = b.lastID;

    const p = await ctx.db.run(
      "INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('8811000001', 'حليب علبة', 5, 1, 'ألبان', 50)"
    );
    productId = p.lastID;
    await ctx.db.run(
      "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, '8811000001', 1)",
      [productId]
    );
    const piece = await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "8811000001",
      price: 5,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });
    pieceId = piece.id;
    const carton = await upsertProductUnit(ctx.db, productId, {
      unit_name: "كرتون",
      barcode: "8811000012",
      price: 48,
      cost: 12,
      conversion_to_base: 12,
      is_default: false,
    });
    cartonId = carton.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createInvoice({ supplierId, date, items, post = true }) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, invoice_date: date, items });
    expect(created.status).toBe(201);
    const invoice = unwrap(created);
    if (post) {
      const posted = await request(ctx.app)
        .post(`/api/v1/purchases/invoices/${invoice.id}/post`)
        .set(authHeader(adminToken));
      expect(posted.status).toBe(200);
    }
    return invoice;
  }

  async function createReturn({ supplierId, date, items, invoiceId, notes, post = false }) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: date,
        invoice_id: invoiceId,
        notes,
        items,
      });
    expect(created.status).toBe(201);
    const ret = unwrap(created);
    if (post) {
      const posted = await request(ctx.app)
        .post(`/api/v1/purchases/returns/${ret.id}/post`)
        .set(authHeader(adminToken));
      expect(posted.status).toBe(200);
      return unwrap(posted);
    }
    return ret;
  }

  async function paySupplier(supplierId, amount, date) {
    const draft = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "payment",
        voucher_date: date,
        lines: [{ line_type: "cash", amount, currency: "NIS", supplier_id: supplierId }],
      });
    expect(draft.status).toBe(201);
    const id = unwrap(draft).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/vouchers/${id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    return id;
  }

  async function supplierPrice(query) {
    const res = await request(ctx.app)
      .get("/api/v1/purchases/supplier-unit-price")
      .query(query)
      .set(authHeader(adminToken));
    return { res, body: unwrap(res) };
  }

  test("convertPurchaseUnitCost never copies a carton price into a piece", () => {
    expect(convertPurchaseUnitCost(24, 12, 1)).toBe(2);
    expect(convertPurchaseUnitCost(2, 1, 12)).toBe(24);
  });

  test("suggests latest posted price from the selected supplier only", async () => {
    await createInvoice({
      supplierId: supplierA,
      date: "2026-08-01",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 10, total_cost: 80 }],
    });
    await createInvoice({
      supplierId: supplierA,
      date: "2026-09-01",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 10, total_cost: 100 }],
    });
    await createInvoice({
      supplierId: supplierB,
      date: "2026-09-10",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 10, total_cost: 400 }],
    });
    const draftLater = await createInvoice({
      supplierId: supplierA,
      date: "2026-09-12",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 1, total_cost: 9 }],
      post: false,
    });
    expect(unwrap(
      await request(ctx.app).get(`/api/v1/purchases/invoices/${draftLater.id}`).set(authHeader(adminToken))
    ).status).toBe("draft");

    const { res, body } = await supplierPrice({
      supplier_id: supplierA,
      product_id: productId,
      unit_id: pieceId,
      as_of: "2026-09-15",
    });
    expect(res.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.unit_cost).toBeCloseTo(10, 2);
    expect(body.source.kind).toBe("latest_purchase");
    expect(body.source.invoice_date).toBe("2026-09-01");
  });

  test("does not use another supplier's price or purchases after the return date", async () => {
    const { body } = await supplierPrice({
      supplier_id: supplierA,
      product_id: productId,
      unit_id: pieceId,
      as_of: "2026-08-15",
    });
    expect(body.found).toBe(true);
    expect(body.unit_cost).toBeCloseTo(8, 2);
    expect(body.source.invoice_date).toBe("2026-08-01");
  });

  test("original invoice price wins over a later purchase", async () => {
    const original = await ctx.db.get(
      "SELECT id FROM purchase_invoices WHERE supplier_id = ? AND invoice_date = '2026-08-01' AND status = 'posted'",
      [supplierA]
    );
    const { body } = await supplierPrice({
      supplier_id: supplierA,
      product_id: productId,
      unit_id: pieceId,
      as_of: "2026-09-15",
      invoice_id: original.id,
    });
    expect(body.found).toBe(true);
    expect(body.unit_cost).toBeCloseTo(8, 2);
    expect(body.source.kind).toBe("original_invoice");
    expect(Number(body.source.invoice_id)).toBe(Number(original.id));
  });

  test("converts carton history into a piece suggestion and keeps pre-discount unit_cost", async () => {
    const discounted = await createInvoice({
      supplierId: supplierA,
      date: "2026-09-16",
      items: [{
        product_id: productId,
        unit_id: cartonId,
        quantity: 1,
        total_cost: 24,
        discount_pct: 10,
      }],
    });
    expect(discounted.id).toBeTruthy();
    const { body } = await supplierPrice({
      supplier_id: supplierA,
      product_id: productId,
      unit_id: pieceId,
      as_of: "2026-09-16",
    });
    expect(body.found).toBe(true);
    expect(body.unit_cost).toBeCloseTo(2, 2);
    expect(body.source.converted).toBe(true);
  });

  test("returns empty suggestion when this supplier has no posted history", async () => {
    const emptySup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('بدون مشتريات', 'SX', 0, 0)"
    );
    const { res, body } = await supplierPrice({
      supplier_id: emptySup.lastID,
      product_id: productId,
      unit_id: pieceId,
      as_of: "2026-09-16",
    });
    expect(res.status).toBe(200);
    expect(body.found).toBe(false);
    expect(body.unit_cost).toBeNull();
    expect(body.message).toMatch(/لا يوجد سعر شراء سابق/);
  });

  test("draft return leaves stock and supplier balance unchanged", async () => {
    const beforeStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId])).stock
    );
    const beforeBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierA])).balance
    );
    const beforeMoves = Number(
      (await ctx.db.get(
        "SELECT COUNT(*) AS n FROM inventory_ledger WHERE movement_type = 'supplier_return'"
      )).n
    );
    const draft = await createReturn({
      supplierId: supplierA,
      date: "2026-09-17",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 1, total_cost: 10 }],
      notes: "مسودة لا تُرحّل",
    });
    expect(draft.status).toBe("draft");
    const afterStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId])).stock
    );
    const afterBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierA])).balance
    );
    const afterMoves = Number(
      (await ctx.db.get(
        "SELECT COUNT(*) AS n FROM inventory_ledger WHERE movement_type = 'supplier_return'"
      )).n
    );
    expect(afterStock).toBe(beforeStock);
    expect(afterBal).toBeCloseTo(beforeBal, 2);
    expect(afterMoves).toBe(beforeMoves);
  });

  test("posted return 1000 purchase, 200 payment, 150 return => 650 owed once", async () => {
    const demo = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد مثال', 'EX-650', 0, 0)"
    );
    const sid = demo.lastID;
    await createInvoice({
      supplierId: sid,
      date: "2026-09-01",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 100, total_cost: 1000 }],
    });
    const payId = await paySupplier(sid, 200, "2026-09-05");
    const ret = await createReturn({
      supplierId: sid,
      date: "2026-09-10",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 15, total_cost: 150 }],
      notes: "إرجاع علب تالفة",
      post: true,
    });

    const balance = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [sid])).balance
    );
    expect(balance).toBeCloseTo(650, 2);

    const statement = await request(ctx.app)
      .get(`/api/v1/suppliers/${sid}/statement-ledger`)
      .set(authHeader(adminToken));
    expect(statement.status).toBe(200);
    const ledger = unwrap(statement);
    const returns = (ledger.movements || []).filter((m) => m.type === "purchase_return");
    expect(returns).toHaveLength(1);
    expect(returns[0].debit).toBeCloseTo(150, 2);
    expect(returns[0].credit).toBe(0);
    expect(returns[0].documentNo).toBe(String(ret.return_no ?? ret.id));
    expect(returns[0].date).toBe("2026-09-10");
    expect(returns[0].description).toMatch(/مرتجع مشتريات/);
    expect(returns[0].description).toMatch(/علب تالفة/);
    expect(returns[0].sourceRoute).toBe(`/purchases?returnId=${ret.id}`);
    const payments = (ledger.movements || []).filter((m) => m.type === "supplier_payment");
    expect(payments).toHaveLength(1);
    expect(payments[0].sourceRoute).toBe(`/vouchers/payment?id=${payId}`);
    expect(ledger.summary.totalReturns).toBeCloseTo(150, 2);
    expect(ledger.summary.finalBalance).toBeCloseTo(650, 2);

    const again = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${ret.id}/post`)
      .set(authHeader(adminToken));
    expect(again.status).toBe(400);
    expect(unwrap(again).code || again.body.code).toBe("ALREADY_POSTED");
    const afterRetry = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [sid])).balance
    );
    expect(afterRetry).toBeCloseTo(650, 2);
    const returnRows = await ctx.db.all(
      "SELECT id FROM purchase_returns WHERE supplier_id = ? AND status = 'posted'",
      [sid]
    );
    expect(returnRows).toHaveLength(1);

    const later = await createReturn({
      supplierId: sid,
      date: "2026-09-20",
      items: [{ product_id: productId, unit_id: pieceId, quantity: 5, total_cost: 50 }],
      post: true,
    });
    expect(later.id).toBeTruthy();
    const untilMid = await request(ctx.app)
      .get(`/api/v1/suppliers/${sid}/statement-ledger`)
      .query({ from: "2026-09-01", to: "2026-09-10" })
      .set(authHeader(adminToken));
    const mid = unwrap(untilMid);
    expect(mid.summary.finalBalance).toBeCloseTo(650, 2);

    const balances = await request(ctx.app)
      .get("/api/v1/suppliers/balances")
      .query({ only_open: 0 })
      .set(authHeader(adminToken));
    expect(balances.status).toBe(200);
    const report = unwrap(balances);
    const row = report.suppliers.find((s) => Number(s.id) === Number(sid));
    expect(row.credit_total).toBeCloseTo(1000, 2);
    expect(row.debit_total).toBeCloseTo(200, 2);
    expect(row.return_total).toBeCloseTo(200, 2);
    expect(row.balance).toBeCloseTo(600, 2);
    expect(round2Local(row.credit_total - row.debit_total - row.return_total)).toBeCloseTo(row.balance, 2);
    expect(report.total_payable).toBeGreaterThanOrEqual(row.balance);
  });

  test("imported opening balance stays in دائن without fabricating purchases", async () => {
    const imported = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance, opening_balance_source)
       VALUES ('مورد مستورد', 'IMP-1', 400, 400, 'hesabati_import')`
    );
    const balances = await request(ctx.app)
      .get("/api/v1/suppliers/balances")
      .set(authHeader(adminToken));
    const row = unwrap(balances).suppliers.find((s) => Number(s.id) === Number(imported.lastID));
    expect(row.credit_total).toBeCloseTo(400, 2);
    expect(row.debit_total).toBe(0);
    expect(row.return_total).toBe(0);
    expect(row.balance).toBeCloseTo(400, 2);
    expect(row.opening_balance).toBeCloseTo(400, 2);
    expect(row.opening_balance_source).toBe("hesabati_import");
  });
});

function round2Local(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
