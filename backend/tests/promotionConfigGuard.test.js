import request from "supertest";
import { computeCartDiscount } from "../utils/promotions.js";
import { roundPosPayable } from "../utils/money.js";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";

const filler = { product_id: 1, product_unit_id: 1, category: "أخرى", quantity: 1, unitPrice: 170.46 };
const shampoo = { product_id: 2, product_unit_id: 2, category: "عناية", quantity: 2, unitPrice: 25 };

function percentPromo(value) {
  return {
    id: 9,
    name: "نسبة الشامبو",
    offer_type: "percentage",
    product_id: 2,
    product_unit_id: 2,
    discount_value: value,
  };
}

describe("promotion percentage scope", () => {
  test("100% frees only the eligible line", () => {
    const priced = computeCartDiscount([percentPromo(100)], [filler, shampoo]);
    expect(priced.invalidOffers).toEqual([]);
    expect(priced.discount).toBe(50);
    expect(priced.breakdown).toHaveLength(1);
    expect(priced.breakdown[0].product_id).toBe(2);
    expect(roundPosPayable(220.46 - priced.discount).payable).toBe(170);
  });

  test("101% and 999% are invalid and do not discount unrelated lines", () => {
    for (const value of [101, 999]) {
      const priced = computeCartDiscount([percentPromo(value)], [filler, shampoo]);
      expect(priced.discount).toBe(0);
      expect(priced.breakdown).toEqual([]);
      expect(priced.invalidOffers).toHaveLength(1);
      expect(priced.invalidOffers[0].discount_value).toBe(value);
    }
  });
});

