import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

describe("Telegram sulaf callback", () => {
  let ctx;
  let cashierToken;
  let originalFetch;
  const managerChatId = "6096292832";

  beforeAll(async () => {
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "test-sulaf-secret";
    process.env.TELEGRAM_SULAF_CHAT_ID = managerChatId;

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
    await destroyTestContext(ctx);
  });

  test("create advance request and approve via Telegram", async () => {
    const createRes = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_name: "أحمد", amount: 50, notes: "سلفة" });

    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-sulaf",
        data: `sulaf:approve:${requestId}`,
        message: { chat: { id: Number(managerChatId) } },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.action).toBe("approve");
    expect(result.kind).toBe("sulaf");

    const row = await ctx.db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("approved");

    const movement = await ctx.db.get(
      "SELECT * FROM shift_cash_movements WHERE advance_request_id = ?",
      [requestId]
    );
    expect(movement).toBeTruthy();
    expect(Number(movement.amount)).toBe(-50);
  });

  test("reject advance via Telegram", async () => {
    const createRes = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_name: "محمود", amount: 25 });

    const requestId = createRes.body.data.request_id;

    const result = await handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: "test-cq-sulaf-reject",
        data: `sulaf:reject:${requestId}`,
        message: { chat: { id: Number(managerChatId) } },
      },
    });

    expect(result.action).toBe("reject");
    const row = await ctx.db.get("SELECT status FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("rejected");
  });
});
