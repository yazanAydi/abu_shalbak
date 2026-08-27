import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { CANONICAL_UNIT_NAMES } from "../utils/unitNames.js";

function unwrapData(body) {
  return body?.data ?? body;
}

describe("unit name catalog", () => {
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

  test("seeds canonical unit names", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products/unit-names")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const names = unwrapData(res.body).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(CANONICAL_UNIT_NAMES));
  });

  test("admin can add a unit name and use it on a product", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products/unit-names")
      .set(authHeader(adminToken))
      .send({ name: "  جالون  " });
    expect(created.status).toBe(201);
    expect(unwrapData(created.body).name).toBe("جالون");

    const dup = await request(ctx.app)
      .post("/api/v1/products/unit-names")
      .set(authHeader(adminToken))
      .send({ name: "جالون" });
    expect(dup.status).toBe(409);

    const product = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800991001",
        name: "زيت",
        price: 12,
        stock: 4,
        unit: "جالون",
      });
    expect(product.status).toBe(201);
    expect(unwrapData(product.body).unit).toBe("جالون");
  });

  test("rename updates product units and products.unit", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products/unit-names")
      .set(authHeader(adminToken))
      .send({ name: "ربطة كبيرة" });
    const id = unwrapData(created.body).id;

    await ctx.db.run("UPDATE products SET unit = 'ربطة كبيرة' WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET unit_name = 'ربطة كبيرة' WHERE product_id = ?", [
      ctx.productId,
    ]);

    const renamed = await request(ctx.app)
      .put(`/api/v1/products/unit-names/${id}`)
      .set(authHeader(adminToken))
      .send({ name: "ربطة خاصة" });
    expect(renamed.status).toBe(200);

    const product = await ctx.db.get("SELECT unit FROM products WHERE id = ?", [ctx.productId]);
    expect(product.unit).toBe("ربطة خاصة");
    const unit = await ctx.db.get(
      "SELECT unit_name FROM product_units WHERE product_id = ?",
      [ctx.productId]
    );
    expect(unit.unit_name).toBe("ربطة خاصة");
  });

  test("delete deactivates when used", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products/unit-names")
      .set(authHeader(adminToken))
      .send({ name: "مستخدم" });
    const id = unwrapData(created.body).id;
    await ctx.db.run("UPDATE products SET unit = 'مستخدم' WHERE id = ?", [ctx.productId]);

    const deactivate = await request(ctx.app)
      .delete(`/api/v1/products/unit-names/${id}`)
      .set(authHeader(adminToken));
    expect(deactivate.status).toBe(200);
    expect(unwrapData(deactivate.body).deactivated).toBe(true);
  });
});
