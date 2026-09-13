import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { resolveCheckoutPayments } from "../utils/salePayments.js";
import { sumShiftCashPayments, sumShiftCardPayments } from "../utils/salePayments.js";
import { invalidateCurrencyCache } from "../utils/currencies.js";

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
      .send(withCheckoutKey({ items: saleItems(qty), payment_method: "cash" }));
    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    return body.total;
  }

  test("cash-only sale creates one sale_payment and cash movement", async () => {
    const qty = 3;
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ items: saleItems(qty), payment_method: "cash" }));

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
      .send(withCheckoutKey({ items: saleItems(2), payment_method: "visa" }));

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
      .send(withCheckoutKey({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: cashPart },
          { method: "visa", amount: visaPart },
        ],
      }));

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
      .send(withCheckoutKey({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 30 },
          { method: "visa", amount: 20 },
        ],
      }));

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
      .send(withCheckoutKey({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: cashApplied },
          { method: "visa", amount: visaPart },
        ],
        cash_tendered: cashTendered,
      }));

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
      .send(withCheckoutKey({
        items: saleItems(10),
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 40 },
          { method: "visa", amount: total + 30 },
        ],
      }));

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

  test("USD cash tender covers an ILS invoice after FX rounding", async () => {
    const usd = await ctx.db.get("SELECT * FROM currencies WHERE code = 'USD'");
    const invoice = 17.5;
    const r = await resolveCheckoutPayments(
      ctx.db,
      {
        payments: [{ method: "cash", currency_id: usd.id, original_amount: 100 }],
        cash_tendered: 372,
      },
      invoice
    );
    expect(r.error).toBeUndefined();
    expect(r.lines[0].nis_equivalent).toBeCloseTo(372, 2);
    expect(r.changeNis).toBeCloseTo(354.5, 2);
  });

  test("USD amount equal to invoice/rate still covers after round-trip", async () => {
    const usd = await ctx.db.get("SELECT * FROM currencies WHERE code = 'USD'");
    const invoice = 17.5;
    const orig = Math.round((invoice / Number(usd.exchange_rate_to_nis)) * 100) / 100;
    const r = await resolveCheckoutPayments(
      ctx.db,
      { payments: [{ method: "cash", currency_id: usd.id, original_amount: orig }] },
      invoice
    );
    expect(r.error).toBeUndefined();
    expect(r.lines[0].nis_equivalent).toBeGreaterThanOrEqual(invoice);
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

  test("cash-only overpay stores net 45 and counts 45 in the drawer", async () => {
    await ctx.db.run("UPDATE products SET price = 45, tax_rate = 0 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 45 WHERE product_id = ? AND is_default = 1", [
      ctx.productId,
    ]);

    const cashBefore = await sumShiftCashPayments(ctx.db, shiftId);

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 45 }],
        payment_method: "cash",
        payments: [{ method: "cash", original_amount: 45 }],
        cash_tendered: 50,
      }));

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    expect(body.total).toBe(45);

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(45);

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(movement.amount).toBe(45);

    const cashAfter = await sumShiftCashPayments(ctx.db, shiftId);
    expect(cashAfter - cashBefore).toBe(45);

    const shiftRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftId}`)
      .set(authHeader(cashierToken));
    expect(shiftRes.status).toBe(200);
    const shiftBody = shiftRes.body.data ?? shiftRes.body;
    const opening = Number(shiftBody.shift?.opening_cash) || 0;
    expect(shiftBody.summary.expected).toBe(opening + cashAfter);
  });

  test("legacy cash-only tendered amount still counts net of change in the drawer", async () => {
    await ctx.db.run("UPDATE products SET price = 45, tax_rate = 0 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 45 WHERE product_id = ? AND is_default = 1", [
      ctx.productId,
    ]);

    const cashBefore = await sumShiftCashPayments(ctx.db, shiftId);

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 45 }],
        payment_method: "cash",
        payments: [{ method: "cash", original_amount: 50 }],
      }));

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    expect(body.total).toBe(45);

    const payments = await ctx.db.all(
      "SELECT * FROM sale_payments WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(payments[0].amount).toBe(50);

    const tx = await ctx.db.get("SELECT change_amount FROM transactions WHERE id = ?", [
      body.transaction_id,
    ]);
    expect(tx.change_amount).toBe(5);

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(movement.amount).toBe(45);

    const cashAfter = await sumShiftCashPayments(ctx.db, shiftId);
    expect(cashAfter - cashBefore).toBe(45);
  });
});

describe("physical multi-currency drawer", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.db.run("UPDATE currencies SET exchange_rate_to_nis = 3.6 WHERE code = 'USD'");
    invalidateCurrencyCache();
    await ctx.db.run(
      "INSERT INTO app_settings (key, value) VALUES ('default_opening_cash', '50') ON CONFLICT(key) DO UPDATE SET value = '50'"
    );
    await ctx.db.run("UPDATE products SET price = 5, tax_rate = 0 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 5 WHERE product_id = ? AND is_default = 1", [
      ctx.productId,
    ]);
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    shiftId = shiftRes.body.data?.shift_id ?? shiftRes.body.shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 50 WHERE id = ?", [shiftId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("10 USD for a 5 ILS sale leaves 19 ILS + 10 USD (55 ILS total)", async () => {
    const usd = await ctx.db.get("SELECT * FROM currencies WHERE code = 'USD'");
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 5 }],
        payment_method: "cash",
        payments: [{ method: "cash", currency_id: usd.id, original_amount: 10 }],
      }));

    expect(res.status).toBe(201);
    const body = res.body.data ?? res.body;
    expect(body.total).toBe(5);

    const tx = await ctx.db.get(
      "SELECT change_amount, change_original_amount, change_currency_id FROM transactions WHERE id = ?",
      [body.transaction_id]
    );
    expect(Number(tx.change_amount)).toBeCloseTo(31, 2);
    expect(Number(tx.change_original_amount)).toBeCloseTo(31, 2);

    const shiftRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftId}`)
      .set(authHeader(cashierToken));
    const shiftBody = shiftRes.body.data ?? shiftRes.body;
    const byCur = shiftBody.summary.expected_by_currency || [];
    const ils = byCur.find((c) => c.is_base || c.code === "NIS");
    const usdBucket = byCur.find((c) => c.code === "USD");
    expect(Number(ils.original)).toBeCloseTo(19, 2);
    expect(Number(usdBucket.original)).toBeCloseTo(10, 2);
    expect(Number(shiftBody.summary.expected)).toBeCloseTo(55, 2);

    const movement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(Number(movement.amount)).toBeCloseTo(5, 2);
  });

  test("counting 19 ILS + 10 USD matches expected 55", async () => {
    const list = await request(ctx.app)
      .get("/api/v1/shifts")
      .set(authHeader(adminToken));
    const rows = list.body.data ?? list.body;
    const first = (Array.isArray(rows) ? rows : []).find((r) => Number(r.id) === Number(shiftId));
    expect(first).toBeTruthy();
    expect(Number(first.expected_cash)).toBeCloseTo(55, 2);

    await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken));

    const recon = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({
        counted_currencies: [
          { currency_code: "NIS", amount: 19 },
          { currency_code: "USD", amount: 10 },
        ],
      });
    expect([200, 202]).toContain(recon.status);
    const reconBody = recon.body.data ?? recon.body;
    expect(Number(reconBody.closing_cash)).toBeCloseTo(55, 2);
    expect(Math.abs(Number(reconBody.variance))).toBeLessThan(0.02);
  });

  test("blocks ILS change when the shekel drawer is short", async () => {
    const usd = await ctx.db.get("SELECT * FROM currencies WHERE code = 'USD'");
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE id = ?", [shiftId]);
    await ctx.db.run("INSERT INTO app_settings (key, value) VALUES ('default_opening_cash', '10') ON CONFLICT(key) DO UPDATE SET value = '10'");
    const start = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    const shortShift = start.body.data?.shift_id ?? start.body.shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 10 WHERE id = ?", [shortShift]);

    const blocked = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 5 }],
        payment_method: "cash",
        payments: [{ method: "cash", currency_id: usd.id, original_amount: 10 }],
      }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.code || blocked.body.data?.code).toBe("INSUFFICIENT_CHANGE");

    const withUsdChange = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 5 }],
        payment_method: "cash",
        payments: [{ method: "cash", currency_id: usd.id, original_amount: 10 }],
        change_currency_id: usd.id,
      }));
    expect(withUsdChange.status).toBe(201);
  });
});
