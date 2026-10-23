import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { initDatabase } from "../database/init.js";

describe("refunds of a line-only free offer", () => {
  let ctx;
  let cashierToken;
  let filler;
  let shampoo;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({ opening_cash: 500 });
    filler = await addProduct("صنف السلة", "9920001", 170.46, "أخرى");
    shampoo = await addProduct("شامبو اختبار", "9920002", 25, "عناية");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function addProduct(name, barcode, price, category) {
    const product = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES (?, ?, ?, 1, ?, 100)`,
      [barcode, name, price, category]
    );
    const unit = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, ?, 1, 1, 1)`,
      [product.lastID, barcode, price]
    );
    return { productId: product.lastID, unitId: unit.lastID };
  }

  function basket() {
    return [
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1, price: 170.46 },
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 2, price: 25 },
    ];
  }

  async function sell() {
    await ctx.db.run("DELETE FROM promotions");
    invalidatePromotionsCache();
    await ctx.db.run(
      `INSERT INTO promotions (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('شامبو مجاني', 'percentage', ?, ?, 100, 1)`,
      [shampoo.productId, shampoo.unitId]
    );
    invalidatePromotionsCache();
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payments: [{ method: "cash", original_amount: 170 }],
        cash_tendered: 170,
        confirmed_total: 170,
        confirmed_discount: 50,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.discount).toBe(50);
    expect(sale.body.data.total).toBe(170);
    expect(sale.body.data.rounding_adjustment).toBe(-0.46);
    return sale.body.data.transaction_id;
  }

  async function refund(transactionId, lines) {
    const res = await request(ctx.app)
      .post("/api/v1/refunds")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines,
        reason: "اختبار",
        payment_method: "cash",
      });
    expect(res.status).toBe(201);
    return Number(res.body.data.refund.total);
  }

  test("returning the free shampoo pays nothing and the other item refunds the amount paid", async () => {
    const transactionId = await sell();
    const items = await ctx.db.all(
      "SELECT product_id, line_gross, line_net, discount_at_sale FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [transactionId]
    );
    expect(items.find((row) => row.product_id === shampoo.productId).line_gross).toBe(50);
    expect(items.find((row) => row.product_id === filler.productId).line_gross).toBe(170.46);

    const shampooBack = await refund(transactionId, [
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 2 },
    ]);
    expect(shampooBack).toBe(0);

    const fillerBack = await refund(transactionId, [
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1 },
    ]);
    expect(fillerBack).toBe(170);
  });

  test("partial returns cannot exceed the payable, and deleting the offer does not change them", async () => {
    const transactionId = await sell();
    await ctx.db.run("DELETE FROM promotions");
    invalidatePromotionsCache();

    const oneShampoo = await refund(transactionId, [
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 1 },
    ]);
    expect(oneShampoo).toBe(0);
    const otherShampoo = await refund(transactionId, [
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 1 },
    ]);
    expect(otherShampoo).toBe(0);
    const fillerBack = await refund(transactionId, [
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1 },
    ]);
    expect(fillerBack).toBe(170);

    const paid = await ctx.db.get(
      "SELECT COALESCE(SUM(total_amount), 0) AS paid FROM refund_requests WHERE transaction_id = ? AND status = 'pending'",
      [transactionId]
    );
    expect(Number(paid.paid)).toBe(170);
    const sale = await ctx.db.get(
      "SELECT total, discount, promo_breakdown_json FROM transactions WHERE id = ?",
      [transactionId]
    );
    expect(sale.total).toBe(170);
    expect(sale.discount).toBe(50);
    expect(JSON.parse(sale.promo_breakdown_json)[0].promotion_id).toBeTruthy();
  });

  test("a full return equals the original payable", async () => {
    const transactionId = await sell();
    const all = await refund(transactionId, [
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1 },
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 2 },
    ]);
    expect(all).toBe(170);
  });

  test("a sale without promo_breakdown_json still refunds from its saved line nets", async () => {
    await ctx.db.run("DELETE FROM promotions");
    invalidatePromotionsCache();
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: filler.productId, unit_id: filler.unitId, quantity: 1, price: 170.46 }],
        payment_method: "cash",
        confirmed_total: 170,
        confirmed_discount: 0,
      }));
    expect(sale.status).toBe(201);
    const transactionId = sale.body.data.transaction_id;
    await ctx.db.run("UPDATE transactions SET promo_breakdown_json = NULL WHERE id = ?", [transactionId]);
    const back = await refund(transactionId, [
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1 },
    ]);
    expect(back).toBe(170);
    const row = await ctx.db.get("SELECT promo_breakdown_json, total FROM transactions WHERE id = ?", [transactionId]);
    expect(row.promo_breakdown_json).toBeNull();
    expect(row.total).toBe(170);
  });
});

describe("deleted offer on a verified hold", () => {
  test("completion is refused with PROMO_LIMIT and no sale is written", async () => {
    const ctx = await createTestContext();
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const product = await ctx.db.get(
      "SELECT p.id, pu.id AS unit_id, pu.price FROM products p JOIN product_units pu ON pu.product_id = p.id WHERE p.id = ?",
      [ctx.productId]
    );
    await ctx.db.run(
      `INSERT INTO promotions (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('عرض يُحذف', 'percentage', ?, ?, 10, 1)`,
      [product.id, product.unit_id]
    );
    invalidatePromotionsCache();
    const held = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: product.id, unit_id: product.unit_id, quantity: 1, price: product.price }] });
    expect(held.status).toBe(201);
    expect(held.body.data.quote_verified).toBe(true);
    await ctx.db.run("DELETE FROM promotions WHERE name = 'عرض يُحذف'");
    invalidatePromotionsCache();
    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, unit_id: product.unit_id, quantity: 1, price: product.price }],
        payment_method: "cash",
        suspended_sale_id: held.body.data.id,
        confirmed_total: held.body.data.payable,
        confirmed_discount: held.body.data.discount,
      }));
    expect(sale.status).toBe(409);
    expect(sale.body.code).toBe("PROMO_LIMIT");
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    expect(after.c).toBe(before.c);
    const hold = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [held.body.data.id]);
    expect(hold.status).toBe("suspended");
    await destroyTestContext(ctx);
  });
});

describe("promo breakdown column on an existing database", () => {
  test("adding the column leaves saved totals unchanged", async () => {
    const ctx = await createTestContext();
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const product = await ctx.db.get("SELECT id, price FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
    const before = await ctx.db.get("SELECT id, subtotal, tax, total, discount FROM transactions WHERE id = ?", [
      sale.body.data.transaction_id,
    ]);
    await ctx.db.run("UPDATE transactions SET promo_breakdown_json = NULL WHERE id = ?", [before.id]);
    await initDatabase(ctx.dbPath);
    const after = await ctx.db.get(
      "SELECT id, subtotal, tax, total, discount, promo_breakdown_json FROM transactions WHERE id = ?",
      [before.id]
    );
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.tax).toBe(before.tax);
    expect(after.total).toBe(before.total);
    expect(after.discount).toBe(before.discount);
    expect(after.promo_breakdown_json).toBeNull();
    await destroyTestContext(ctx);
  });
});
