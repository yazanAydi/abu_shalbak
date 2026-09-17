import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

function unwrapData(body) {
  return body?.data ?? body;
}

function unwrapList(body) {
  const data = unwrapData(body);
  if (Array.isArray(data)) return data;
  // Paginated list endpoints answer with { items, total, limit, offset }.
  return Array.isArray(data?.items) ? data.items : [];
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

  test("cashier product search and POS lookup hide bakery supplies", async () => {
    const search = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "طحين" })
      .set(authHeader(cashierToken));
    expect(search.status).toBe(200);
    expect(unwrapList(search.body).some((p) => p.id === bakeryProductId)).toBe(false);

    const posLookup = await request(ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: "8800001001" })
      .set(authHeader(cashierToken));
    expect(posLookup.status).toBe(200);
    expect(unwrapData(posLookup.body).found).toBe(false);

    const cashierLookup = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: "8800001001" })
      .set(authHeader(cashierToken));
    expect(cashierLookup.status).toBe(200);
    expect(unwrapData(cashierLookup.body).found).toBe(false);
  });

  test("office search still finds bakery supplies", async () => {
    const search = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "طحين" })
      .set(authHeader(adminToken));
    expect(search.status).toBe(200);
    expect(unwrapList(search.body).some((p) => p.id === bakeryProductId)).toBe(true);

    const officeLookup = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: "8800001001" })
      .set(authHeader(adminToken));
    expect(officeLookup.status).toBe(200);
    expect(unwrapData(officeLookup.body).found).toBe(true);
  });

  test("retail supermarket SKU stays on POS without a bakery toggle", async () => {
    const search = await request(ctx.app)
      .get("/api/v1/pos/search?q=Test")
      .set(authHeader(cashierToken));
    expect(search.status).toBe(200);
    expect(unwrapList(search.body).some((p) => p.id === ctx.productId)).toBe(true);

    const lookup = await request(ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: "9990001" })
      .set(authHeader(cashierToken));
    expect(lookup.status).toBe(200);
    expect(unwrapData(lookup.body).found).toBe(true);
  });

  test("retail SKU stays on POS after its only unit is sale_enabled off", async () => {
    await ctx.db.run(
      "UPDATE product_units SET sale_enabled = 0 WHERE product_id = ?",
      [ctx.productId]
    );
    const search = await request(ctx.app)
      .get("/api/v1/pos/search?q=Test")
      .set(authHeader(cashierToken));
    expect(search.status).toBe(200);
    expect(unwrapList(search.body).some((p) => p.id === ctx.productId)).toBe(true);

    const lookup = await request(ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: "9990001" })
      .set(authHeader(cashierToken));
    expect(lookup.status).toBe(200);
    expect(unwrapData(lookup.body).found).toBe(true);

    await ctx.db.run(
      "UPDATE product_units SET sale_enabled = 1 WHERE product_id = ?",
      [ctx.productId]
    );
  });

  test("checkout rejects bakery supply products", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: bakeryProductId, quantity: 1, price: 0 }],
        payment_method: "cash",
      }));
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

  test("consumption adjustment detail includes who, date, and counted items", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "consumption",
        adjustment_date: "2026-09-17",
        items: [{ product_id: bakeryProductId, quantity: 1.5 }],
        post: true,
      });
    expect(res.status).toBe(201);
    const created = unwrapData(res.body);

    const detail = await request(ctx.app)
      .get(`/api/v1/inventory/adjustments/${created.id}`)
      .set(authHeader(adminToken));
    expect(detail.status).toBe(200);
    const data = unwrapData(detail.body);
    expect(data.created_by_name).toBe("testadmin");
    expect(String(data.adjustment_date).slice(0, 10)).toBe("2026-09-17");
    expect(data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: bakeryProductId,
          name: "طحين",
          quantity: 1.5,
          unit: "كغم",
        }),
      ])
    );
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
