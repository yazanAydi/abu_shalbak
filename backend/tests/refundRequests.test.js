import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Refund request flow", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let transactionId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});

    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 5, price: product.price }],
        payment_method: "cash",
      });
    transactionId = checkoutRes.body.data.transaction_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("creates pending request without stock change, approves via admin", async () => {
    const stockBefore = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;

    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "test refund request",
        payment_method: "cash",
      });

    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;
    expect(createRes.body.data.request.status).toBe("pending");

    const stockAfterPending = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    expect(stockAfterPending).toBe(stockBefore);

    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });

    expect(approveRes.status).toBe(200);

    const stockAfterApproval = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    expect(stockAfterApproval).toBe(stockBefore + 1);

    const reqRow = await ctx.db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
    expect(reqRow.refund_id).toBeTruthy();

    const ledger = await ctx.db.get(
      "SELECT * FROM inventory_ledger WHERE reference_type = 'refund' AND reference_id = ?",
      [reqRow.refund_id]
    );
    expect(ledger).toBeTruthy();
    expect(ledger.quantity_delta).toBe(1);
  });

  test("reject does not change stock", async () => {
    const stockBefore = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;

    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });

    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;

    const rejectRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", review_notes: "no" });

    expect(rejectRes.status).toBe(200);

    const stockAfter = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    expect(stockAfter).toBe(stockBefore);
  });

  test("telegram webhook rejects wrong secret", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/telegram/webhook/wrong-secret")
      .send({ callback_query: { id: "1", data: "refund:approve:1" } });
    expect(res.status).toBe(403);
  });

  test("legacy POST /refunds delegates to refund_requests", async () => {
    const createRes = await request(ctx.app)
      .post("/api/v1/refunds")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.request_id).toBeTruthy();
    const row = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [
      createRes.body.data.request_id,
    ]);
    expect(row.status).toBe("pending");
  });
});
