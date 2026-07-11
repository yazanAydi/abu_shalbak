import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { approveRefundRequest } from "../services/refundRequestService.js";

describe("shift edge cases: refund attribution, business day, sale search", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let adminUser;
  let product;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
    adminUser = adminLogin.body.user;
    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function startShift() {
    const res = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    expect(res.status).toBe(201);
    return res.body.data?.shift_id ?? res.body.shift_id;
  }

  async function closeShiftAsCashier(shiftId) {
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
  }

  async function reconcileShift(shiftId, closingCash = 100) {
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: closingCash });
    expect([200, 202]).toContain(res.status);
  }

  async function checkout(qty = 1) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: qty, price: product.price }],
        payment_method: "cash",
      });
    expect(res.status).toBe(201);
    return res.body.data?.transaction_id ?? res.body.transaction_id;
  }

  async function createRefundRequest(transactionId, qty = 1) {
    const res = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: qty }],
        payment_method: "cash",
        reason: "edge case test",
      });
    expect(res.status).toBe(201);
    return res.body.data?.request_id ?? res.body.request_id;
  }

  test("approved cash refund posts to the cashier's current open shift, not the closed one", async () => {
    const shiftA = await startShift();
    const txId = await checkout(2);
    await closeShiftAsCashier(shiftA);
    await reconcileShift(shiftA, 120);

    const shiftB = await startShift();
    const requestId = await createRefundRequest(txId, 1);

    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);

    const refund = await ctx.db.get(
      "SELECT * FROM refunds WHERE original_transaction_id = ? ORDER BY id DESC LIMIT 1",
      [txId]
    );
    expect(Number(refund.shift_id)).toBe(Number(shiftB));

    const movementB = await ctx.db.get(
      "SELECT * FROM shift_cash_movements WHERE shift_id = ? AND refund_id = ?",
      [shiftB, refund.id]
    );
    expect(movementB).toBeTruthy();
    expect(Number(movementB.amount)).toBeLessThan(0);

    const movementA = await ctx.db.get(
      "SELECT * FROM shift_cash_movements WHERE shift_id = ? AND refund_id = ?",
      [shiftA, refund.id]
    );
    expect(movementA).toBeFalsy();

    await closeShiftAsCashier(shiftB);
    await reconcileShift(shiftB, 100);
  });

  test("cash refund approval blocked when cashier has no open shift", async () => {
    const shiftA = await startShift();
    const txId = await checkout(1);
    const requestId = await createRefundRequest(txId, 1);
    await closeShiftAsCashier(shiftA);
    await reconcileShift(shiftA, 110);

    const manager = { id: adminUser.id, username: adminUser.username, role: adminUser.role };
    await expect(
      approveRefundRequest(ctx.db, requestId, manager, null, null, "admin")
    ).rejects.toMatchObject({ code: "NO_OPEN_SHIFT_FOR_REFUND" });
  });

  test("cross-midnight sale reports under shift start business day", async () => {
    const businessDay = "2020-06-15";
    const shiftStart = `${businessDay}T22:00:00.000Z`;
    const saleTime = "2020-06-16T00:30:00.000Z";

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const ins = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, closing_cash, expected_cash, variance, status)
       VALUES (?, ?, ?, 100, 100, 100, 0, 'closed')`,
      [cashier.id, shiftStart, saleTime]
    );
    const shiftId = ins.lastID;

    await ctx.db.run(
      `INSERT INTO transactions (cashier_id, items_json, subtotal, tax, total, change_amount, payment_method, shift_id, receipt_number, status, created_at)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'BD-TEST-1', 'completed', ?)`,
      [
        cashier.id,
        JSON.stringify([
          {
            product_id: ctx.productId,
            name: product.name,
            quantity: 1,
            price: 10,
          },
        ]),
        shiftId,
        saleTime,
      ]
    );

    const dailyRes = await request(ctx.app)
      .get(`/api/v1/reports/daily?date=${businessDay}`)
      .set(authHeader(adminToken));
    expect(dailyRes.status).toBe(200);
    const report = dailyRes.body.data ?? dailyRes.body;
    expect(report.total_transactions).toBe(1);
    expect(report.total_sales).toBe(10);

    const wrongDayRes = await request(ctx.app)
      .get("/api/v1/reports/daily?date=2020-06-16")
      .set(authHeader(adminToken));
    const wrongReport = wrongDayRes.body.data ?? wrongDayRes.body;
    expect(wrongReport.total_transactions).toBe(0);
    expect(wrongReport.total_sales).toBe(0);

    const financeRes = await request(ctx.app)
      .get(`/api/v1/finance/overview?from=${businessDay}&to=${businessDay}`)
      .set(authHeader(adminToken));
    expect(financeRes.status).toBe(200);
    const overview = financeRes.body.data ?? financeRes.body;
    expect(overview.pos_transaction_count).toBe(1);
    expect(overview.pos_sales_total).toBe(10);

    const wrongFinanceRes = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2020-06-16&to=2020-06-16")
      .set(authHeader(adminToken));
    const wrongOverview = wrongFinanceRes.body.data ?? wrongFinanceRes.body;
    expect(wrongOverview.pos_transaction_count).toBe(0);
    expect(wrongOverview.pos_sales_total).toBe(0);
  });

  test("GET /refunds/search finds past sales by product name with returnable flag", async () => {
    const shiftId = await startShift();
    const txId = await checkout(1);

    const searchRes = await request(ctx.app)
      .get("/api/v1/refunds/search?product=Test%20Product")
      .set(authHeader(cashierToken));
    expect(searchRes.status).toBe(200);
    const sales = searchRes.body.data?.sales ?? searchRes.body.sales;
    expect(Array.isArray(sales)).toBe(true);
    expect(sales.some((s) => s.transaction_id === txId && s.returnable === true)).toBe(true);

    await closeShiftAsCashier(shiftId);
    await reconcileShift(shiftId, 110);
  });
});
