import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";

/**
 * Stage 2 — historical profit/COGS must come from sale-item snapshots.
 * Scenario A: profit reflects the cost at the time of sale.
 * Scenario C: changing the product cost later does NOT rewrite old profit,
 *             and refunds reverse COGS using the original snapshot.
 */
describe("Historical profit from snapshots (Scenario A + C)", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let shiftId;
  let cashierId;
  let saleTxId;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierId = cashierLogin.body.user.id;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;

    // Sale-time cost = 6, price = 10, quantity = 2.
    await ctx.db.run("UPDATE products SET cost = 6, price = 10, stock = 100, tax_rate = 0 WHERE id = ?", [
      ctx.productId,
    ]);

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    saleTxId = sale.body.data.transaction_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function todayRow() {
    const res = await request(ctx.app)
      .get("/api/v1/reports/last-7-days")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const days = (res.body.data || res.body).days;
    return days.find((d) => d.date === today);
  }

  test("Scenario A: COGS = sale-time cost, profit = revenue − COGS", async () => {
    const row = await todayRow();
    expect(row).toBeTruthy();
    expect(row.cost).toBe(12); // 6 × 2 from snapshot
    expect(row.profit).toBe(round2(row.revenue - 12));
  });

  test("Scenario C: changing product cost does NOT change old sale's COGS/profit", async () => {
    const before = await todayRow();
    await ctx.db.run("UPDATE products SET cost = 8 WHERE id = ?", [ctx.productId]);
    const after = await todayRow();
    expect(after.cost).toBe(12); // still 6 × 2, not 8 × 2
    expect(after.profit).toBe(before.profit);

    // Confirm the live product cost really did change.
    const p = await ctx.db.get("SELECT cost FROM products WHERE id = ?", [ctx.productId]);
    expect(Number(p.cost)).toBe(8);
  });

  test("Scenario C: refund reverses COGS using the ORIGINAL snapshot, not current cost", async () => {
    // Refund 1 of the 2 units. Snapshot unit cost was 6; current cost is 8.
    await ctx.db.run(
      `INSERT INTO refunds (
         original_transaction_id, items_json, subtotal, tax, total,
         payment_method, reason, cashier_id, shift_id, status, approved_at
       ) VALUES (?, ?, ?, ?, ?, 'cash', 'test', ?, ?, 'approved', datetime('now'))`,
      [
        saleTxId,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        10,
        0,
        10,
        cashierId,
        shiftId,
      ]
    );

    const row = await todayRow();
    // Sales COGS 12 − refund COGS 6 (snapshot) = 6. If it wrongly used current
    // cost (8) it would be 12 − 8 = 4.
    expect(row.cost).toBe(6);
  });
});

describe("Historical profit: valid zero vs missing snapshot", () => {
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
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function todayRow() {
    const res = await request(ctx.app)
      .get("/api/v1/reports/last-7-days")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return (res.body.data || res.body).days.find((d) => d.date === today);
  }

  test("zero-cost snapshot stays 0 after live cost is edited", async () => {
    await ctx.db.run("UPDATE products SET cost = 0, price = 10, stock = 100 WHERE id = ?", [
      ctx.productId,
    ]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);
    const before = await todayRow();
    expect(before.cost).toBe(0);
    expect(before.cost_unknown).toBe(false);
    expect(before.profit).toBe(10);

    await ctx.db.run("UPDATE products SET cost = 9 WHERE id = ?", [ctx.productId]);
    const after = await todayRow();
    expect(after.cost).toBe(0);
    expect(after.cost_unknown).toBe(false);
    expect(after.profit).toBe(before.profit);
  });

  test("missing snapshot does not use live cost or report fake known zero", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const shift = await ctx.db.get("SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1");
    await ctx.db.run("UPDATE products SET cost = 77 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'completed', datetime('now'))`,
      [
        cashier.id,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        shift.id,
      ]
    );

    const row = await todayRow();
    expect(row.cost).toBeNull();
    expect(row.profit).toBeNull();
    expect(row.cost_unknown).toBe(true);

    const daily = await request(ctx.app)
      .get(`/api/v1/reports/daily?date=${today}`)
      .set(authHeader(adminToken));
    expect(daily.status).toBe(200);
    const dailyBody = daily.body.data ?? daily.body;
    expect(dailyBody.cost).toBeNull();
    expect(dailyBody.profit).toBeNull();
    expect(dailyBody.cost_unknown).toBe(true);

    const range = await request(ctx.app)
      .get(`/api/v1/reports/range?from=${today}&to=${today}`)
      .set(authHeader(adminToken));
    expect(range.status).toBe(200);
    const rangeBody = range.body.data ?? range.body;
    expect(rangeBody.cost).toBeNull();
    expect(rangeBody.profit).toBeNull();
    expect(rangeBody.cost_unknown).toBe(true);
    expect(rangeBody.by_day[0].cost_unknown).toBe(true);
    expect(rangeBody.by_day[0].profit).toBeNull();
  });
});

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
