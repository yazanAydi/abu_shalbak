import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { approveRefundRequest } from "../services/refundRequestService.js";

describe("Refund sync (sections G + J)", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let adminUser;
  let transactionId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
    adminUser = adminLogin.body.user;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });

    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 3, price: product.price }],
        payment_method: "cash",
      });
    transactionId = checkoutRes.body.data.transaction_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createRequest(qty = 1) {
    const res = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: qty }],
        payment_method: "cash",
        reason: "sync test",
      });
    expect(res.status).toBe(201);
    return res.body.data.request_id;
  }

  test("admin decision records decision_source=admin and appears in history", async () => {
    const requestId = await createRequest(1);
    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);

    const row = await ctx.db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    expect(row.decision_source).toBe("admin");

    const history = await request(ctx.app)
      .get("/api/v1/refund-requests/history?status=approved")
      .set(authHeader(adminToken));
    expect(history.status).toBe(200);
    const rows = history.body.data ?? history.body;
    expect(rows.some((r) => r.id === requestId)).toBe(true);
  });

  test("cashier sees unread terminal decision and can acknowledge", async () => {
    const requestId = await createRequest(1);
    await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", review_notes: "no" });

    const unread = await request(ctx.app)
      .get("/api/v1/refund-requests/mine/unread")
      .set(authHeader(cashierToken));
    expect(unread.status).toBe(200);
    const unreadRows = unread.body.data ?? unread.body;
    expect(unreadRows.some((r) => r.id === requestId)).toBe(true);

    const ack = await request(ctx.app)
      .post(`/api/v1/refund-requests/${requestId}/acknowledge`)
      .set(authHeader(cashierToken));
    expect(ack.status).toBe(200);

    const unreadAfter = await request(ctx.app)
      .get("/api/v1/refund-requests/mine/unread")
      .set(authHeader(cashierToken));
    const afterRows = unreadAfter.body.data ?? unreadAfter.body;
    expect(afterRows.some((r) => r.id === requestId)).toBe(false);
  });

  test("ownership isolation: another cashier cannot acknowledge", async () => {
    const otherHash = await import("bcrypt").then((m) => m.default.hash("otherpass123", 4));
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["othercashier", otherHash]
    );
    const otherLogin = await login(ctx.app, "othercashier", "otherpass123", "pos");
    const otherToken = otherLogin.body.token;

    const requestId = await createRequest(1);
    await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });

    const ack = await request(ctx.app)
      .post(`/api/v1/refund-requests/${requestId}/acknowledge`)
      .set(authHeader(otherToken));
    expect(ack.status).toBe(403);
  });

  test("simultaneous decisions apply only once", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      });
    expect(sale.status).toBe(201);
    const txId = sale.body.data.transaction_id;

    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;

    const manager = { id: adminUser.id, username: adminUser.username, role: adminUser.role };

    await approveRefundRequest(ctx.db, requestId, manager, null, null, "admin");

    await expect(
      approveRefundRequest(ctx.db, requestId, manager, null, null, "telegram")
    ).rejects.toMatchObject({ code: "NOT_PENDING" });

    const refundCount = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM refunds WHERE original_transaction_id = ?",
      [txId]
    );
    expect(refundCount.c).toBe(1);
  });

  test("GET /mine returns only the owning cashier requests", async () => {
    const mine = await request(ctx.app)
      .get("/api/v1/refund-requests/mine")
      .set(authHeader(cashierToken));
    expect(mine.status).toBe(200);
    const rows = mine.body.data ?? mine.body;
    expect(Array.isArray(rows)).toBe(true);
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    for (const r of rows) {
      expect(Number(r.cashier_id)).toBe(Number(cashier.id));
    }
  });
});
