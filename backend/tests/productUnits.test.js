import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  normalizeUnitName,
  looksLikePackOnlyProduct,
} from "../utils/unitNames.js";
import {
  parseUnitBarcodeLines,
  parsePrice,
} from "../utils/barcode.js";
import { buildBarcodeLookupResponse } from "../utils/productUnitLookup.js";
import { repairProductUnitPrices, upsertProductUnit } from "../utils/productUnits.js";
import { buildSourceRowIndex, resolveUnitPrice } from "../utils/importPriceResolver.js";
import request from "supertest";
import XLSX from "xlsx";

describe("product units", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("normalizeUnitName aliases", () => {
    expect(normalizeUnitName("قنية")).toBe("قنينة");
    expect(normalizeUnitName("علبه")).toBe("علبة");
    expect(normalizeUnitName("ريطة")).toBe("ربطة");
  });

  test("parseUnitBarcodeLines supports multiple barcodes per line", () => {
    const lines = parseUnitBarcodeLines("قنينة : 6253501790077 6253501790088\nصندوق : 6253501790244");
    expect(lines).toHaveLength(2);
    expect(lines[0].barcodes).toEqual(["6253501790077", "6253501790088"]);
    expect(lines[1].unitName).toContain("صند");
  });

  test("parsePrice strips شبقل", () => {
    expect(parsePrice("2 شبقل")).toBe(2);
    expect(parsePrice("13 شبقل")).toBe(13);
  });

  test("looksLikePackOnlyProduct", () => {
    expect(looksLikePackOnlyProduct("صندوق ماء نستله")).toBe(true);
    expect(looksLikePackOnlyProduct("مياه نستلة")).toBe(false);
  });

  test("by-barcode returns selected unit and available units", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      ["9000000000001", "مياه وحدة اختبار", 2, 1, 100]
    );
    const productId = ins.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "قنينة",
      barcode: "9000000000001",
      price: 2,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "صندوق",
      barcode: "9000000000002",
      price: 13,
      cost: 10,
      conversion_to_base: 12,
      is_default: false,
    });

    const res = await request(ctx.app)
      .get("/api/products/by-barcode/9000000000002")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.selectedUnit.unit_name).toBe("صندوق");
    expect(res.body.selectedUnit.price).toBe(13);
    expect(res.body.availableUnits.length).toBe(2);
    const prices = res.body.availableUnits.map((u) => u.price).sort((a, b) => a - b);
    expect(prices).toEqual([2, 13]);
  });

  test("checkout rejects wrong unit price from frontend", async () => {
    const product = await ctx.db.get("SELECT id FROM products WHERE barcode = ?", ["9000000000001"]);
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE barcode = ?", ["9000000000002"]);

    const checkout = await request(ctx.app)
      .post("/api/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [
          {
            product_id: product.id,
            unit_id: unit.id,
            quantity: 1,
            price: 3,
          },
        ],
        payment_method: "cash",
        idempotency_key: `unit-mismatch-${Date.now()}`,
      });
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe("PRICE_MISMATCH");
  });

  test("checkout deducts stock using conversion_to_base", async () => {
    const product = await ctx.db.get("SELECT id, stock FROM products WHERE barcode = ?", [
      "9000000000001",
    ]);
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE barcode = ?", [
      "9000000000002",
    ]);
    const beforeStock = Number(product.stock);

    const checkout = await request(ctx.app)
      .post("/api/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [
          {
            product_id: product.id,
            unit_id: unit.id,
            quantity: 1,
            price: 13,
          },
        ],
        payment_method: "cash",
        idempotency_key: `unit-test-${Date.now()}`,
      });
    expect(checkout.status).toBe(201);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
    expect(Number(after.stock)).toBe(beforeStock - 12);
  });
});

function buildJerusalemWaterXlsxBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["الاسم", "التكلفة", "باركود", "الرصيد الحالي", "التصنيف", "باركود الوحدات", "مفرق"],
    [
      "مياه القدس 1.5 لتر",
      1,
      "000010651",
      50,
      "مشروبات",
      "صندوق : 10652\nحبة : 000010651",
      "3 شبقل",
    ],
    ["صندوق مياه القدس 200ml", 5, "10652", 10, "مشروبات", "", "13 شبقل"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function buildNestleXlsxBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["الاسم", "التكلفة", "باركود", "الرصيد الحالي", "التصنيف", "باركود الوحدات", "مفرق"],
    [
      "مياه نستلة صغير 500 مل",
      1,
      "6253501790077",
      50,
      "مشروبات",
      "قنية : 6253501790077\nصندوق : 6253501790244",
      "2 شبقل",
    ],
    ["صندوق ماء نستله 500 مل", 10, "6253501790244", 5, "مشروبات", "", "13 شبقل"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("product units import", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("imports linked bottle and box units with separate prices", async () => {
    const buf = buildNestleXlsxBuffer();
    const res = await request(ctx.app)
      .post("/api/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buf, "nestle-units.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const units = await ctx.db.all(
      "SELECT unit_name, barcode, price FROM product_units WHERE barcode IN ('6253501790077', '6253501790244')"
    );
    const boxUnit = units.find((u) => u.barcode === "6253501790244");
    expect(boxUnit?.price).toBe(13);

    const bottle = await buildBarcodeLookupResponse(ctx.db, "6253501790077");
    const box = await buildBarcodeLookupResponse(ctx.db, "6253501790244");
    expect(bottle).toBeTruthy();
    expect(box).toBeTruthy();
    expect(bottle.product.id).toBe(box.product.id);
    expect(bottle.selectedUnit.price).toBe(2);
    expect(box.selectedUnit.price).toBe(13);
    const bottlePrices = bottle.availableUnits.map((u) => u.price).sort((a, b) => a - b);
    expect(bottlePrices).toEqual([2, 13]);
  });

  test("resolveUnitPrice prefers pack row when unit line appears before pack row in file", () => {
    const validRows = [
      {
        rowNum: 2,
        row: {
          name: "مياه القدس 1.5 لتر",
          barcode: "000010651",
          price: 3,
          cost: 1,
          stock: 10,
          category: "مشروبات",
          _rawUnitBarcodes: "صندوق : 10652\nحبة : 000010651",
        },
      },
      {
        rowNum: 3,
        row: {
          name: "صندوق مياه القدس 200ml",
          barcode: "10652",
          price: 13,
          cost: 5,
          stock: 5,
          category: "مشروبات",
        },
      },
    ];
    const sourceIndex = buildSourceRowIndex(validRows);
    const resolved = resolveUnitPrice({
      unitBarcode: "10652",
      currentRowNum: 2,
      currentRowPrimary: "000010651",
      currentRowPrice: 3,
      sourceIndex,
    });
    expect(resolved.price).toBe(13);
    expect(resolved.source).toBe("matched_barcode_row");
  });

  test("imports Jerusalem water with distinct unit prices in POS lookup", async () => {
    const buf = buildJerusalemWaterXlsxBuffer();
    const res = await request(ctx.app)
      .post("/api/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buf, "jerusalem-water.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const units = await ctx.db.all(
      "SELECT unit_name, barcode, price FROM product_units WHERE barcode IN ('000010651', '10652')"
    );
    const pieceUnit = units.find((u) => u.barcode === "000010651");
    const boxUnit = units.find((u) => u.barcode === "10652");
    expect(pieceUnit?.price).toBe(3);
    expect(boxUnit?.price).toBe(13);

    const lookup = await buildBarcodeLookupResponse(ctx.db, "000010651");
    expect(lookup).toBeTruthy();
    expect(lookup.availableUnits.length).toBeGreaterThanOrEqual(2);
    const unitPrices = lookup.availableUnits.map((u) => u.price).sort((a, b) => a - b);
    expect(unitPrices).toContain(3);
    expect(unitPrices).toContain(13);
    expect(new Set(unitPrices).size).toBeGreaterThanOrEqual(2);
  });
});

describe("product unit price repair", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("repairProductUnitPrices fixes equalized unit prices from product rows", async () => {
    const bottle = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      ["000010651", "مياه القدس 1.5 لتر", 3, 1, 50]
    );
    const boxProduct = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      ["10652", "صندوق مياه القدس 200ml", 13, 5, 10]
    );
    const productId = bottle.lastID;

    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [productId, "حبة", "000010651", 3, 1]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [productId, "صندوق", "10652", 3, 1]
    );

    const result = await repairProductUnitPrices(ctx.db);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const boxUnit = await ctx.db.get(
      "SELECT price, needs_review FROM product_units WHERE product_id = ? AND barcode = ?",
      [productId, "10652"]
    );
    expect(Number(boxUnit.price)).toBe(13);
    expect(Number(boxUnit.needs_review)).toBe(0);

    expect(boxProduct.lastID).toBeGreaterThan(0);
  });
});