describe("promotion configuration and confirmed checkout", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let fillerProduct;
  let shampooProduct;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(shift.status).toBe(201);
    fillerProduct = await addProduct("صنف السلة", "9910001", 170.46, "أخرى");
    shampooProduct = await addProduct("شامبو اختبار", "9910002", 25, "عناية");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.db.run("DELETE FROM promotions");
    invalidatePromotionsCache();
  });

  async function addProduct(name, barcode, price, category) {
    const product = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES (?, ?, ?, 1, ?, 100)`,
      [barcode, name, price, category]
    );
    const unit = await ctx.db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, ?, 1, 1, 1)`,
      [product.lastID, barcode, price]
    );
    return { productId: product.lastID, unitId: unit.lastID, price };
  }

  function basket() {
    return [
      { product_id: fillerProduct.productId, unit_id: fillerProduct.unitId, quantity: 1, price: 170.46 },
      { product_id: shampooProduct.productId, unit_id: shampooProduct.unitId, quantity: 2, price: 25 },
    ];
  }

  async function quote() {
    const res = await request(ctx.app)
      .post("/api/v1/checkout/quote")
      .set(authHeader(cashierToken))
      .send({ items: basket() });
    return res;
  }

  test("office rejects percentages outside 0 to 100 and accepts 100", async () => {
    const unitId = shampooProduct.unitId;
    const base = {
      name: "نسبة",
      offer_type: "percentage",
      product_id: shampooProduct.productId,
      product_unit_id: unitId,
    };
    const tooHigh = await request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send({ ...base, discount_value: 101 });
    expect(tooHigh.status).toBe(400);
    const huge = await request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send({ ...base, name: "ضخمة", discount_value: 999 });
    expect(huge.status).toBe(400);
    const ok = await request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send({ ...base, name: "مئة", discount_value: 100 });
    expect(ok.status).toBe(201);
  });

  test("an already stored invalid percentage does not charge the basket", async () => {
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('نسبة تالفة', 'percentage', ?, ?, 999, 1)`,
      [shampooProduct.productId, shampooProduct.unitId]
    );
    invalidatePromotionsCache();
    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ items: basket(), payment_method: "cash" }));
    expect(sale.status).toBe(409);
    expect(sale.body.code).toBe("PROMO_CONFIG_INVALID");
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    expect(after.c).toBe(before.c);
    const row = await ctx.db.get("SELECT discount_value FROM promotions WHERE name = 'نسبة تالفة'");
    expect(row.discount_value).toBe(999);
  });

  test("no offer quotes 220 and a confirmed 2-for-40 sale stores the offer breakdown", async () => {
    const plain = await quote();
    expect(plain.status).toBe(200);
    expect(plain.body.data.discount).toBe(0);
    expect(plain.body.data.total).toBe(220);

    const created = await request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send({
        name: "2 بـ 40",
        offer_type: "multi_price",
        product_id: shampooProduct.productId,
        product_unit_id: shampooProduct.unitId,
        discount_value: 40,
        buy_qty: 2,
      });
    expect(created.status).toBe(201);
    const priced = await quote();
    expect(priced.body.data.discount).toBe(10);
    expect(priced.body.data.total).toBe(210);

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payment_method: "cash",
        confirmed_total: priced.body.data.total,
        confirmed_discount: priced.body.data.discount,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(210);
    const saved = await ctx.db.get(
      "SELECT promo_breakdown_json FROM transactions WHERE id = ?",
      [sale.body.data.transaction_id]
    );
    const breakdown = JSON.parse(saved.promo_breakdown_json);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].offer_type).toBe("multi_price");
    expect(breakdown[0].discount_value).toBe(40);
    expect(breakdown[0].discount).toBe(10);
    expect(breakdown[0].product_unit_id).toBe(shampooProduct.unitId);
    expect(breakdown[0].quantity).toBe(2);
  });

  test("a price change between quote and checkout writes nothing until the new amount is confirmed", async () => {
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('خصم الشامبو', 'fixed', ?, ?, 50, 1)`,
      [shampooProduct.productId, shampooProduct.unitId]
    );
    invalidatePromotionsCache();
    const first = await quote();
    expect(first.body.data.discount).toBe(50);
    expect(first.body.data.total).toBe(170);
    await ctx.db.run("UPDATE promotions SET active = 0 WHERE name = 'خصم الشامبو'");
    invalidatePromotionsCache();
    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const movements = await ctx.db.get("SELECT COUNT(*) AS c FROM shift_cash_movements");
    const rejected = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payment_method: "cash",
        confirmed_total: 170,
        confirmed_discount: 50,
      }));
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("QUOTE_CHANGED");
    expect(rejected.body.discount).toBe(0);
    expect(rejected.body.total).toBe(220);
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const movementsAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM shift_cash_movements");
    expect(after.c).toBe(before.c);
    expect(movementsAfter.c).toBe(movements.c);

    const accepted = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payment_method: "cash",
        confirmed_total: rejected.body.total,
        confirmed_discount: rejected.body.discount,
      }));
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.total).toBe(220);
    expect(accepted.body.data.discount).toBe(0);
  });

  test("a valid 50-off promotion charges 170 and records only the eligible line", async () => {
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('خصم لكل وحدة', 'fixed', ?, ?, 50, 1)`,
      [shampooProduct.productId, shampooProduct.unitId]
    );
    invalidatePromotionsCache();
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payments: [{ method: "cash", original_amount: 220 }],
        cash_tendered: 220,
        confirmed_total: 170,
        confirmed_discount: 50,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.discount).toBe(50);
    expect(sale.body.data.total).toBe(170);
    expect(sale.body.data.rounding_adjustment).toBe(-0.46);
    const items = await ctx.db.all(
      "SELECT product_id, line_gross FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [sale.body.data.transaction_id]
    );
    expect(items[0].line_gross).toBe(170.46);
    expect(items[1].line_gross).toBe(50);
    const breakdown = JSON.parse(
      (await ctx.db.get(
        "SELECT promo_breakdown_json FROM transactions WHERE id = ?",
        [sale.body.data.transaction_id]
      )).promo_breakdown_json
    );
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].product_id).toBe(shampooProduct.productId);
    expect(breakdown[0].discount).toBe(50);
  });
});
