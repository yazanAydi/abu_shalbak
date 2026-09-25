import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  configureTelegramApprover,
  telegramMemberFetch,
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
    global.fetch = jest.fn(telegramMemberFetch({ messageId: 77 }));

    ctx = await createTestContext();
    await configureTelegramApprover(ctx.db);
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
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      }));
    transactionId = checkoutRes.body.data.transaction_id;
  });

  afterEach(() => {
    delete process.env.TELEGRAM_MANAGER_USER_IDS;
    process.env.TELEGRAM_MANAGER_CHAT_ID = managerChatId;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    delete process.env.TELEGRAM_REFUND_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_MANAGER_CHAT_ID;
    delete process.env.TELEGRAM_MANAGER_USER_IDS;
    await destroyTestContext(ctx);
  });

  async function createPendingRefund() {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
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
    return createRes.body.data.request_id;
  }

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
        message: { message_id: 77, chat: { id: Number(managerChatId) } },
        from: { id: Number(managerChatId) },
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
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
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
          message: { message_id: 77, chat: { id: Number(managerChatId) } },
          from: { id: Number(managerChatId) },
        },
      });

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.data?.ok ?? webhookRes.body.ok).toBe(true);

    const reqRow = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
  });

  test("group chat click is approved when allow-list is unset", async () => {
    const groupChatId = "-1001234567890";
    process.env.TELEGRAM_MANAGER_CHAT_ID = groupChatId;
    const requestId = await createPendingRefund();

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-group",
        data: `refund:approve:${requestId}`,
        message: { message_id: 77, chat: { id: Number(groupChatId) } },
        from: { id: 111222333 },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.action).toBe("approve");
    const reqRow = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
  });

  test("a filled approver id list does not block a current group member", async () => {
    process.env.TELEGRAM_MANAGER_USER_IDS = "999888777";
    const requestId = await createPendingRefund();

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-deny",
        data: `refund:approve:${requestId}`,
        message: { message_id: 77, chat: { id: Number(managerChatId) } },
        from: { id: 111222333, first_name: "ليلى" },
      },
    });

    expect(result.action).toBe("approve");
    const reqRow = await ctx.db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
    expect(reqRow.telegram_actor_id).toBe("111222333");
    expect(reqRow.telegram_actor_name).toBe("ليلى");
    expect(reqRow.manager_id).toBeNull();
  });

  test("wrong chat id is denied", async () => {
    const requestId = await createPendingRefund();

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-wrong-chat",
        data: `refund:approve:${requestId}`,
        message: { message_id: 77, chat: { id: 12345 } },
        from: { id: Number(managerChatId) },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.action).toBe("denied");
    const reqRow = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("pending");
  });

  test("an empty linked manager setting does not block a current group member", async () => {
    const requestId = await createPendingRefund();
    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-no-manager",
        data: `refund:approve:${requestId}`,
        message: { message_id: 77, chat: { id: Number(managerChatId) } },
        from: { id: Number(managerChatId), first_name: "سامي" },
      },
    });
    expect(result.action).toBe("approve");
    const reqRow = await ctx.db.get("SELECT status, manager_id FROM refund_requests WHERE id = ?", [requestId]);
    expect(reqRow.status).toBe("approved");
    expect(reqRow.manager_id).toBeNull();
  });
});
