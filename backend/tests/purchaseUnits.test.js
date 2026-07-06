import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import request from "supertest";

describe("multi-unit purchasing", () => {
  let ctx;
  let adminToken;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    const sup = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('Test Supplier')");
    supplierId = sup.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createInvoiceAndPost(items) {
    const create = await request(ctx.app)
      .post("/api/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, items });
    expect(create.status).toBe(201);
    const invoiceId = create.body.id;
    const post = await request(ctx.app)
      .post(`/api/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    return invoiceId;
  }

  test("purchasing 3 boxes adds 72 base units and snapshots the conversion", async () => {
    const p = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7100000001", "بيبسي", 1, 1, "مشروبات"]
    );
    const productId = p.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "علبة",
      barcode: "7100000001",
      price: 1,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "صندوق",
      barcode: "7100000024",
      price: 24,
      cost: 24,
      conversion_to_base: 24,
      is_default: false,
    });
    const box = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND barcode = '7100000024'",
      [productId]
    );

    const invoiceId = await createInvoiceAndPost([
      { product_id: productId, unit_id: box.id, quantity: 3, total_cost: 72 },
    ]);

    const after = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [productId]);
    expect(Number(after.stock)).toBe(72);
    // per-base cost = 72 / 72 = 1
    expect(Number(after.cost)).toBeCloseTo(1, 6);

    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?",
      [invoiceId, productId]
    );
    expect(Number(line.quantity)).toBe(3);
    expect(Number(line.conversion_used)).toBe(24);
    expect(Number(line.base_quantity)).toBe(72);
    expect(Number(line.product_unit_id)).toBe(Number(box.id));
    expect(line.unit_name).toBe("صندوق");
  });

  test("weighted-average cost uses per-base unit cost across mixed unit purchases", async () => {
    const p = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7200000001", "كولا", 1, 0, "مشروبات"]
    );
    const productId = p.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "علبة",
      barcode: "7200000001",
      price: 1,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "صندوق",
      barcode: "7200000024",
      price: 24,
      cost: 24,
      conversion_to_base: 24,
      is_default: false,
    });
    const box = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND barcode = '7200000024'",
      [productId]
    );

    // Buy 3 boxes @ total 72 -> 72 base units, base cost 1.
    await createInvoiceAndPost([
      { product_id: productId, unit_id: box.id, quantity: 3, total_cost: 72 },
    ]);
    // Buy 1 box @ total 48 -> 24 base units, base cost 2.
    await createInvoiceAndPost([
      { product_id: productId, unit_id: box.id, quantity: 1, total_cost: 48 },
    ]);

    const after = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [productId]);
    expect(Number(after.stock)).toBe(96);
    // (72*1 + 24*2) / 96 = 120 / 96 = 1.25
    expect(Number(after.cost)).toBeCloseTo(1.25, 2);
  });

  test("legacy line without unit_id falls back to the default unit (conversion 1)", async () => {
    const p = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 10)`,
      ["7300000001", "ماء", 1, 1, "مشروبات"]
    );
    const productId = p.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "7300000001",
      price: 1,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });

    const invoiceId = await createInvoiceAndPost([
      { product_id: productId, quantity: 5, total_cost: 25 },
    ]);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    expect(Number(after.stock)).toBe(15);

    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?",
      [invoiceId, productId]
    );
    expect(Number(line.conversion_used)).toBe(1);
    expect(Number(line.base_quantity)).toBe(5);
  });

  test("purchase line without unit_id resolves to the purchase-default unit, not the sales default", async () => {
    const p = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7400000001", "عصير", 1, 1, "مشروبات"]
    );
    const productId = p.lastID;
    // Sales default = piece (conversion 1)
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "7400000001",
      price: 1,
      cost: 1,
      conversion_to_base: 1,
      is_default: true,
    });
    // Purchase default = box (conversion 13)
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "صندوق",
      barcode: "7400000013",
      price: 13,
      cost: 13,
      conversion_to_base: 13,
      is_default: false,
      is_default_purchase: true,
    });

    // No unit_id sent -> should resolve to box (13), so 2 x 13 = 26 base units.
    const invoiceId = await createInvoiceAndPost([
      { product_id: productId, quantity: 2, total_cost: 26 },
    ]);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    expect(Number(after.stock)).toBe(26);

    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?",
      [invoiceId, productId]
    );
    expect(Number(line.conversion_used)).toBe(13);
    expect(line.unit_name).toBe("صندوق");
  });
});

describe("product unit default-purchase flag and barcode hardening", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("setting is_default_purchase on one unit clears it on siblings", async () => {
    const p = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7500000001", "شاي", 1, 1, "مشروبات"]
    );
    const productId = p.lastID;
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "7500000001",
      conversion_to_base: 1,
      is_default: true,
      is_default_purchase: true,
    });
    await upsertProductUnit(ctx.db, productId, {
      unit_name: "صندوق",
      barcode: "7500000010",
      conversion_to_base: 10,
      is_default_purchase: true,
    });

    const units = await ctx.db.all(
      "SELECT unit_name, is_default_purchase FROM product_units WHERE product_id = ?",
      [productId]
    );
    const flagged = units.filter((u) => Number(u.is_default_purchase) === 1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].unit_name).toBe("صندوق");
  });

  test("upsertProductUnit rejects a barcode owned by another product's product_barcodes with 409", async () => {
    const other = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7600000001", "منتج آخر", 1, 1, "عام"]
    );
    await ctx.db.run(
      `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)`,
      [other.lastID, "7600000099"]
    );

    const target = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, ?, ?, 0)`,
      ["7600000002", "منتج الهدف", 1, 1, "عام"]
    );

    await expect(
      upsertProductUnit(ctx.db, target.lastID, {
        unit_name: "صندوق",
        barcode: "7600000099",
        conversion_to_base: 6,
      })
    ).rejects.toMatchObject({ status: 409 });
  });
});
