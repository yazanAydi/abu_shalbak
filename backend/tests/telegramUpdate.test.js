import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

describe("Telegram refund callback", () => {
  let ctx;
  let cashierToken;
  let transactionId;
  let originalFetch;
  const managerChatId = "6096292831";

  beforeAll(async () => {
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "test-refund-token";
    process.env.TELEGRAM_REFUND_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.TELEGRAM_MANAGER_CHAT_ID = managerChatId;

    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      json: async () => ({ ok: true, result: true }),
    }));

    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});

    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      });
    transactionId = checkoutRes.body.data.transaction_id;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    delete process.env.TELEGRAM_REFUND_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_MANAGER_CHAT_ID;
    await destroyTestContext(ctx);
  });

  test("handleTelegramUpdate approves pending refund via callback", async () => {
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

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-1",
        data: `refund:approve:${requestId}`,
        message: { chat: { id: Number(managerChatId) } },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.action).toBe("approve");
    expect(result.requestId).toBe(requestId);

    const reqRow = await ctx.db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");

    const stockAfter = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    expect(stockAfter).toBe(stockBefore + 1);
  });

  test("webhook with correct secret approves pending refund", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    const txnId = checkoutRes.body.data.transaction_id;

    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txnId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });

    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;

    const webhookRes = await request(ctx.app)
      .post("/api/v1/telegram/webhook/test-webhook-secret")
      .send({
        callback_query: {
          id: "test-cq-2",
          data: `refund:approve:${requestId}`,
          message: { chat: { id: Number(managerChatId) } },
        },
      });

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.data?.ok ?? webhookRes.body.ok).toBe(true);

    const reqRow = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
  });
});
