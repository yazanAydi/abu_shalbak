import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  parseWeightBarcode,
  WEIGHT_BARCODE_PREFIX,
} from "../utils/barcode.js";
import { buildBarcodeLookupResponse } from "../utils/productUnitLookup.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { buildReceiptText } from "../utils/receipt.js";
import request from "supertest";

describe("weight-embedded scale barcodes", () => {
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

  test("parseWeightBarcode extracts product code and weight", () => {
    const parsed = parseWeightBarcode("2100003015504");
    expect(parsed).toEqual({
      productCode: "2100003",
      weightGrams: 1550,
      weightKg: 1.55,
    });
  });

  test("parseWeightBarcode rejects wrong prefix", () => {
    expect(parseWeightBarcode("2200003015504")).toBeNull();
  });

  test("parseWeightBarcode rejects non-13-digit codes", () => {
    expect(parseWeightBarcode("2100003")).toBeNull();
    expect(parseWeightBarcode("210000301550")).toBeNull();
  });

  test("WEIGHT_BARCODE_PREFIX is 21", () => {
    expect(WEIGHT_BARCODE_PREFIX).toBe("21");
  });

  test("exact 13-digit barcode starting with 21 wins over weight parsing", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, is_weighed) VALUES (?, ?, ?, ?, ?, ?)`,
      ["2100003999999", "منتج باركود كامل", 5, 2, 10, 0]
    );
    const productId = ins.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "2100003999999",
      price: 5,
      cost: 2,
      conversion_to_base: 1,
      is_default: true,
    });

    const payload = await buildBarcodeLookupResponse(ctx.db, "2100003999999");
    expect(payload).not.toBeNull();
    expect(payload.weighed).toBeUndefined();
    expect(payload.product.name).toBe("منتج باركود كامل");
  });

  test("weight barcode resolves weighed product with quantity", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, is_weighed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["2100003", "جبنة ميزان", 40, 20, 50, "كغم", 1]
    );
    const productId = ins.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "كغم",
      barcode: "2100003",
      price: 40,
      cost: 20,
      conversion_to_base: 1,
      is_default: true,
    });

    const payload = await buildBarcodeLookupResponse(ctx.db, "2100003015504");
    expect(payload).not.toBeNull();
    expect(payload.weighed).toBe(true);
    expect(payload.weight).toBe(1.55);
    expect(payload.quantity).toBe(1.55);
    expect(payload.price).toBe(40);
    expect(payload.product.is_weighed).toBe(true);
  });

  test("weight barcode ignored when product is not flagged weighed", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, is_weighed) VALUES (?, ?, ?, ?, ?, ?)`,
      ["2100004", "منتج عادي", 10, 5, 20, 0]
    );
    const productId = ins.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "2100004",
      price: 10,
      cost: 5,
      conversion_to_base: 1,
      is_default: true,
    });

    const payload = await buildBarcodeLookupResponse(ctx.db, "2100004015504");
    expect(payload).toBeNull();
  });

  test("by-barcode API returns weighed payload", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, is_weighed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["2100005", "لحم ميزان", 80, 50, 100, "كغم", 1]
    );
    const productId = ins.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "كغم",
      barcode: "2100005",
      price: 80,
      cost: 50,
      conversion_to_base: 1,
      is_default: true,
    });

    const res = await request(ctx.app)
      .get("/api/products/by-barcode/2100005020000")
      .set(authHeader(cashierToken));

    expect(res.status).toBe(200);
    expect(res.body.weighed).toBe(true);
    expect(res.body.weight).toBe(2);
    expect(res.body.quantity).toBe(2);
  });

  test("checkout accepts fractional weight quantity", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, is_weighed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["2100006", "دجاج ميزان", 30, 15, 100, "كغم", 1]
    );
    const productId = ins.lastID;
    const unit = await upsertProductUnit(ctx.db, productId, {
      unit_name: "كغم",
      barcode: "2100006",
      price: 30,
      cost: 15,
      conversion_to_base: 1,
      is_default: true,
    });

    const res = await request(ctx.app)
      .post("/api/checkout")
      .set(authHeader(cashierToken))
      .send({
        payment_method: "cash",
        items: [
          {
            product_id: productId,
            unit_id: unit.id,
            quantity: 1.25,
            price: 30,
            scanned_barcode: "2100006012500",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.total).toBeCloseTo(37.5, 2);

    const row = await ctx.db.get(
      "SELECT quantity, unit_name FROM transaction_items WHERE transaction_id = ?",
      [res.body.transaction_id]
    );
    expect(row.quantity).toBeCloseTo(1.25, 3);
    expect(row.unit_name).toBe("كغم");
  });

  test("receipt shows weight and price per kg for weighed lines", () => {
    const text = buildReceiptText({
      transactionId: 1,
      timestamp: "2026-07-05 12:00:00",
      cashierName: "test",
      lines: [
        {
          name: "جبنة (كغم)",
          quantity: 1.55,
          price: 40,
          lineTotal: 62,
          weighed: true,
        },
      ],
      subtotal: 62,
      tax: 0,
      total: 62,
      paymentMethod: "cash",
      settings: {},
    });

    expect(text).toContain("1.550");
    expect(text).toContain("40.00/kg");
  });
});
