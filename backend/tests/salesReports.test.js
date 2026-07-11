import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Sales reports API: range and daily-series", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  const today = new Date().toISOString().slice(0, 10);

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
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
      });
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
});
