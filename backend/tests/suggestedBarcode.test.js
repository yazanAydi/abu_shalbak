import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  formatProductSku,
  getNextProductNumber,
  isProductNumberShaped,
  padSuggestedBarcode,
  parseShortNumericBarcode,
} from "../utils/suggestedBarcode.js";
import { migrateSkuBarcodeSeparation, SKU_BARCODE_SEPARATION_VERSION } from "../utils/skuBarcodeRepair.js";

describe("suggestedBarcode", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  test("padSuggestedBarcode zero-pads to 11 digits", () => {
    expect(padSuggestedBarcode(1)).toBe("00000000001");
    expect(padSuggestedBarcode(50)).toBe("00000000050");
    expect(padSuggestedBarcode(999)).toBe("00000000999");
  });

  test("isProductNumberShaped compares numeric رقم values only", () => {
    expect(isProductNumberShaped("00000000001", "00000000001")).toBe(true);
    expect(isProductNumberShaped("00000000001", "1")).toBe(true);
    expect(isProductNumberShaped("7290013586773", "00000000001")).toBe(false);
  });

  test("formatProductSku keeps leading zeros for numeric رقم", () => {
    expect(formatProductSku("2")).toBe("00000000002");
    expect(formatProductSku("00000000002")).toBe("00000000002");
    expect(formatProductSku("ABC-9")).toBe("ABC-9");
    expect(formatProductSku("")).toBeNull();
  });

  test("parseShortNumericBarcode accepts 1–11 digit codes only", () => {
    expect(parseShortNumericBarcode("00000000001")).toBe(1);
    expect(parseShortNumericBarcode("7290013586773")).toBeNull();
    expect(parseShortNumericBarcode("abc")).toBeNull();
  });

  async function resetProducts() {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");
    await ctx.db.run("DELETE FROM entity_code_sequences WHERE entity_type = 'product'");
  }

  test("empty product tables suggest 00000000001", async () => {
    await resetProducts();
    expect(await getNextProductNumber(ctx.db)).toBe("00000000001");
  });

  test("next رقم follows existing sku values, not barcodes", async () => {
    await resetProducts();

    for (let i = 1; i <= 3; i += 1) {
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
         VALUES (?, ?, 10, 5, 'Test', 1, ?)`,
        [String(7290013586770 + i), `Product ${i}`, formatProductSku(i)]
      );
    }

    expect(await getNextProductNumber(ctx.db)).toBe("00000000004");
  });

  test("unit barcodes that look like a رقم do not consume the next رقم", async () => {
    await resetProducts();

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('7290013586773', 'EAN primary', 10, 5, 'Test', 1, '00000000001')`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '00000000002', 10, 5, 1, 1)`,
      [ins.lastID]
    );

    expect(await getNextProductNumber(ctx.db)).toBe("00000000002");
  });

  test("many products with sku suggest next padded رقم", async () => {
    await resetProducts();

    for (let i = 1; i <= 50; i += 1) {
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
         VALUES (?, ?, 10, 5, 'Test', 1, ?)`,
        [String(7290000000000 + i), `Product ${i}`, formatProductSku(i)]
      );
    }

    expect(await getNextProductNumber(ctx.db)).toBe("00000000051");
  });

  test("GET /api/products/next-sku and deprecated next-barcode return only sku", async () => {
    await resetProducts();

    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const nextSku = await request(ctx.app)
      .get("/api/products/next-sku")
      .set(authHeader(token));
    expect(nextSku.status).toBe(200);
    expect(nextSku.body.data?.sku ?? nextSku.body.sku).toBe("00000000001");
    expect(nextSku.body.data?.barcode ?? nextSku.body.barcode).toBeUndefined();

    const alias = await request(ctx.app)
      .get("/api/products/next-barcode")
      .set(authHeader(token));
    expect(alias.status).toBe(200);
    const body = alias.body.data ?? alias.body;
    expect(body.sku).toBe("00000000001");
    expect(body.barcode).toBeUndefined();
  });

  test("POST /api/products rejects missing barcode", async () => {
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        name: "Missing Barcode Product",
        price: 12,
        stock: 5,
        sku: "00000000002",
      });

    expect(res.status).toBe(400);
    const body = res.body.data ?? res.body;
    expect(body.error).toMatch(/باركود/);
  });

  test("POST /api/products rejects a short invalid barcode without creating a row", async () => {
    await resetProducts();
    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM products");
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "12",
        name: "Too Short",
        price: 12,
        stock: 5,
      });

    expect(res.status).toBe(400);
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM products");
    expect(after.c).toBe(before.c);
  });

  test("POST /api/products keeps scanned barcode and pads الرقم", async () => {
    await resetProducts();

    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "7290013586773",
        name: "Number And Barcode Product",
        price: 12,
        stock: 5,
        sku: "00000000002",
      });

    expect(res.status).toBe(201);
    const row = res.body.data ?? res.body;
    expect(row.barcode).toBe("7290013586773");
    expect(row.sku).toBe("00000000002");
  });

  test("POST /api/products assigns padded الرقم when sku omitted", async () => {
    await resetProducts();

    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "7290013586773",
        name: "Auto Number Product",
        price: 12,
        stock: 5,
      });

    expect(res.status).toBe(201);
    const row = res.body.data ?? res.body;
    expect(row.barcode).toBe("7290013586773");
    expect(row.sku).toBe("00000000001");
  });

  test("POST /api/products preserves a barcode that equals the رقم", async () => {
    await resetProducts();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "00000000007",
        name: "Coincident Barcode",
        price: 4,
        stock: 2,
        sku: "00000000007",
      });

    expect(res.status).toBe(201);
    const row = res.body.data ?? res.body;
    expect(row.barcode).toBe("00000000007");
    expect(row.sku).toBe("00000000007");
  });

  test("POST /api/products rejects a duplicate رقم", async () => {
    await resetProducts();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const first = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "1111222233",
        name: "First",
        price: 4,
        stock: 2,
        sku: "10",
      });
    expect(first.status).toBe(201);
    expect((first.body.data ?? first.body).sku).toBe("00000000010");

    const dup = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "1111222244",
        name: "Second",
        price: 4,
        stock: 2,
        sku: "00000000010",
      });
    expect(dup.status).toBe(409);
    expect((dup.body.data ?? dup.body).error).toMatch(/رقم المنتج/);
  });

  test("POST rolls back when products.barcode is already taken", async () => {
    await resetProducts();
    // Seed only products.barcode (no unit/alias rows) so the duplicate is
    // visible on the unique products.barcode column, not the unit tables.
    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('5555666677', 'Existing', 1, 1, 'Test', 1, '00000000001')`
    );
    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM products");
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .post("/api/products")
      .set(authHeader(token))
      .send({
        barcode: "5555666677",
        name: "Should Fail",
        price: 4,
        stock: 2,
        sku: "00000000002",
      });

    expect(res.status).toBe(409);
    expect((res.body.data ?? res.body).error).toMatch(/باركود/);
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM products");
    expect(after.c).toBe(before.c);
    const orphanUnits = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM product_units WHERE barcode = '5555666677'"
    );
    expect(orphanUnits.c).toBe(0);
    const names = await ctx.db.all("SELECT name FROM products");
    expect(names.map((r) => r.name)).toEqual(["Existing"]);
  });

  test("repair migration promotes a real unit barcode and clears the رقم-shaped default", async () => {
    await resetProducts();
    await ctx.db.run("DELETE FROM schema_migrations WHERE version = ?", [
      SKU_BARCODE_SEPARATION_VERSION,
    ]);

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('00000000001', 'ui', 5, 2.5, 'Test', 40, '1')`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '00000000001', 5, 2.5, 1, 1)`,
      [ins.lastID]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'صندوق', '1234567890', 20, 12.5, 5, 0)`,
      [ins.lastID]
    );
    await ctx.db.run(
      "INSERT INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, '00000000001', 'حبة', 1)",
      [ins.lastID]
    );

    const result = await migrateSkuBarcodeSeparation(ctx.db);
    expect(result.skipped).toBe(false);

    const product = await ctx.db.get("SELECT barcode, sku, needs_review FROM products WHERE id = ?", [
      ins.lastID,
    ]);
    expect(product.barcode).toBe("1234567890");
    expect(product.sku).toBe("00000000001");
    expect(Number(product.needs_review)).toBe(0);

    const piece = await ctx.db.get(
      "SELECT barcode FROM product_units WHERE product_id = ? AND unit_name = 'حبة'",
      [ins.lastID]
    );
    expect(piece.barcode).toBeNull();

    const box = await ctx.db.get(
      "SELECT barcode FROM product_units WHERE product_id = ? AND unit_name = 'صندوق'",
      [ins.lastID]
    );
    expect(box.barcode).toBe("1234567890");
  });

  test("repair migration flags a row when no distinct barcode exists", async () => {
    await resetProducts();
    await ctx.db.run("DELETE FROM schema_migrations WHERE version = ?", [
      SKU_BARCODE_SEPARATION_VERSION,
    ]);

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
       VALUES ('00000000008', 'Ambiguous', 5, 2, 'Test', 1, '8')`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '00000000008', 5, 2, 1, 1)`,
      [ins.lastID]
    );

    const result = await migrateSkuBarcodeSeparation(ctx.db);
    expect(result.skipped).toBe(false);
    const product = await ctx.db.get("SELECT barcode, sku, needs_review FROM products WHERE id = ?", [
      ins.lastID,
    ]);
    expect(product.barcode).toBe("00000000008");
    expect(product.sku).toBe("00000000008");
    expect(Number(product.needs_review)).toBe(1);
  });

  async function seedSkuOrderedProducts() {
    await resetProducts();

    const rows = [
      { sku: "00000000004", barcode: "12332122", name: "hgt" },
      { sku: "00000000001", barcode: "1234567890", name: "ui" },
      { sku: "00000000002", barcode: "1234567891", name: "ty" },
      { sku: "00000000003", barcode: "123456787", name: "tyt" },
    ];
    for (const row of rows) {
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
         VALUES (?, ?, 10, 5, 'Test', 1, ?)`,
        [row.barcode, row.name, row.sku]
      );
    }
  }

  test("GET /api/products returns items ordered by numeric sku", async () => {
    await seedSkuOrderedProducts();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .get("/api/products")
      .set(authHeader(token));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    const items = Array.isArray(body) ? body : body.items;
    expect(items.map((p) => p.sku)).toEqual([
      "00000000001",
      "00000000002",
      "00000000003",
      "00000000004",
    ]);
    expect(items[0].barcode_display).toBeUndefined();
  });

  test("GET /api/products?search=4 returns the product with الرقم 4", async () => {
    await seedSkuOrderedProducts();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .get("/api/products")
      .query({ search: "4" })
      .set(authHeader(token));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveLength(1);
    expect(body[0]?.sku).toBe("00000000004");
    expect(body[0]?.name).toBe("hgt");
  });

  test("GET /api/products?search=00000000004 returns the same product", async () => {
    await seedSkuOrderedProducts();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .get("/api/products")
      .query({ search: "00000000004" })
      .set(authHeader(token));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveLength(1);
    expect(body[0]?.sku).toBe("00000000004");
    expect(body[0]?.name).toBe("hgt");
  });
});
