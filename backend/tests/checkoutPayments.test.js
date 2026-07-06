import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { resolveCheckoutPayments } from "../utils/salePayments.js";
import { sumShiftCashPayments, sumShiftCardPayments } from "../utils/salePayments.js";

describe("Checkout payments", () => {
  let ctx;
  let cashierToken;
  let shiftId;
  let product;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data?.shift_id ?? shiftRes.body.shift_id;

    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function saleItems(qty = 10) {
    return [{ product_id: ctx.productId, quantity: qty, price: product.price }];
  }

  async function saleTotal(qty = 10) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({ items: saleItems(qty), payment_method: "cash" });
    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    return body.total;
  }

  test("cash-only sale creates one sale_payment and cash movement", async () => {
    const qty = 3;
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({ items: saleItems(qty), payment_method: "cash" });

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    const txId = body.transaction_id;

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ?",
      [txId]
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_method).toBe("cash");
    expect(payments[0].amount).toBe(body.total);

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [txId]
    );
    expect(movement.amount).toBe(body.total);

    const tx = await ctx.db.get("SELECT payment_method FROM transactions WHERE id = ?", [txId]);
    expect(tx.payment_method).toBe("cash");
  });

  test("card-only sale creates one sale_payment and no cash movement", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({ items: saleItems(2), payment_method: "visa" });

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    const txId = body.transaction_id;

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ?",
      [txId]
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_method).toBe("visa");

    const movement = await ctx.db.get(
      "SELECT 1 AS x FROM shift_cash_movements WHERE transaction_id = ?",
      [txId]
    );
    expect(movement).toBeUndefined();
  });

  test("split cash + card sale stores two payment lines", async () => {
    const total = await saleTotal(10);
    const cashPart = Math.round(total * 0.4 * 100) / 100;
    const visaPart = Math.round((total - cashPart) * 100) / 100;

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: cashPart },
          { method: "visa", amount: visaPart },
        ],
      });

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    const txId = body.transaction_id;

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ? ORDER BY payment_method",
      [txId]
    );
    expect(payments).toHaveLength(2);
    expect(body.payment_method).toBe("mixed");

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [txId]
    );
    expect(movement.amount).toBe(cashPart);

    const cashSum = await sumShiftCashPayments(ctx.db, shiftId);
    const cardSum = await sumShiftCardPayments(ctx.db, shiftId);
    expect(cashSum).toBeGreaterThanOrEqual(cashPart);
    expect(cardSum).toBeGreaterThanOrEqual(visaPart);
  });

  test("rejects insufficient payment", async () => {
    const total = await saleTotal(10);
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 30 },
          { method: "visa", amount: 20 },
        ],
      });

    expect(res.status).toBe(400);
    expect((res.body.error || res.body.data?.error || "").length).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(50);
  });

  test("over-cash payment calculates change on receipt", async () => {
    const total = await saleTotal(10);
    const visaPart = Math.round(total * 0.6 * 100) / 100;
    const cashApplied = Math.round((total - visaPart) * 100) / 100;
    const cashTendered = cashApplied + 10;

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: cashApplied },
          { method: "visa", amount: visaPart },
        ],
        cash_tendered: cashTendered,
      });

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    expect(body.receipt_text).toContain("الباقي");
    expect(body.receipt_text).toMatch(/10\.00/);

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ? AND payment_method = 'cash'",
      [body.transaction_id]
    );
    expect(payments[0].amount).toBe(cashApplied);
  });

  test("rejects card overpayment beyond invoice total", async () => {
    const total = await saleTotal(10);
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 40 },
          { method: "visa", amount: total + 30 },
        ],
      });

    expect(res.status).toBe(400);
  });

  test("resolveCheckoutPayments rejects visa overpay beyond invoice total", async () => {
    const r = await resolveCheckoutPayments(
      ctx.db,
      {
        payments: [
          { method: "cash", amount: 40 },
          { method: "visa", amount: 105 },
        ],
      },
      100
    );
    expect(r.error).toBeTruthy();
  });

  test("resolveCheckoutPayments snapshots the exchange rate on foreign cash", async () => {
    const usd = await ctx.db.get("SELECT * FROM currencies WHERE code = 'USD'");
    const r = await resolveCheckoutPayments(
      ctx.db,
      {
        payments: [{ method: "cash", currency_id: usd.id, original_amount: 50 }],
      },
      100
    );
    expect(r.error).toBeUndefined();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].exchange_rate_used).toBe(usd.exchange_rate_to_nis);
    expect(r.lines[0].nis_equivalent).toBe(
      Math.round(50 * usd.exchange_rate_to_nis * 100) / 100
    );
    // 50 USD * 3.72 = 186 NIS, invoice 100 -> change 86 NIS from cash.
    expect(r.changeNis).toBeCloseTo(
      Math.round((50 * usd.exchange_rate_to_nis - 100) * 100) / 100,
      2
    );
  });
});
