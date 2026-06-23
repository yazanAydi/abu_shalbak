import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function unwrap(res) {
  return res.body?.data ?? res.body;
}

async function changePrice(app, token, productId, newPrice, reason) {
  return request(app)
    .post(`/api/v1/products/${productId}/change-price`)
    .set(authHeader(token))
    .send({ new_price: newPrice, reason });
}

async function checkout(app, token, productId, quantity, price) {
  return request(app)
    .post("/api/v1/checkout")
    .set(authHeader(token))
    .send({
      items: [{ product_id: productId, quantity, price }],
      payment_method: "cash",
    });
}

describe("Product price history + 360 endpoints", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("change-price endpoint records a history row, audit log, and updates current price", async () => {
    const before = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const oldPrice = round2(before.price);
    const newPrice = round2(oldPrice + 2);

    const res = await changePrice(ctx.app, adminToken, ctx.productId, newPrice, "زيادة تكلفة المورد");
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(round2(body.product.price)).toBe(newPrice);
    expect(round2(body.history.new_price)).toBe(newPrice);
    expect(round2(body.history.old_price)).toBe(oldPrice);

    const histRow = await ctx.db.get(
      "SELECT * FROM product_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [ctx.productId]
    );
    expect(round2(histRow.new_price)).toBe(newPrice);
    expect(histRow.reason).toBe("زيادة تكلفة المورد");

    const audit = await ctx.db.get(
      "SELECT * FROM audit_logs WHERE entity_type='products' AND entity_id=? AND action='PRICE_CHANGE' ORDER BY id DESC LIMIT 1",
      [ctx.productId]
    );
    expect(audit).toBeTruthy();
  });

  test("editing the product via PUT also records a price-history row when price changes", async () => {
    const before = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const newPrice = round2(Number(before.price) + 1);

    const res = await request(ctx.app)
      .put(`/api/v1/products/${ctx.productId}`)
      .set(authHeader(adminToken))
      .send({ price: newPrice, reason: "تعديل عبر الشاشة" });
    expect(res.status).toBe(200);

    const histRow = await ctx.db.get(
      "SELECT * FROM product_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [ctx.productId]
    );
    expect(round2(histRow.new_price)).toBe(newPrice);
    expect(round2(histRow.old_price)).toBe(round2(before.price));
  });

  test("price-history endpoint returns rows ordered newest-first", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/price-history`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // ids must be strictly descending (newest first)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].id).toBeGreaterThan(rows[i].id);
    }
    // newest history matches current product price
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    expect(round2(rows[0].new_price)).toBe(round2(product.price));
  });

  test("a sale is grouped under its historical selling price and survives a later price change", async () => {
    // Sell at price A
    await changePrice(ctx.app, adminToken, ctx.productId, 20, "ضبط سعر للبيع");
    const sale = await checkout(ctx.app, cashierToken, ctx.productId, 2, 20);
    expect(sale.status).toBe(201);

    const before = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken));
    const rowsBefore = unwrap(before).rows;
    const rowAtA = rowsBefore.find((r) => r.unit_price_at_sale === 20);
    expect(rowAtA).toBeTruthy();
    expect(rowAtA.sold_quantity).toBe(2);

    // Change the current selling price afterwards
    await changePrice(ctx.app, adminToken, ctx.productId, 25, "رفع السعر");

    const after = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/sales-by-price`)
      .set(authHeader(adminToken));
    const rowsAfter = unwrap(after).rows;

    // Historical row at 20 unchanged; nothing was sold at 25
    const stillRowAtA = rowsAfter.find((r) => r.unit_price_at_sale === 20);
    expect(stillRowAtA).toBeTruthy();
    expect(stillRowAtA.sold_quantity).toBe(2);
    expect(rowsAfter.find((r) => r.unit_price_at_sale === 25)).toBeFalsy();
  });

  test("supplier purchase history is unaffected by selling-price changes", async () => {
    // Create + post a purchase invoice for the product
    const supRes = await request(ctx.app)
      .post("/api/v1/suppliers")
      .set(authHeader(adminToken))
      .send({ name: "مورد اختبار" });
    expect(supRes.status).toBe(201);
    const supplierId = unwrap(supRes).id;

    const invRes = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: ctx.productId, quantity: 10, unit_cost: 6 }],
      });
    expect(invRes.status).toBe(201);
    const invoiceId = unwrap(invRes).id;

    const postRes = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken));
    expect(postRes.status).toBe(200);

    const before = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/supplier-prices`)
      .set(authHeader(adminToken));
    expect(before.status).toBe(200);
    const supBefore = unwrap(before).rows.find((r) => r.supplier_id === supplierId);
    expect(supBefore).toBeTruthy();
    expect(supBefore.avg_cost).toBe(6);

    // Change selling price — must NOT affect purchase/supplier data
    await changePrice(ctx.app, adminToken, ctx.productId, 33, "تغيير لا يؤثر على المشتريات");

    const after = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/supplier-prices`)
      .set(authHeader(adminToken));
    const supAfter = unwrap(after).rows.find((r) => r.supplier_id === supplierId);
    expect(supAfter).toEqual(supBefore);
  });

  test("non-admin users cannot change the selling price", async () => {
    const res = await changePrice(ctx.app, cashierToken, ctx.productId, 99, "محاولة غير مصرّحة");
    expect(res.status).toBe(403);

    // and the price did not change
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    expect(round2(product.price)).not.toBe(99);
  });

  test("change-price rejects a missing reason and a no-op price", async () => {
    const noReason = await request(ctx.app)
      .post(`/api/v1/products/${ctx.productId}/change-price`)
      .set(authHeader(adminToken))
      .send({ new_price: 40 });
    expect(noReason.status).toBe(400);

    const current = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const sameRes = await changePrice(ctx.app, adminToken, ctx.productId, round2(current.price), "بدون تغيير");
    expect(sameRes.status).toBe(400);
  });

  test("dashboard endpoint exposes summary cards and price-change count", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/products/${ctx.productId}/dashboard`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.product.id).toBe(ctx.productId);
    expect(body.summary).toHaveProperty("current_price");
    expect(body.summary).toHaveProperty("inventory_value");
    expect(body.summary.price_changes).toBeGreaterThanOrEqual(2);
    expect(body.summary.supplier_count).toBeGreaterThanOrEqual(1);
  });
});
