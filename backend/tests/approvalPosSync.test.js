import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { buildPosDecisionSnapshot } from "../routes/pos.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("POS recovery after Telegram sulaf/zimma decisions", () => {
  let ctx;
  let cashierToken;
  let originalFetch;
  const managerChatId = "6096292832";

  beforeAll(async () => {
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "test-sulaf-secret";
    process.env.TELEGRAM_SULAF_CHAT_ID = managerChatId;
    process.env.TELEGRAM_ZIMMA_BOT_TOKEN = "test-zimma-token";
    process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET = "test-zimma-secret";
    process.env.TELEGRAM_ZIMMA_CHAT_ID = managerChatId;

    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));

    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});

    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    );
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 500 WHERE id = ?", [shift.id]);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_SULAF_BOT_TOKEN;
    delete process.env.TELEGRAM_SULAF_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_SULAF_CHAT_ID;
    delete process.env.TELEGRAM_ZIMMA_BOT_TOKEN;
    delete process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_ZIMMA_CHAT_ID;
    await destroyTestContext(ctx);
  });

  async function telegramCallback(kind, action, requestId) {
    return handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: `cq-${kind}-${action}-${requestId}`,
        data: `${kind}:${action}:${requestId}`,
        message: { chat: { id: Number(managerChatId) } },
        from: { id: Number(managerChatId) },
      },
    });
  }

  test("cashier GET and unread see sulaf approve/reject from Telegram", async () => {
    const createRes = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_name: "أحمد", amount: 40, notes: "سلفة" });
    expect(createRes.status).toBe(201);
    const requestId = unwrap(createRes.body).request_id;

    const approved = await telegramCallback("sulaf", "approve", requestId);
    expect(approved.action).toBe("approve");

    const statusRes = await request(ctx.app)
      .get(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(cashierToken));
    expect(statusRes.status).toBe(200);
    expect(unwrap(statusRes.body).status).toBe("approved");

    const unreadRes = await request(ctx.app)
      .get("/api/v1/advance-requests/mine/unread")
      .set(authHeader(cashierToken));
    expect(unreadRes.status).toBe(200);
    expect(unwrap(unreadRes.body).some((r) => r.id === requestId)).toBe(true);

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const snapshot = await buildPosDecisionSnapshot(ctx.db, cashier.id);
    expect(snapshot.advances.some((r) => r.id === requestId)).toBe(true);

    const ack = await request(ctx.app)
      .post(`/api/v1/advance-requests/${requestId}/acknowledge`)
      .set(authHeader(cashierToken));
    expect(ack.status).toBe(200);

    const unreadAfter = await request(ctx.app)
      .get("/api/v1/advance-requests/mine/unread")
      .set(authHeader(cashierToken));
    expect(unwrap(unreadAfter.body).some((r) => r.id === requestId)).toBe(false);

    const rejectCreate = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_name: "محمود", amount: 15 });
    const rejectId = unwrap(rejectCreate.body).request_id;
    const rejected = await telegramCallback("sulaf", "reject", rejectId);
    expect(rejected.action).toBe("reject");

    const rejectStatus = await request(ctx.app)
      .get(`/api/v1/advance-requests/${rejectId}`)
      .set(authHeader(cashierToken));
    expect(unwrap(rejectStatus.body).status).toBe("rejected");
  });

  test("cashier GET and unread see zimma approve/reject from Telegram", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('Zimma Sync Cust', 'ZS1', 0, 0, 10000)`
    );
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);

    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "on_account",
        customer_id: cust.lastID,
      }));
    expect(checkoutRes.status).toBe(202);
    const requestId = unwrap(checkoutRes.body).request_id;

    const approved = await telegramCallback("zimma", "approve", requestId);
    expect(approved.action).toBe("approve");

    const statusRes = await request(ctx.app)
      .get(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(cashierToken));
    expect(statusRes.status).toBe(200);
    const status = unwrap(statusRes.body);
    expect(status.status).toBe("approved");
    expect(status.checkout?.transaction_id || status.transaction_id).toBeTruthy();

    const unreadRes = await request(ctx.app)
      .get("/api/v1/on-account-requests/mine/unread")
      .set(authHeader(cashierToken));
    expect(unwrap(unreadRes.body).some((r) => r.id === requestId)).toBe(true);

    const checkoutReject = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "on_account",
        customer_id: cust.lastID,
      }));
    const rejectId = unwrap(checkoutReject.body).request_id;
    const rejected = await telegramCallback("zimma", "reject", rejectId);
    expect(rejected.action).toBe("reject");

    const rejectStatus = await request(ctx.app)
      .get(`/api/v1/on-account-requests/${rejectId}`)
      .set(authHeader(cashierToken));
    expect(unwrap(rejectStatus.body).status).toBe("rejected");
  });
});
