import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { round2 } from "../utils/money.js";

/**
 * Synthetic stand-in for the receipt whose lines summed to 220.46,
 * with a final 2 × 25 line. The live sale is not in the databases on this machine.
 */
describe("unexpected 50 discount source", () => {
  let ctx;
  let cashierToken;
  let filler;
  let shampoo;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(shift.status).toBe(201);

    filler = await addProduct({
      name: "صنف السلة",
      barcode: "9902201",
      price: 170.46,
      category: "أخرى",
    });
    shampoo = await addProduct({
      name: "شامبو اختبار",
      barcode: "9902202",
      price: 25,
      category: "عناية",
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.db.run("DELETE FROM promotions");
    invalidatePromotionsCache();
  });

  async function addProduct({ name, barcode, price, category }) {
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
      { product_id: filler.productId, unit_id: filler.unitId, quantity: 1, price: filler.price },
      { product_id: shampoo.productId, unit_id: shampoo.unitId, quantity: 2, price: shampoo.price },
    ];
  }

  async function sell(extra = {}) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ items: basket(), ...extra }));
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function insertPromo(fields) {
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, category, product_unit_id, discount_value, buy_qty, get_qty, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        fields.name,
        fields.offer_type,
        fields.product_id ?? null,
        fields.category ?? null,
        fields.product_unit_id ?? null,
        fields.discount_value ?? 0,
        fields.buy_qty ?? 0,
        fields.get_qty ?? 0,
      ]
    );
    invalidatePromotionsCache();
  }

  test("shelf prices of 220.46 round down to 220 with no discount and no change on a 220 tender", async () => {
    const sale = await sell({
      payments: [{ method: "cash", original_amount: 220 }],
      cash_tendered: 220,
    });

    expect(sale.subtotal).toBe(220.46);
    expect(sale.tax).toBe(0);
    expect(sale.discount).toBe(0);
    expect(sale.amount_before_rounding).toBe(220.46);
    expect(sale.rounding_adjustment).toBe(-0.46);
    expect(sale.total).toBe(220);
    expect(sale.receipt_html).not.toContain("خصم:");
    expect(sale.receipt_html).toContain("تقريب: -0.46");
    expect(sale.receipt_html).toContain("50.00");
    expect(sale.receipt_text).toContain("الباقي:");

    const row = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [sale.transaction_id]);
    expect(row.discount).toBe(0);
    expect(row.total).toBe(220);
    expect(row.rounding_adjustment).toBe(-0.46);
    expect(row.change_amount).toBe(0);

    const items = await ctx.db.all(
      "SELECT line_gross, discount_at_sale, line_net FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [sale.transaction_id]
    );
    expect(round2(items.reduce((sum, item) => sum + item.line_gross, 0))).toBe(220.46);
    expect(items.every((item) => item.discount_at_sale === 0)).toBe(true);
    expect(items[1].line_gross).toBe(50);
    expect(items[1].line_net).toBe(50);

    const payment = await ctx.db.get(
      "SELECT nis_equivalent, original_amount FROM sale_payments WHERE transaction_id = ?",
      [sale.transaction_id]
    );
    expect(payment.original_amount).toBe(220);
    expect(round2(payment.nis_equivalent - row.total)).toBe(row.change_amount);
  });

  test("a fixed per-unit offer that covers the shampoo price stores and prints one 50 discount", async () => {
    await insertPromo({
      name: "خصم الشامبو",
      offer_type: "fixed",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      discount_value: 50,
    });

    const sale = await sell({
      payments: [{ method: "cash", original_amount: 220 }],
      cash_tendered: 220,
    });

    expect(sale.subtotal).toBe(220.46);
    expect(sale.discount).toBe(50);
    expect(sale.amount_before_rounding).toBe(170.46);
    expect(sale.rounding_adjustment).toBe(-0.46);
    expect(sale.total).toBe(170);
    expect(sale.receipt_html).toContain("خصم: 50.00");
    expect(sale.receipt_html).toContain("المجموع قبل الخصم: 220.46");
    expect(sale.receipt_html).toContain("تقريب: -0.46");
    expect(sale.receipt_html).toContain("170.00");

    const row = await ctx.db.get(
      "SELECT discount, total, change_amount, rounding_adjustment FROM transactions WHERE id = ?",
      [sale.transaction_id]
    );
    expect(row.discount).toBe(50);
    expect(row.total).toBe(170);
    expect(row.rounding_adjustment).toBe(-0.46);
    expect(row.change_amount).toBe(50);

    const items = await ctx.db.all(
      "SELECT line_gross, discount_at_sale FROM transaction_items WHERE transaction_id = ?",
      [sale.transaction_id]
    );
    expect(round2(items.reduce((sum, item) => sum + item.discount_at_sale, 0))).toBe(50);
    expect(items.every((item) => item.line_gross > 0)).toBe(true);

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [sale.transaction_id]
    );
    expect(movement.amount).toBe(170);
  });

  test("buy one get one on two shampoo units saves 25, not the whole line", async () => {
    await insertPromo({
      name: "اشتر حبة وخذ حبة",
      offer_type: "buy_x_get_y",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      buy_qty: 1,
      get_qty: 1,
    });

    const sale = await sell({ payment_method: "cash" });
    expect(sale.discount).toBe(25);
    expect(sale.amount_before_rounding).toBe(195.46);
    expect(sale.rounding_adjustment).toBe(-0.46);
    expect(sale.total).toBe(195);
  });

  test("a held cart keeps the selling-unit deal instead of a broader offer that would zero the line", async () => {
    await insertPromo({
      name: "2 بـ 40",
      offer_type: "multi_price",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      discount_value: 40,
      buy_qty: 2,
    });
    await insertPromo({
      name: "خصم العناية",
      offer_type: "fixed",
      category: "عناية",
      discount_value: 25,
    });

    const direct = await sell({ payment_method: "cash" });
    expect(direct.discount).toBe(10);
    expect(direct.total).toBe(210);
    expect(direct.rounding_adjustment).toBe(-0.46);
    const unitPromo = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = '2 بـ 40'");
    expect(unitPromo.used_qty).toBe(2);

    const held = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({ items: basket() });
    expect(held.status).toBe(201);
    expect(held.body.data.discount).toBe(10);

    const completed = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: basket(),
          payment_method: "cash",
          suspended_sale_id: held.body.data.id,
        })
      );
    expect(completed.status).toBe(201);
    expect(completed.body.data.discount).toBe(10);
    expect(completed.body.data.amount_before_rounding).toBe(210.46);
    expect(completed.body.data.rounding_adjustment).toBe(-0.46);
    expect(completed.body.data.total).toBe(210);
    expect(completed.body.data.receipt_html).toContain("خصم: 10.00");
    expect(completed.body.data.receipt_html).not.toContain("خصم: 50.00");
    const afterHold = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = '2 بـ 40'");
    expect(afterHold.used_qty).toBe(4);
    const categoryPromo = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = 'خصم العناية'");
    expect(categoryPromo.used_qty).toBe(0);
  });

  test("a pre-fix hold keeps the saved 50 until the cashier reviews it, then charges 10", async () => {
    await insertPromo({
      name: "2 بـ 40",
      offer_type: "multi_price",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      discount_value: 40,
      buy_qty: 2,
    });
    await insertPromo({
      name: "خصم العناية",
      offer_type: "fixed",
      category: "عناية",
      discount_value: 25,
    });
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashier.id]
    );
    const hold = await ctx.db.run(
      `INSERT INTO suspended_sales (
         cashier_id, shift_id, note, subtotal, discount, tax, total, status, quote_verified
       ) VALUES (?, ?, 'قبل التثبيت', 220.46, 50, 0, 170.46, 'suspended', 0)`,
      [cashier.id, shift.id]
    );
    const lines = [
      { ...filler, name: "صنف السلة", quantity: 1 },
      { ...shampoo, name: "شامبو اختبار", quantity: 2 },
    ];
    for (const line of lines) {
      await ctx.db.run(
        `INSERT INTO suspended_sale_items (
           suspended_sale_id, product_id, product_unit_id, product_name_snapshot, unit_name_snapshot,
           barcode_snapshot, quantity, unit_price_snapshot, total_price, conversion_to_base, tax_rate_snapshot
         ) VALUES (?, ?, ?, ?, 'حبة', '9902200', ?, ?, ?, 1, 0)`,
        [
          hold.lastID,
          line.productId,
          line.unitId,
          line.name,
          line.quantity,
          line.price,
          round2(line.quantity * line.price),
        ]
      );
    }

    const detail = await request(ctx.app)
      .get(`/api/v1/suspended-sales/${hold.lastID}`)
      .set(authHeader(cashierToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.quote_verified).toBe(false);
    expect(detail.body.data.saved_discount).toBe(50);
    expect(detail.body.data.saved_payable).toBe(170);
    expect(detail.body.data.current_discount).toBe(10);
    expect(detail.body.data.current_payable).toBe(210);

    const txBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const rejected = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payment_method: "cash",
        suspended_sale_id: hold.lastID,
      }));
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("SUSPENDED_QUOTE_UNVERIFIED");
    expect(rejected.body.saved_discount).toBe(50);
    expect(rejected.body.saved_payable).toBe(170);
    expect(rejected.body.current_discount).toBe(10);
    expect(rejected.body.current_payable).toBe(210);
    const txAfterReject = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    expect(txAfterReject.c).toBe(txBefore.c);
    const untouched = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = '2 بـ 40'");
    expect(untouched.used_qty).toBe(0);

    const reviewed = await request(ctx.app)
      .put(`/api/v1/suspended-sales/${hold.lastID}`)
      .set(authHeader(cashierToken))
      .send({ items: basket(), version: detail.body.data.version });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.quote_verified).toBe(true);
    expect(reviewed.body.data.discount).toBe(10);
    expect(reviewed.body.data.payable).toBe(210);

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payments: [{ method: "cash", original_amount: 220 }],
        cash_tendered: 220,
        suspended_sale_id: hold.lastID,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.discount).toBe(10);
    expect(sale.body.data.total).toBe(210);
    expect(sale.body.data.rounding_adjustment).toBe(-0.46);
    expect(sale.body.data.receipt_html).toContain("خصم: 10.00");
    expect(sale.body.data.receipt_html).not.toContain("خصم: 50.00");
    const row = await ctx.db.get(
      "SELECT discount, total, change_amount FROM transactions WHERE id = ?",
      [sale.body.data.transaction_id]
    );
    expect(row.discount).toBe(10);
    expect(row.total).toBe(210);
    expect(row.change_amount).toBe(10);
    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [sale.body.data.transaction_id]
    );
    expect(movement.amount).toBe(210);
    const used = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = '2 بـ 40'");
    expect(used.used_qty).toBe(2);
    const categoryUsed = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = 'خصم العناية'");
    expect(categoryUsed.used_qty).toBe(0);
  });

  test("changing the restored quantity reprices from the current offers", async () => {
    await insertPromo({
      name: "2 بـ 40",
      offer_type: "multi_price",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      discount_value: 40,
      buy_qty: 2,
    });
    await insertPromo({
      name: "خصم العناية",
      offer_type: "fixed",
      category: "عناية",
      discount_value: 25,
    });
    const held = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({ items: basket() });
    expect(held.body.data.discount).toBe(10);

    const changed = basket().map((line) => (
      line.product_id === shampoo.productId ? { ...line, quantity: 1 } : line
    ));
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: changed,
        payment_method: "cash",
        suspended_sale_id: held.body.data.id,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.subtotal).toBe(195.46);
    expect(sale.body.data.discount).toBe(25);
    expect(sale.body.data.amount_before_rounding).toBe(170.46);
    expect(sale.body.data.rounding_adjustment).toBe(-0.46);
    expect(sale.body.data.total).toBe(170);
    expect(sale.body.data.receipt_html).toContain("خصم: 25.00");
    expect(sale.body.data.receipt_html).not.toContain("خصم: 50.00");
  });

  test("a verified hold keeps its saved discount after the winning offer is turned off", async () => {
    await insertPromo({
      name: "2 بـ 40",
      offer_type: "multi_price",
      product_id: shampoo.productId,
      product_unit_id: shampoo.unitId,
      discount_value: 40,
      buy_qty: 2,
    });
    await insertPromo({
      name: "خصم العناية",
      offer_type: "fixed",
      category: "عناية",
      discount_value: 25,
    });
    const held = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({ items: basket() });
    expect(held.body.data.quote_verified).toBe(true);
    expect(held.body.data.discount).toBe(10);

    await ctx.db.run("UPDATE promotions SET active = 0 WHERE name = '2 بـ 40'");
    invalidatePromotionsCache();

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: basket(),
        payments: [{ method: "cash", original_amount: 210 }],
        cash_tendered: 210,
        suspended_sale_id: held.body.data.id,
      }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.discount).toBe(10);
    expect(sale.body.data.total).toBe(210);
    expect(sale.body.data.rounding_adjustment).toBe(-0.46);
    const row = await ctx.db.get(
      "SELECT change_amount FROM transactions WHERE id = ?",
      [sale.body.data.transaction_id]
    );
    expect(row.change_amount).toBe(0);
    const unitUsed = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = '2 بـ 40'");
    expect(unitUsed.used_qty).toBe(2);
    const categoryUsed = await ctx.db.get("SELECT used_qty FROM promotions WHERE name = 'خصم العناية'");
    expect(categoryUsed.used_qty).toBe(0);
  });
});
