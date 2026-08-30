import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

/**
 * Product number (رقم المنتج) policy: a number is a stable human identifier.
 * It is issued once, never recycled, and gaps left by deleted products stay
 * visible. See docs/PRODUCT_NUMBER_AND_BARCODE.md.
 */
describe("product numbering policy", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;
  let adminToken;

  beforeEach(async () => {
    ctx = await createTestContext();
    const res = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = res.body.token;
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  function unwrap(body) {
    return body?.data ?? body;
  }

  async function suggestedSku() {
    const res = await request(ctx.app)
      .get("/api/v1/products/next-sku")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body).sku;
  }

  /** Mirrors the add form, which pre-fills الرقم with the suggestion. */
  async function createProduct(name, barcode, sku) {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({ barcode, name, price: 10, stock: 1, ...(sku ? { sku } : {}) });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function deleteProduct(id) {
    const res = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(res.status).toBe(204);
  }

  test("new products receive increasing numbers", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    const b = await createProduct("B", "8880002", await suggestedSku());
    const c = await createProduct("C", "8880003", await suggestedSku());

    expect(Number(b.sku)).toBe(Number(a.sku) + 1);
    expect(Number(c.sku)).toBe(Number(b.sku) + 1);
  });

  test("deleting a product leaves every remaining number unchanged", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    const b = await createProduct("B", "8880002", await suggestedSku());
    const c = await createProduct("C", "8880003", await suggestedSku());

    await deleteProduct(b.id);

    const afterA = await ctx.db.get("SELECT sku FROM products WHERE id = ?", [a.id]);
    const afterC = await ctx.db.get("SELECT sku FROM products WHERE id = ?", [c.id]);
    expect(afterA.sku).toBe(a.sku);
    expect(afterC.sku).toBe(c.sku);
  });

  test("a deleted number is never handed out again", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    const b = await createProduct("B", "8880002", await suggestedSku());
    const c = await createProduct("C", "8880003", await suggestedSku());

    await deleteProduct(b.id);

    const d = await createProduct("D", "8880004", await suggestedSku());
    expect(Number(d.sku)).toBe(Number(c.sku) + 1);
    expect(Number(d.sku)).not.toBe(Number(b.sku));
    expect(Number(d.sku)).toBeGreaterThan(Number(a.sku));
  });

  test("deleting the newest product does not free its number", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    await deleteProduct(a.id);

    const next = await suggestedSku();
    expect(Number(next)).toBe(Number(a.sku) + 1);
  });

  test("the suggested number matches what the server allocates on its own", async () => {
    await createProduct("A", "8880001", await suggestedSku());

    const suggestion = await suggestedSku();
    const auto = await createProduct("B", "8880002", null);
    expect(auto.sku).toBe(suggestion);
  });

  test("a manually entered high number advances the sequence", async () => {
    await createProduct("Manual", "8880001", "00000000050");
    expect(Number(await suggestedSku())).toBe(51);
  });

  test("the list returns stored numbers verbatim, gaps included", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    const b = await createProduct("B", "8880002", await suggestedSku());
    const c = await createProduct("C", "8880003", await suggestedSku());

    await deleteProduct(b.id);
    const d = await createProduct("D", "8880004", await suggestedSku());

    const res = await request(ctx.app)
      .get("/api/v1/products?limit=all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);

    const skus = unwrap(res.body)
      .items.filter((p) => [a.id, c.id, d.id].includes(p.id))
      .map((p) => p.sku);

    // No renumbering, no placeholder rows — the gap left by B stays a gap.
    expect(skus).toEqual([a.sku, c.sku, d.sku]);
    expect(skus).not.toContain(b.sku);
  });

  test("renumber stays admin-only and is never triggered by a delete", async () => {
    const a = await createProduct("A", "8880001", await suggestedSku());
    const b = await createProduct("B", "8880002", await suggestedSku());

    const cashier = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const denied = await request(ctx.app)
      .post("/api/v1/admin/renumber-entity-codes")
      .set(authHeader(cashier.body.token))
      .send({ types: ["product"] });
    expect(denied.status).toBe(403);

    await deleteProduct(a.id);
    const afterB = await ctx.db.get("SELECT sku FROM products WHERE id = ?", [b.id]);
    expect(afterB.sku).toBe(b.sku);
  });
});
