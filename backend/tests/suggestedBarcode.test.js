import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  getNextSuggestedBarcode,
  padSuggestedBarcode,
  parseShortNumericBarcode,
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
    expect(res.body.barcode).toBe("00000000001");
  });

  test("POST /api/products assigns suggested barcode when omitted", async () => {
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
        name: "Auto Barcode Product",
        price: 12,
        stock: 5,
      });

    expect(res.status).toBe(201);
    expect(res.body.barcode).toBe("00000000001");
  });
});
