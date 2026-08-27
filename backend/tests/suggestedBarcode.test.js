import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  formatProductSku,
  getNextSuggestedBarcode,
  isSkuShapedBarcode,
  padSuggestedBarcode,
  parseShortNumericBarcode,
  pickDisplayBarcode,
} from "../utils/suggestedBarcode.js";

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

  test("pickDisplayBarcode hides الرقم when it was stored as barcode", () => {
    expect(isSkuShapedBarcode("00000000001", "00000000001")).toBe(true);
    expect(isSkuShapedBarcode("00000000001", "1")).toBe(true);
    expect(isSkuShapedBarcode("7290013586773", "00000000001")).toBe(false);
    expect(pickDisplayBarcode("00000000001", "00000000001", [])).toBe("");
    expect(pickDisplayBarcode("00000000001", "00000000001", ["1234567890"])).toBe("1234567890");
    expect(pickDisplayBarcode("7290013586773", "00000000001", [])).toBe("7290013586773");
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

  test("empty product tables suggest 00000000001", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000000001");
  });

  test("sequential short barcodes suggest next padded value", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    for (let i = 1; i <= 3; i += 1) {
      const code = padSuggestedBarcode(i);
      const ins = await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock)
         VALUES (?, ?, 10, 5, 'Test', 1)`,
        [code, `Product ${i}`]
      );
      await ctx.db.run(
        "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)",
        [ins.lastID, code]
      );
      await ctx.db.run(
        `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
         VALUES (?, 'حبة', ?, 10, 5, 1, 1)`,
        [ins.lastID, code]
      );
    }

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000000004");
  });

  test("after fifty sequential short barcodes suggests 00000000051", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    for (let i = 1; i <= 50; i += 1) {
      const code = padSuggestedBarcode(i);
      const ins = await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock)
         VALUES (?, ?, 10, 5, 'Test', 1)`,
        [code, `Product ${i}`]
      );
      await ctx.db.run(
        "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)",
        [ins.lastID, code]
      );
    }

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000000051");
  });

  test("considers barcodes from all barcode tables when computing next value", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('7290013586773', 'EAN primary', 10, 5, 'Test', 1)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '00000000002', 10, 5, 1, 1)`,
      [ins.lastID]
    );

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000000003");
  });

  test("EAN barcodes follow product count for the next suggestion", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('7290013586773', 'EAN Product', 10, 5, 'Test', 1)`
    );
    await ctx.db.run(
      "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, '7290013586773', 1)",
      [ins.lastID]
    );

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000000002");
  });

  test("many EAN products suggest next order number padded to 11 digits", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    for (let i = 1; i <= 4518; i += 1) {
      const ean = String(7290000000000 + i);
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
         VALUES (?, ?, 10, 5, 'Test', 1, ?)`,
        [ean, `Product ${i}`, String(i)]
      );
    }

    expect(await getNextSuggestedBarcode(ctx.db)).toBe("00000004519");
  });

  test("GET /api/products/next-barcode returns admin suggestion", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const token = loginRes.body.token;

    const res = await request(ctx.app)
      .get("/api/products/next-barcode")
      .set(authHeader(token));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.sku).toBe("00000000001");
    expect(body.barcode).toBe("00000000001");
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

  test("POST /api/products keeps scanned barcode and pads الرقم", async () => {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

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
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");
    await ctx.db.run("DELETE FROM entity_code_sequences WHERE entity_type = 'product'");

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

  async function seedSkuOrderedProducts() {
    await ctx.db.run("DELETE FROM product_unit_barcodes");
    await ctx.db.run("DELETE FROM product_units");
    await ctx.db.run("DELETE FROM product_barcodes");
    await ctx.db.run("DELETE FROM products");

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
