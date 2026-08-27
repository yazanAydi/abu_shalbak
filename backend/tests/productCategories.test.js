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

describe("product categories", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;
  let adminToken;

  beforeEach(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  test("seeds existing product categories and bakery default", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products/categories")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrapData(res.body);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Beverages", "Bakery", "مواد مخبز"]));
  });

  test("admin can add a category and pick it on a product", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "  مشروبات  " });
    expect(created.status).toBe(201);
    expect(unwrapData(created.body).name).toBe("مشروبات");

    const dup = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "مشروبات" });
    expect(dup.status).toBe(409);

    const product = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800990001",
        name: "عصير",
        price: 3,
        stock: 5,
        category: "مشروبات",
      });
    expect(product.status).toBe(201);
    expect(unwrapData(product.body).category).toBe("مشروبات");
  });

  test("rename updates products and promotions", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "ألبان" });
    const id = unwrapData(created.body).id;

    await ctx.db.run("UPDATE products SET category = 'ألبان' WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `INSERT INTO promotions (name, offer_type, category, discount_value, active)
       VALUES ('خصم ألبان', 'percentage', 'ألبان', 10, 1)`
    );

    const renamed = await request(ctx.app)
      .put(`/api/v1/products/categories/${id}`)
      .set(authHeader(adminToken))
      .send({ name: "مشتقات الألبان" });
    expect(renamed.status).toBe(200);
    expect(unwrapData(renamed.body).name).toBe("مشتقات الألبان");

    const product = await ctx.db.get("SELECT category FROM products WHERE id = ?", [ctx.productId]);
    expect(product.category).toBe("مشتقات الألبان");
    const promo = await ctx.db.get("SELECT category FROM promotions WHERE name = 'خصم ألبان'");
    expect(promo.category).toBe("مشتقات الألبان");
  });

  test("delete deactivates when used and removes when unused", async () => {
    const used = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "مستخدم" });
    const usedId = unwrapData(used.body).id;
    await ctx.db.run("UPDATE products SET category = 'مستخدم' WHERE id = ?", [ctx.productId]);

    const deactivate = await request(ctx.app)
      .delete(`/api/v1/products/categories/${usedId}`)
      .set(authHeader(adminToken));
    expect(deactivate.status).toBe(200);
    expect(unwrapData(deactivate.body).deactivated).toBe(true);

    const unused = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "غير مستخدم" });
    const unusedId = unwrapData(unused.body).id;
    const removed = await request(ctx.app)
      .delete(`/api/v1/products/categories/${unusedId}`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(200);
    expect(unwrapData(removed.body).deactivated).toBe(false);

    const gone = await ctx.db.get("SELECT * FROM product_categories WHERE id = ?", [unusedId]);
    expect(gone).toBeUndefined();
  });
});
