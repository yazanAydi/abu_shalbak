import request from "supertest";
import { computeCartDiscount, getActivePromotions } from "../utils/promotions.js";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

describe("promotions: units, multi_price, end conditions", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function insertPromo(fields) {
    const ins = await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, buy_qty, get_qty,
          limit_qty, used_qty, stop_when_out_of_stock, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        fields.name,
        fields.offer_type,
        fields.product_id,
        fields.product_unit_id ?? null,
        fields.discount_value ?? 0,
        fields.buy_qty ?? 0,
        fields.get_qty ?? 0,
        fields.limit_qty ?? 0,
        fields.used_qty ?? 0,
        fields.stop_when_out_of_stock ? 1 : 0,
      ]
    );
    return { ...fields, id: ins.lastID };
  }

  test("multi_price applies group discount with remainder at normal price", () => {
    const promo = {
      id: 1,
      name: "2 for 10",
      offer_type: "multi_price",
      product_id: 1,
      discount_value: 10,
      buy_qty: 2,
    };
    const lines = [{ product_id: 1, quantity: 5, unitPrice: 8 }];
    const result = computeCartDiscount([promo], lines);
    // 2 groups: each saves 8*2-10=6, total discount 12
    expect(result.discount).toBe(12);
    expect(result.breakdown[0].units_used).toBe(4);
  });

  test("unit-specific promo matches only its unit lines", () => {
    const promo = {
      id: 2,
      name: "Box deal",
      offer_type: "percentage",
      product_id: 1,
      product_unit_id: 10,
      discount_value: 10,
    };
    const lines = [
      { product_id: 1, product_unit_id: 10, quantity: 2, unitPrice: 20 },
      { product_id: 1, product_unit_id: 11, quantity: 2, unitPrice: 20 },
    ];
    const result = computeCartDiscount([promo], lines);
    expect(result.discount).toBe(4);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].product_unit_id).toBe(10);
  });

  test("null-unit promo applies to all units of the product", () => {
    const promo = {
      id: 3,
      name: "All units",
      offer_type: "fixed",
      product_id: 1,
      discount_value: 1,
    };
    const lines = [
      { product_id: 1, product_unit_id: 10, quantity: 1, unitPrice: 10 },
      { product_id: 1, product_unit_id: 11, quantity: 1, unitPrice: 10 },
    ];
    const result = computeCartDiscount([promo], lines);
    expect(result.discount).toBe(2);
    expect(result.breakdown).toHaveLength(2);
  });

  test("quantity limit caps discount near quota", () => {
    const promo = {
      id: 4,
      name: "Limited 2-for-10",
      offer_type: "multi_price",
      product_id: 1,
      discount_value: 10,
      buy_qty: 2,
      limit_qty: 10,
      used_qty: 8,
    };
    const lines = [{ product_id: 1, quantity: 4, unitPrice: 8 }];
    const result = computeCartDiscount([promo], lines);
    // remaining=2 => only 1 group (2 units), discount 6
    expect(result.discount).toBe(6);
    expect(result.breakdown[0].units_used).toBe(2);
  });

  test("quantity limit excludes promo once exhausted", () => {
    const promo = {
      id: 5,
      name: "Exhausted",
      offer_type: "percentage",
      product_id: 1,
      discount_value: 50,
      limit_qty: 5,
      used_qty: 5,
    };
    const lines = [{ product_id: 1, quantity: 2, unitPrice: 10 }];
    const result = computeCartDiscount([promo], lines);
    expect(result.discount).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });

  test("getActivePromotions excludes exhausted and out-of-stock promos", async () => {
    const product = await ctx.db.get("SELECT id FROM products WHERE id = ?", [ctx.productId]);

    await insertPromo({
      name: "Exhausted active",
      offer_type: "percentage",
      product_id: product.id,
      discount_value: 10,
      limit_qty: 2,
      used_qty: 2,
    });

    await insertPromo({
      name: "Out of stock",
      offer_type: "percentage",
      product_id: product.id,
      discount_value: 10,
      stop_when_out_of_stock: true,
    });

    await ctx.db.run("UPDATE products SET stock = 0 WHERE id = ?", [product.id]);

    const active = await getActivePromotions(ctx.db);
    const names = active.map((p) => p.name);
    expect(names).not.toContain("Exhausted active");
    expect(names).not.toContain("Out of stock");

    await ctx.db.run("UPDATE products SET stock = 100 WHERE id = ?", [product.id]);
  });

  test("POST promotion rejects product without product_unit_id", async () => {
    const res = await request(ctx.app)
      .post("/api/marketing/promotions")
      .set(authHeader(adminToken))
      .send({
        name: "Missing unit",
        offer_type: "percentage",
        product_id: ctx.productId,
        discount_value: 10,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("حدّد وحدة المنتج");
  });

  test("POST promotion accepts product with product_unit_id", async () => {
    const unit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? LIMIT 1",
      [ctx.productId]
    );
    const res = await request(ctx.app)
      .post("/api/marketing/promotions")
      .set(authHeader(adminToken))
      .send({
        name: "With unit",
        offer_type: "percentage",
        product_id: ctx.productId,
        product_unit_id: unit.id,
        discount_value: 10,
      });
    expect(res.status).toBe(201);
    expect(res.body.product_unit_id).toBe(unit.id);
  });

  test("prefers multi_price over bundle when both match the same line", () => {
    const bundle = {
      id: 10,
      name: "Bundle off 15",
      offer_type: "bundle",
      product_id: 1,
      product_unit_id: 10,
      discount_value: 15,
      buy_qty: 2,
    };
    const multiPrice = {
      id: 11,
      name: "2 for 15",
      offer_type: "multi_price",
      product_id: 1,
      product_unit_id: 10,
      discount_value: 15,
      buy_qty: 2,
    };
    const lines = [{ product_id: 1, product_unit_id: 10, quantity: 2, unitPrice: 10 }];
    const result = computeCartDiscount([bundle, multiPrice], lines);
    expect(result.discount).toBe(5);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].promotion_id).toBe(11);
  });

  test("POST promotion deactivates conflicting active promos for same product unit", async () => {
    const unit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? LIMIT 1",
      [ctx.productId]
    );
    const old = await insertPromo({
      name: "Old bundle",
      offer_type: "bundle",
      product_id: ctx.productId,
      product_unit_id: unit.id,
      discount_value: 15,
      buy_qty: 2,
    });
    const res = await request(ctx.app)
      .post("/api/marketing/promotions")
      .set(authHeader(adminToken))
      .send({
        name: "New multi price",
        offer_type: "multi_price",
        product_id: ctx.productId,
        product_unit_id: unit.id,
        discount_value: 15,
        buy_qty: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.deactivated_sibling_count).toBeGreaterThanOrEqual(1);
    const oldRow = await ctx.db.get("SELECT active FROM promotions WHERE id = ?", [old.id]);
    expect(oldRow.active).toBe(0);
    const activeSiblings = await ctx.db.all(
      "SELECT id FROM promotions WHERE product_id = ? AND product_unit_id = ? AND active = 1",
      [ctx.productId, unit.id]
    );
    expect(activeSiblings).toHaveLength(1);
    expect(activeSiblings[0].id).toBe(res.body.id);
  });
});
