import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("GET /api/v1/products/lookup", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function body(res) {
    return res.body.data ?? res.body;
  }

  test("unknown barcode returns 200 with found:false", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: "7290000107189" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ found: false });
  });

  test("empty barcode returns 200 with found:false", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ found: false });
  });

  test("/lookup is not captured as GET /:barcode", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(body(res).found).toBe(false);
    expect(body(res).error).toBeUndefined();
  });

  test("existing barcode returns 200 with found:true and product fields", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const res = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: product.barcode })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const payload = body(res);
    expect(payload.found).toBe(true);
    expect(payload.inactive).toBe(false);
    expect(Number(payload.id ?? payload.product?.id)).toBe(ctx.productId);
    expect(payload.name ?? payload.product?.name).toBe(product.name);
  });

  test("inactive product returns 200 found:true inactive:true", async () => {
    const product = await ctx.db.get("SELECT barcode FROM products WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE products SET is_active = 0 WHERE id = ?", [ctx.productId]);

    const lookup = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: product.barcode })
      .set(authHeader(adminToken));
    expect(lookup.status).toBe(200);
    expect(body(lookup).found).toBe(true);
    expect(body(lookup).inactive).toBe(true);

    const pos = await request(ctx.app)
      .get(`/api/v1/products/${encodeURIComponent(product.barcode)}`)
      .set(authHeader(cashierToken));
    expect(pos.status).toBe(404);

    await ctx.db.run("UPDATE products SET is_active = 1 WHERE id = ?", [ctx.productId]);
  });
});
