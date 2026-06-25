import request from "supertest";
import XLSX from "xlsx";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  extractBarcodesFromText,
  findProductByBarcode,
  pickPrimaryBarcode,
} from "../utils/barcode.js";
import { normalizeProductRow } from "../utils/productImport.js";

const BRIJAT_PRODUCT_NAME = "عصير بريجات 500 ml مشكل";
const BRIJAT_UNIT_BARCODES = [
  "قnينة : 7290013586773",
  "قnينة : 7290001594391",
  "قnينة : 7290013586766",
  "قnينة : 7290013586780",
  "قnينة : 7290001594377",
  "قnينة : 7290001594384",
  "قnينة : 7290013586407",
].join("\n");

function buildBrijatRetailXlsxBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
    [1001, BRIJAT_PRODUCT_NAME, 7290013586773, BRIJAT_UNIT_BARCODES, 10.5],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const FEBRUARY_PRODUCT_NAME = "هدايا فبراير 6064";
const FEBRUARY_UNIT_BARCODE = "6223001858911";

function buildFebruaryRetailXlsxBuffer(primaryBarcode = "9800200498", productName = FEBRUARY_PRODUCT_NAME) {
  const unitBarcodes = [
    `علبة : ${primaryBarcode}`,
    "حبة : 6223001858942",
    "حبة : 6223001858911",
    "حبة : 6223001858935",
    "حبة : 6223001859291",
    "حبة : 6223001858904",
  ].join("\n");
  const sheet = XLSX.utils.aoa_to_sheet([
    ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
    [6064, productName, primaryBarcode, unitBarcodes, 15],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("Product barcodes", () => {
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

  test("extractBarcodesFromText parses multiple labeled barcodes", () => {
    const text = "علبة: 8693029607095 علبة: 8695504165090 علبة: 8693029607040";
    const barcodes = extractBarcodesFromText(text);
    expect(barcodes).toHaveLength(3);
    expect(barcodes.map((b) => b.barcode)).toEqual([
      "8693029607095",
      "8695504165090",
      "8693029607040",
    ]);
    expect(barcodes[0].label).toBe("علبة");
  });

  test("pickPrimaryBarcode prefers longest 8+ digit code", () => {
    const primary = pickPrimaryBarcode([
      { barcode: "123456" },
      { barcode: "8693029607095" },
    ]);
    expect(primary).toBe("8693029607095");
  });

  test("lookup resolves alternate barcode to same product", async () => {
    const primary = "8880011223344";
    const alt = "8880011223351";
    const create = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: primary,
        name: "Multi Barcode Juice",
        price: 5,
        stock: 10,
      });
    expect(create.status).toBe(201);
    const productId = create.body.data?.id ?? create.body.id;

    const addAlt = await request(ctx.app)
      .post(`/api/v1/products/${productId}/barcodes`)
      .set(authHeader(adminToken))
      .send({ barcode: alt, label: "علبة" });
    expect(addAlt.status).toBe(201);

    const altBody = addAlt.body.data ?? addAlt.body;
    const found = await findProductByBarcode(ctx.db, alt);
    expect(found).not.toBeNull();
    expect(found.product.id).toBe(productId);
    expect(found.productBarcodeId).toBe(altBody.id);

    const apiLookup = await request(ctx.app)
      .get(`/api/v1/products/${alt}`)
      .set(authHeader(cashierToken));
    expect(apiLookup.status).toBe(200);
    const lookupBody = apiLookup.body.data ?? apiLookup.body;
    expect(lookupBody.id).toBe(productId);
    expect(lookupBody.product_barcode_id).toBe(altBody.id);
    expect(lookupBody.scanned_barcode).toBe(alt);
  });

  test("checkout stores scanned_barcode on transaction_items", async () => {
    const bc = "7770011223344";
    const alt = "7770011223355";
    const create = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: bc,
        name: "Scan Test Product",
        price: 3.5,
        stock: 20,
      });
    expect(create.status).toBe(201);
    const productId = create.body.data?.id ?? create.body.id;

    const addAlt = await request(ctx.app)
      .post(`/api/v1/products/${productId}/barcodes`)
      .set(authHeader(adminToken))
      .send({ barcode: alt });
    expect(addAlt.status).toBe(201);
    const altBody = addAlt.body.data ?? addAlt.body;

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [
          {
            product_id: productId,
            quantity: 2,
            price: 3.5,
            scanned_barcode: alt,
            product_barcode_id: altBody.id,
          },
        ],
        payment_method: "cash",
      });
    expect(sale.status).toBe(201);

    const saleBody = sale.body.data ?? sale.body;
    const txId = saleBody.transaction_id;
    const line = await ctx.db.get(
      "SELECT * FROM transaction_items WHERE transaction_id = ? AND product_id = ?",
      [txId, productId]
    );
    expect(line.scanned_barcode).toBe(alt);
    expect(line.product_barcode_id).toBe(altBody.id);
    expect(line.barcode).toBe(bc);
  });

  test("normalizeProductRow extracts multiple barcodes from row cells", () => {
    const norm = normalizeProductRow({
      barcode: "8693029607095",
      name: "عصير مشكل",
      price: "12",
      _allCellsText:
        "علبة: 8693029607095 علبة: 8695504165090 علبة: 8693029607040 عصير مشكل 12",
    });
    expect(norm.ok).toBe(true);
    expect(norm.row.barcodes).toHaveLength(3);
    expect(norm.row.barcode).toBe("8693029607095");
  });

  test("retail Excel import: بريجات row attaches all barcodes and lookup works", async () => {
    const buffer = buildBrijatRetailXlsxBuffer();
    const upload = await request(ctx.app)
      .post("/api/v1/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buffer, {
        filename: "brijat.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(upload.status).toBe(200);
    const summary = upload.body.data ?? upload.body;
    expect((summary.products_created ?? 0) + (summary.products_updated ?? 0)).toBeGreaterThanOrEqual(
      1
    );
    expect(summary.barcodes_added).toBeGreaterThanOrEqual(7);

    const dbRow = await ctx.db.get(
      `SELECT p.id, p.name, pb.barcode, pb.label
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      ["7290013586766"]
    );
    expect(dbRow).not.toBeNull();
    expect(dbRow.name).toBe(BRIJAT_PRODUCT_NAME);

    const found = await findProductByBarcode(ctx.db, "7290013586766");
    expect(found).not.toBeNull();
    expect(found.product.name).toBe(BRIJAT_PRODUCT_NAME);

    const apiLookup = await request(ctx.app)
      .get("/api/v1/products/7290013586766")
      .set(authHeader(cashierToken));
    expect(apiLookup.status).toBe(200);
    const lookupBody = apiLookup.body.data ?? apiLookup.body;
    expect(lookupBody.name).toBe(BRIJAT_PRODUCT_NAME);
    expect(lookupBody.scanned_barcode).toBe("7290013586766");
    expect(lookupBody.product_barcode_id).toBeTruthy();
  });

  test("retail Excel import: هدايا فبراير unit barcode search and POS lookup", async () => {
    const buffer = buildFebruaryRetailXlsxBuffer();
    const upload = await request(ctx.app)
      .post("/api/v1/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buffer, {
        filename: "february-gifts.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(upload.status).toBe(200);
    const summary = upload.body.data ?? upload.body;
    expect((summary.products_created ?? 0) + (summary.products_updated ?? 0)).toBeGreaterThanOrEqual(
      1
    );
    expect(summary.barcodes_added).toBeGreaterThanOrEqual(6);

    const dbRow = await ctx.db.get(
      `SELECT p.id, p.name, p.barcode, pb.barcode AS alias_barcode, pb.label
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [FEBRUARY_UNIT_BARCODE]
    );
    expect(dbRow).not.toBeNull();
    expect(dbRow.name).toBe(FEBRUARY_PRODUCT_NAME);

    const searchRes = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: FEBRUARY_UNIT_BARCODE })
      .set(authHeader(adminToken));
    expect(searchRes.status).toBe(200);
    const searchRows = searchRes.body.data ?? searchRes.body;
    expect(Array.isArray(searchRows)).toBe(true);
    expect(searchRows.some((p) => p.name === FEBRUARY_PRODUCT_NAME)).toBe(true);

    const found = await findProductByBarcode(ctx.db, FEBRUARY_UNIT_BARCODE);
    expect(found).not.toBeNull();
    expect(found.product.name).toBe(FEBRUARY_PRODUCT_NAME);

    const apiLookup = await request(ctx.app)
      .get(`/api/v1/products/${FEBRUARY_UNIT_BARCODE}`)
      .set(authHeader(cashierToken));
    expect(apiLookup.status).toBe(200);
    const lookupBody = apiLookup.body.data ?? apiLookup.body;
    expect(lookupBody.name).toBe(FEBRUARY_PRODUCT_NAME);
    expect(lookupBody.scanned_barcode).toBe(FEBRUARY_UNIT_BARCODE);
    expect(lookupBody.product_barcode_id).toBeTruthy();

    const debugRes = await request(ctx.app)
      .get(`/api/v1/debug/barcode/${FEBRUARY_UNIT_BARCODE}`)
      .set(authHeader(adminToken));
    expect(debugRes.status).toBe(200);
    const debugBody = debugRes.body.data ?? debugRes.body;
    expect(debugBody.searchedBarcode).toBe(FEBRUARY_UNIT_BARCODE);
    expect(debugBody.foundInProductBarcodesTable.length).toBeGreaterThanOrEqual(1);
    expect(debugBody.finalProductResult.fromLookup?.name).toBe(FEBRUARY_PRODUCT_NAME);

    const cashierSearch = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: FEBRUARY_UNIT_BARCODE })
      .set(authHeader(cashierToken));
    expect(cashierSearch.status).toBe(200);
    const cashierRows = cashierSearch.body.data ?? cashierSearch.body;
    expect(cashierRows.some((p) => p.name === FEBRUARY_PRODUCT_NAME)).toBe(true);
  });

  test("retail Excel re-import updates product matched by products.barcode only", async () => {
    const primaryBarcode = "9800200599";
    const unitBarcode = "6223001858912";
    const productName = "هدايا إعادة استيراد 6064";
    const insert = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      [primaryBarcode, "هدايا قديمة", 12, 0, 0]
    );
    const productId = insert.lastID;
    await ctx.db.run("DELETE FROM product_barcodes WHERE product_id = ?", [productId]);

    const unitBarcodes = [`علبة : ${primaryBarcode}`, `حبة : ${unitBarcode}`].join("\n");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [6065, productName, primaryBarcode, unitBarcodes, 15],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const upload = await request(ctx.app)
      .post("/api/v1/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buffer, {
        filename: "february-reimport.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(upload.status).toBe(200);
    const summary = upload.body.data ?? upload.body;
    expect(summary.products_created ?? 0).toBe(0);
    expect(summary.products_updated ?? 0).toBeGreaterThanOrEqual(1);
    expect(summary.barcodes_added).toBeGreaterThanOrEqual(2);

    const updated = await ctx.db.get("SELECT id, name FROM products WHERE id = ?", [productId]);
    expect(updated.name).toBe(productName);

    const unitRow = await ctx.db.get(
      `SELECT pb.barcode FROM product_barcodes pb WHERE pb.product_id = ? AND pb.barcode = ?`,
      [productId, unitBarcode]
    );
    expect(unitRow).not.toBeNull();
  });

  test("import prefers primary barcode match and avoids UNIQUE crash", async () => {
    const ownerInsert = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      ["14010293", "منتج أساسي", 5, 0, 10]
    );
    const aliasInsert = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)`,
      ["7290008972161", "منتج بالاسم المستعار", 6, 0, 10]
    );
    await ctx.db.run(
      "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)",
      [aliasInsert.lastID, "7290008972161"]
    );

    const unitBarcodes = "علبة : 7290008972161\nحبة : 14010293\n";
    const sheet = XLSX.utils.aoa_to_sheet([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [9001, "صف محدّث", "14010293", unitBarcodes, 12],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const upload = await request(ctx.app)
      .post("/api/v1/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buffer, {
        filename: "primary-conflict.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(upload.status).toBe(200);
    const updated = await ctx.db.get("SELECT name FROM products WHERE id = ?", [ownerInsert.lastID]);
    expect(updated.name).toBe("صف محدّث");
    const alias = await ctx.db.get("SELECT barcode FROM products WHERE id = ?", [aliasInsert.lastID]);
    expect(alias.barcode).toBe("7290008972161");
  });
});
