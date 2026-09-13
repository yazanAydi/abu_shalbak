import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { executeCheckoutSale } from "../services/checkoutSaleService.js";

describe("Checkout flow", () => {
  let ctx;
  let cashierToken;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("completes sale with receipt number and ledger entry", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = product.stock;

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      }));

    expect(res.status).toBe(201);
    expect(res.body.data.receipt_number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(res.body.data.transaction_id).toBeTruthy();

    const updated = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(updated.stock).toBe(stockBefore - 2);

    const ledger = await ctx.db.all(
      "SELECT * FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0].quantity_delta).toBe(-2);

    const tx = await ctx.db.get("SELECT receipt_number, status FROM transactions WHERE id = ?", [
      res.body.data.transaction_id,
    ]);
    expect(tx.receipt_number).toBe(res.body.data.receipt_number);
    expect(tx.status).toBe("completed");
  });

  test("shift was used for checkout", () => {
    expect(shiftId).toBeTruthy();
  });

  test("exhausted promotion is omitted; checkout is a normal full-price sale", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
       VALUES ('Exhausted checkout', 'percentage', ?, 50, 2, 2, 1)`,
      [ctx.productId]
    );
    invalidatePromotionsCache();

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));

    expect(res.status).toBe(201);
    expect(Number(res.body.data.discount)).toBe(0);
    expect(Number(res.body.data.total)).toBe(Number(product.price));
    const row = await ctx.db.get(
      "SELECT used_qty, limit_qty FROM promotions WHERE name = 'Exhausted checkout'"
    );
    expect(Number(row.used_qty)).toBe(Number(row.limit_qty));
  });

  test("active limited promotion applies until used_qty reaches the cap", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const ins = await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
       VALUES ('One remaining', 'percentage', ?, 50, 1, 0, 1)`,
      [ctx.productId]
    );
    invalidatePromotionsCache();

    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
    expect(first.status).toBe(201);
    expect(Number(first.body.data.discount)).toBeGreaterThan(0);

    invalidatePromotionsCache();
    const second = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
    expect(second.status).toBe(201);
    expect(Number(second.body.data.discount)).toBe(0);

    const row = await ctx.db.get("SELECT used_qty, limit_qty FROM promotions WHERE id = ?", [
      ins.lastID,
    ]);
    expect(Number(row.used_qty)).toBe(Number(row.limit_qty));
  });

  test("executeCheckoutSale rejects a closed shift and writes no transaction", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    await ctx.db.run("UPDATE cashier_shifts SET status = 'pending_count' WHERE id = ?", [shiftId]);
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    await expect(
      executeCheckoutSale(ctx.db, {
        cashierId: cashier.id,
        shiftId,
        custId: null,
        itemsForJson: [],
        normalized: [],
        detailed: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        discount: 0,
        paymentLines: [],
        summaryMethod: "cash",
        onAccountTotal: 0,
        cashTotal: 0,
        changeNis: 0,
        changeCurrencyId: null,
        changeOriginalAmount: 0,
        idempotencyKey: null,
        suspendedSaleId: null,
        promoBreakdown: [],
      })
    ).rejects.toMatchObject({ code: "SHIFT_CLOSED", status: 409 });
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    expect(Number(after.n)).toBe(Number(before.n));
    await ctx.db.run("UPDATE cashier_shifts SET status = 'open' WHERE id = ?", [shiftId]);
  });
});
