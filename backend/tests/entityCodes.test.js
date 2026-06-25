import {
  backfillMissingEntityCodes,
  ensureEntityCode,
  nextEntityCode,
  parseNumericCode,
  renumberAllEntityCodes,
} from "../utils/entityCodes.js";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import request from "supertest";

describe("entityCodes", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  test("parseNumericCode accepts plain and padded integers", () => {
    expect(parseNumericCode("1")).toBe(1);
    expect(parseNumericCode("00042")).toBe(42);
    expect(parseNumericCode("C001")).toBeNull();
    expect(parseNumericCode("")).toBeNull();
  });

  test("nextEntityCode returns sequential unpadded strings per entity type", async () => {
    const p1 = await nextEntityCode(ctx.db, "product");
    const p2 = await nextEntityCode(ctx.db, "product");
    expect(Number(p2)).toBe(Number(p1) + 1);

    const c1 = await nextEntityCode(ctx.db, "customer");
    const s1 = await nextEntityCode(ctx.db, "supplier");
    expect(Number(c1)).toBeGreaterThan(0);
    expect(Number(s1)).toBeGreaterThan(0);

    const p3 = await nextEntityCode(ctx.db, "product");
    expect(Number(p3)).toBe(Number(p2) + 1);
  });

  test("ensureEntityCode keeps provided code or allocates next", async () => {
    expect(await ensureEntityCode(ctx.db, "product", "99")).toBe("99");
    const before = await ctx.db.get(
      "SELECT last_seq FROM entity_code_sequences WHERE entity_type = 'product'"
    );
    const allocated = await ensureEntityCode(ctx.db, "product", "  ");
    expect(Number(allocated)).toBe(Number(before?.last_seq ?? 0) + 1);
    const allocated2 = await ensureEntityCode(ctx.db, "product", null);
    expect(Number(allocated2)).toBe(Number(allocated) + 1);
  });

  test("backfillMissingEntityCodes fills empty rows ordered by id", async () => {
    await ctx.db.run("UPDATE products SET sku = NULL WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('9990002', 'Second Product', 5, 2, 'Test', 10, NULL)`
    );
    await ctx.db.run(
      `INSERT INTO customers (name, price_category, customer_code, balance)
       VALUES ('Alpha Customer', 'retail', NULL, 0)`
    );
    await ctx.db.run(
      `INSERT INTO customers (name, price_category, customer_code, balance)
       VALUES ('Beta Customer', 'retail', '5', 0)`
    );
    await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance)
       VALUES ('Gamma Supplier', NULL, 0)`
    );

    await backfillMissingEntityCodes(ctx.db);

    const first = await ctx.db.get("SELECT sku FROM products WHERE barcode = ?", ["9990001"]);
    const second = await ctx.db.get("SELECT sku FROM products WHERE barcode = ?", ["9990002"]);
    expect(first.sku).toBeTruthy();
    expect(second.sku).toBeTruthy();
    expect(Number(second.sku)).toBe(Number(first.sku) + 1);

    const alpha = await ctx.db.get("SELECT customer_code FROM customers WHERE name = ?", [
      "Alpha Customer",
    ]);
    const beta = await ctx.db.get("SELECT customer_code FROM customers WHERE name = ?", [
      "Beta Customer",
    ]);
    expect(alpha.customer_code).toBeTruthy();
    expect(beta.customer_code).toBe("5");

    const supplier = await ctx.db.get("SELECT supplier_code FROM suppliers WHERE name = ?", [
      "Gamma Supplier",
    ]);
    expect(supplier.supplier_code).toBe("1");
  });

  test("renumberAllEntityCodes assigns 1..N ordered by id", async () => {
    await ctx.db.run("UPDATE products SET sku = '6201' WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('9990099', 'Renumber Me', 3, 1, 'Test', 1, '12666')`
    );

    const total = await renumberAllEntityCodes(ctx.db, "product");
    expect(total).toBeGreaterThanOrEqual(2);

    const rows = await ctx.db.all("SELECT id, sku FROM products ORDER BY id");
    rows.forEach((row, index) => {
      expect(row.sku).toBe(String(index + 1));
    });
  });

  test("POST product without sku returns assigned code", async () => {
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(token))
      .send({
        barcode: "8880001",
        name: "Auto Number Product",
        price: 12,
        stock: 5,
      });

    expect(res.status).toBe(201);
    const row = res.body.data ?? res.body;
    expect(row.sku).toBeTruthy();
    expect(Number(row.sku)).toBeGreaterThan(0);
  });

  test("POST customer without customer_code returns assigned code", async () => {
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/v1/customers")
      .set(authHeader(token))
      .send({ name: "Auto Number Customer" });

    expect(res.status).toBe(201);
    const row = res.body.data ?? res.body;
    expect(row.customer_code).toBeTruthy();
    expect(Number(row.customer_code)).toBeGreaterThan(0);
  });
});
