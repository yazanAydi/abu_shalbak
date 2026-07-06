import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Product delete barcode reuse", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("deleting a product frees its barcode for reuse", async () => {
    const barcode = "5550011223344";
    const create = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "Delete Reuse Test",
        price: 12,
        stock: 5,
      });
    expect(create.status).toBe(201);
    const productId = create.body.data?.id ?? create.body.id;

    const pbBefore = await ctx.db.get(
      "SELECT id FROM product_barcodes WHERE product_id = ?",
      [productId]
    );
    const puBefore = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ?",
      [productId]
    );
    expect(pbBefore).toBeTruthy();
    expect(puBefore).toBeTruthy();

    const del = await request(ctx.app)
      .delete(`/api/v1/admin/products/${productId}`)
      .set(authHeader(adminToken));
    expect(del.status).toBe(204);

    const productGone = await ctx.db.get("SELECT id FROM products WHERE id = ?", [productId]);
    expect(productGone).toBeUndefined();

    const pbAfter = await ctx.db.get(
      "SELECT id FROM product_barcodes WHERE product_id = ?",
      [productId]
    );
    const puAfter = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ?",
      [productId]
    );
    expect(pbAfter).toBeUndefined();
    expect(puAfter).toBeUndefined();

    const recreate = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "Delete Reuse Test Again",
        price: 15,
        stock: 8,
      });
    expect(recreate.status).toBe(201);
    const newId = recreate.body.data?.id ?? recreate.body.id;
    expect(newId).not.toBe(productId);
  });

  test("bulk delete frees barcodes for reuse", async () => {
    const barcodeA = "5550011223355";
    const barcodeB = "5550011223366";

    const createA = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({ barcode: barcodeA, name: "Bulk A", price: 10, stock: 1 });
    const createB = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({ barcode: barcodeB, name: "Bulk B", price: 11, stock: 2 });
    expect(createA.status).toBe(201);
    expect(createB.status).toBe(201);

    const idA = createA.body.data?.id ?? createA.body.id;
    const idB = createB.body.data?.id ?? createB.body.id;

    const bulkDel = await request(ctx.app)
      .post("/api/v1/admin/products/bulk-delete")
      .set(authHeader(adminToken))
      .send({ ids: [idA, idB] });
    expect(bulkDel.status).toBe(200);
    expect(bulkDel.body.data?.deleted ?? bulkDel.body.deleted).toBe(2);

    for (const [barcode, name] of [
      [barcodeA, "Bulk A Again"],
      [barcodeB, "Bulk B Again"],
    ]) {
      const recreate = await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({ barcode, name, price: 10, stock: 1 });
      expect(recreate.status).toBe(201);
    }
  });
});
