import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";

describe("Sales reports API: range and daily-series", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    await ctx.db.run("UPDATE products SET stock = 100, price = 10, tax_rate = 0 WHERE id = ?", [
      ctx.productId,
    ]);
    await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
      }));
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("GET /reports/range returns enriched by_day fields", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/reports/range?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.success).toBe(true);
    expect(body.net_sales).toBeDefined();
    expect(body.refunds_total).toBeDefined();
    expect(body.cash_total).toBeDefined();
    expect(body.by_day).toHaveLength(1);
    const row = body.by_day[0];
    expect(row.date).toBe(today);
    expect(row.net_sales).toBeDefined();
    expect(row.refunds_total).toBeDefined();
    expect(row.items_sold).toBeDefined();
    expect(row.cash_total).toBeDefined();
    expect(row.card_total).toBeDefined();
    expect(row.on_account_total).toBeDefined();
    expect(body.on_account_total).toBeDefined();
  });

  test("GET /reports/range rejects invalid dates", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/reports/range?from=bad&to=2020-01-01")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });

  test("GET /reports/daily-series returns profit rows for range", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/reports/daily-series?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.success).toBe(true);
    expect(body.days).toHaveLength(1);
    expect(body.days[0].date).toBe(today);
    expect(body.days[0].revenue).toBeDefined();
    expect(body.days[0].profit).toBeDefined();
  });

  test("GET /reports/daily-series rejects span over 366 days", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/reports/daily-series?from=2020-01-01&to=2021-01-10")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });

  test("GET /reports/daily batches line items and keeps sold qty", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/reports/daily?date=${today}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.items_sold).toBe(2);
    expect(body.top_products[0].quantity).toBe(2);
  });

  test("range on_account_total matches daily and ignores pending ذمة", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('Range OA', 'ROA1', 0, 0, 100000)`
    );
    const customerId = cust.lastID;

    const cash = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(cash.status).toBe(201);

    const visa = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "visa",
        })
      );
    expect(visa.status).toBe(201);

    const mixed = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
          payment_method: "mixed",
          payments: [
            { method: "cash", amount: 8 },
            { method: "visa", amount: 12 },
          ],
        })
      );
    expect(mixed.status).toBe(201);

    const pending = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "on_account",
          customer_id: customerId,
        })
      );
    expect(pending.status).toBe(202);

    const dailyBefore = await request(ctx.app)
      .get(`/api/v1/reports/daily?date=${today}`)
      .set(authHeader(adminToken));
    expect(dailyBefore.status).toBe(200);
    const dailyBeforeBody = dailyBefore.body.data ?? dailyBefore.body;
    expect(dailyBeforeBody.on_account_total).toBe(0);

    const approved = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "on_account",
          customer_id: customerId,
        })
      );
    expect(approved.status).toBe(202);
    const approveRes = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${approved.body.data.request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);

    const daily = await request(ctx.app)
      .get(`/api/v1/reports/daily?date=${today}`)
      .set(authHeader(adminToken));
    const range = await request(ctx.app)
      .get(`/api/v1/reports/range?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(daily.status).toBe(200);
    expect(range.status).toBe(200);
    const d = daily.body.data ?? daily.body;
    const r = range.body.data ?? range.body;
    expect(r.on_account_total).toBe(d.on_account_total);
    expect(r.by_day[0].on_account_total).toBe(d.on_account_total);
    expect(r.cash_total).toBe(d.cash_total);
    expect(r.card_total).toBe(d.card_total);
    expect(d.on_account_total).toBe(10);
    expect(d.cash_total).toBeGreaterThanOrEqual(18);
    expect(d.card_total).toBeGreaterThanOrEqual(22);
  });
});
