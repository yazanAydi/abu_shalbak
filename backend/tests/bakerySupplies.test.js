import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function unwrapData(body) {
  return body?.data ?? body;
}

function unwrapList(body) {
  const data = unwrapData(body);
  return Array.isArray(data) ? data : [];
}

describe("bakery supplies inventory", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let bakeryProductId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;

    const sup = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('Bakery Supplier')");
    supplierId = sup.lastID;

    const create = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800001001",
        name: "طحين",
        price: 0,
        cost: 3,
        stock: 10,
        unit: "كغم",
        inventory_scope: "bakery",
        min_stock: 5,
      });
    expect(create.status).toBe(201);
    bakeryProductId = unwrapData(create.body).id;

    const unit = await ctx.db.get(
      "SELECT sale_enabled, purchase_enabled FROM product_units WHERE product_id = ? AND is_default = 1",
      [bakeryProductId]
    );
    expect(Number(unit.sale_enabled)).toBe(0);
    expect(Number(unit.purchase_enabled)).toBe(1);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("retail product list excludes bakery supplies by default scope filter", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products?scope=retail")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrapList(res.body);
    expect(rows.some((p) => p.id === bakeryProductId)).toBe(false);
    expect(rows.some((p) => p.id === ctx.productId)).toBe(true);
  });

  test("bakery scope list includes bakery supplies only", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products?scope=bakery")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrapList(res.body);
    expect(rows.some((p) => p.id === bakeryProductId)).toBe(true);
    expect(rows.some((p) => p.id === ctx.productId)).toBe(false);
  });

  test("POS search excludes bakery supplies", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/pos/search?q=طحين")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const rows = unwrapList(res.body);
    expect(rows.some((p) => p.id === bakeryProductId)).toBe(false);
  });

  test("checkout rejects bakery supply products", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: bakeryProductId, quantity: 1, price: 0 }],
        payment_method: "cash",
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BAKERY_SUPPLY_NOT_SELLABLE");
  });

  test("purchase post increases bakery stock", async () => {
    const before = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakeryProductId]);

    const create = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [{ product_id: bakeryProductId, quantity: 4, total_cost: 12 }],
      });
    expect(create.status).toBe(201);
    const invoiceId = unwrapData(create.body).id;

    const post = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakeryProductId]);
    expect(after.stock).toBe(before.stock + 4);
  });

  test("consumption adjustment decreases bakery stock", async () => {
    const before = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakeryProductId]);

    const res = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "consumption",
        items: [{ product_id: bakeryProductId, quantity: 2 }],
        post: true,
      });
    expect(res.status).toBe(201);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakeryProductId]);
    expect(after.stock).toBe(before.stock - 2);
  });

  test("low-stock report filtered to bakery scope", async () => {
    await ctx.db.run("UPDATE products SET stock = 2, min_stock = 5 WHERE id = ?", [bakeryProductId]);
    await ctx.db.run("UPDATE products SET stock = 1 WHERE id = ?", [ctx.productId]);

    const bakeryRes = await request(ctx.app)
      .get("/api/v1/inventory/low-stock?scope=bakery&threshold=10")
      .set(authHeader(adminToken));
    expect(bakeryRes.status).toBe(200);
    const bakeryRows = unwrapList(bakeryRes.body);
    expect(bakeryRows.some((p) => p.id === bakeryProductId)).toBe(true);
    expect(bakeryRows.some((p) => p.id === ctx.productId)).toBe(false);

    const retailRes = await request(ctx.app)
      .get("/api/v1/inventory/low-stock?scope=retail&threshold=10")
      .set(authHeader(adminToken));
    expect(retailRes.status).toBe(200);
    const retailRows = unwrapList(retailRes.body);
    expect(retailRows.some((p) => p.id === ctx.productId)).toBe(true);
    expect(retailRows.some((p) => p.id === bakeryProductId)).toBe(false);
  });
});
