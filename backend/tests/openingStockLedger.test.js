import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { persistProductImportRows } from "../utils/productUnitsImport.js";

describe("Opening / import stock goes through the ledger", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("create with stock 5 inserts 0 then ledgers +5", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800770001",
        name: "افتتاح موجب",
        price: 4,
        stock: 5,
        unit: "حبة",
      });
    expect(res.status).toBe(201);
    const id = (res.body.data ?? res.body).id;
    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [id]);
    expect(Number(product.stock)).toBe(5);
    const ledger = await ctx.db.all(
      "SELECT quantity_delta, qty_before, qty_after FROM inventory_ledger WHERE product_id = ? ORDER BY id",
      [id]
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].quantity_delta)).toBe(5);
    expect(Number(ledger[0].qty_before)).toBe(0);
    expect(Number(ledger[0].qty_after)).toBe(5);
  });

  test("create with negative stock ledgers the negative delta", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800770002",
        name: "افتتاح سالب",
        price: 4,
        stock: -3,
        unit: "حبة",
      });
    expect(res.status).toBe(201);
    const id = (res.body.data ?? res.body).id;
    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [id]);
    expect(Number(product.stock)).toBe(-3);
    const ledger = await ctx.db.get(
      "SELECT quantity_delta, qty_after FROM inventory_ledger WHERE product_id = ?",
      [id]
    );
    expect(Number(ledger.quantity_delta)).toBe(-3);
    expect(Number(ledger.qty_after)).toBe(-3);
  });

  test("create with stock 0 writes no ledger row", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800770003",
        name: "افتتاح صفر",
        price: 4,
        stock: 0,
        unit: "حبة",
      });
    expect(res.status).toBe(201);
    const id = (res.body.data ?? res.body).id;
    const n = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ?",
      [id]
    );
    expect(n.c).toBe(0);
  });

  test("import update applies next-current via ledger including negative delta", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "8800770004",
        name: "استيراد رصيد",
        price: 4,
        stock: 10,
        unit: "حبة",
      });
    const id = (created.body.data ?? created.body).id;

    await persistProductImportRows(ctx.db, [
      {
        rowNum: 1,
        row: {
          barcode: "8800770004",
          barcodes: [{ barcode: "8800770004", is_primary: true }],
          name: "استيراد رصيد",
          price: 4,
          cost: 1,
          stock: 4,
          unit: "حبة",
        },
      },
    ]);
    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [id]);
    expect(Number(after.stock)).toBe(4);
    const ledger = await ctx.db.all(
      "SELECT quantity_delta, qty_after FROM inventory_ledger WHERE product_id = ? ORDER BY id",
      [id]
    );
    expect(ledger).toHaveLength(2);
    expect(Number(ledger[1].quantity_delta)).toBe(-6);
    expect(Number(ledger[1].qty_after)).toBe(4);

    await persistProductImportRows(ctx.db, [
      {
        rowNum: 2,
        row: {
          barcode: "8800770004",
          barcodes: [{ barcode: "8800770004", is_primary: true }],
          name: "استيراد رصيد",
          price: 4,
          cost: 1,
          stock: 4,
          unit: "حبة",
        },
      },
    ]);
    const again = await ctx.db.all(
      "SELECT id FROM inventory_ledger WHERE product_id = ?",
      [id]
    );
    expect(again).toHaveLength(2);
  });
});
