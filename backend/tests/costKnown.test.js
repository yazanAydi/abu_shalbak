import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("known zero cost is separate from unknown cost", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const sup = await ctx.db.run("INSERT INTO suppliers (name, balance, opening_balance) VALUES ('مورد مجاني', 0, 0)");
    supplierId = sup.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makePiece(name, { cost = 0, stock = 0, price = 7 } = {}) {
    const barcode = `77${String(name.length).padStart(2, "0")}${Date.now().toString().slice(-6)}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, 'Test', ?)`,
      [barcode, name, price, cost, stock]
    );
    const unit = await upsertProductUnit(ctx.db, ins.lastID, {
      unit_name: "حبة",
      barcode,
      price,
      cost,
      conversion_to_base: 1,
      is_default: true,
    });
    return { id: ins.lastID, unitId: unit.id };
  }

  async function postPurchase(items) {
    const create = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, items });
    expect(create.status).toBe(201);
    const id = unwrap(create).id;
    const post = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    return id;
  }

  test("a zero cost with no purchase stays unknown on the sale snapshot", async () => {
    const product = await makePiece("حافة غير معروفة", { cost: 0, stock: 2, price: 7 });
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: 7, unit_id: product.unitId }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    const item = await ctx.db.get(
      "SELECT unit_cost_at_sale, gross_profit FROM transaction_items WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [product.id]
    );
    expect(item.unit_cost_at_sale).toBeNull();
    expect(item.gross_profit).toBeNull();

    await postPurchase([{ product_id: product.id, unit_id: product.unitId, quantity: 4, total_cost: 20 }]);
    const after = await ctx.db.get("SELECT cost, cost_known, stock FROM products WHERE id = ?", [product.id]);
    expect(Number(after.cost_known)).toBe(1);
    expect(Number(after.cost)).toBeCloseTo(4, 2);
    const snapshot = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ? ORDER BY id ASC LIMIT 1",
      [product.id]
    );
    expect(snapshot.unit_cost_at_sale).toBeNull();
  });

  test("an explicit free receipt is known zero cost and does not create supplier debt", async () => {
    const before = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    const product = await makePiece("بونص مجاني", { cost: 3, stock: 0, price: 5 });
    await postPurchase([{ product_id: product.id, unit_id: product.unitId, quantity: 3, total_cost: 0 }]);
    const after = await ctx.db.get("SELECT cost, cost_known, stock FROM products WHERE id = ?", [product.id]);
    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(after.stock)).toBeCloseTo(3, 3);
    expect(Number(after.cost)).toBe(0);
    expect(Number(after.cost_known)).toBe(1);
    expect(Number(supplier.balance)).toBe(Number(before.balance));
  });

  test("bonus units share the paid purchase cost", async () => {
    const product = await makePiece("بونص مع شراء", { cost: 0, stock: 0, price: 9 });
    await postPurchase([
      { product_id: product.id, unit_id: product.unitId, quantity: 10, total_cost: 120, bonus_quantity: 2 },
    ]);
    const after = await ctx.db.get("SELECT cost, stock, cost_known FROM products WHERE id = ?", [product.id]);
    expect(Number(after.stock)).toBeCloseTo(12, 3);
    expect(Number(after.cost)).toBeCloseTo(10, 2);
    expect(Number(after.cost_known)).toBe(1);
  });

  test("a partial purchase return reduces the gross payable and leaves the stored VAT split", async () => {
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0.16')");
    const beforeBalance = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    const product = await makePiece("صنف ضريبة", { cost: 0, stock: 0, price: 1 });
    const invoiceId = await postPurchase([
      { product_id: product.id, unit_id: product.unitId, quantity: 10, total_cost: 116, vat_rate: 0.16 },
    ]);
    const line = await ctx.db.get(
      "SELECT line_net, line_vat, line_total FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(Number(line.line_net)).toBeCloseTo(100, 2);
    expect(Number(line.line_vat)).toBeCloseTo(16, 2);
    expect(Number(line.line_total)).toBeCloseTo(116, 2);
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_id: invoiceId,
        items: [{ product_id: product.id, unit_id: product.unitId, quantity: 5, total_cost: 58 }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    const kept = await ctx.db.get(
      "SELECT line_vat, line_net FROM purchase_invoice_items WHERE invoice_id = ?",
      [invoiceId]
    );
    const productRow = await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [product.id]);
    expect(Number(kept.line_vat)).toBeCloseTo(16, 2);
    expect(Number(kept.line_net)).toBeCloseTo(100, 2);
    expect(Number(productRow.cost)).toBeCloseTo(11.6, 2);
    expect(Number(productRow.stock)).toBeCloseTo(5, 3);
    expect(Number(supplier.balance) - beforeBalance).toBeCloseTo(58, 2);
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
  });
});
