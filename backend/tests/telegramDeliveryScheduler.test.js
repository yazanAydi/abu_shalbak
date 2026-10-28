import request from "supertest";
import {
  authHeader,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
} from "./helpers.js";
import {
  retrySavedTelegramDelivery,
  setTelegramDeliveryClock,
  stopTelegramDeliveryScheduler,
} from "../services/telegramDelivery.js";
import { resendPendingTelegramApprovals } from "../services/telegramPendingResend.js";

const T0 = Date.parse("2026-10-28T12:00:00.000Z");

function unwrap(body) {
  return body?.data ?? body;
}

describe("Telegram retry scheduler and rate-limit deadline", () => {
  let ctx;
  let cashierToken;
  let employeeId;
  let now;
  let originalFetch;
  const previous = {};

  beforeAll(async () => {
    for (const key of ["TELEGRAM_RETRY_TIMERS", "TELEGRAM_RETRY_TIMER_CAP_MS", "TELEGRAM_SULAF_BOT_TOKEN", "TELEGRAM_SULAF_CHAT_ID", "TELEGRAM_SULAF_WEBHOOK_SECRET"]) {
      previous[key] = process.env[key];
    }
    process.env.TELEGRAM_RETRY_TIMERS = "1";
    process.env.TELEGRAM_RETRY_TIMER_CAP_MS = "20";
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "scheduler-sulaf-token";
    process.env.TELEGRAM_SULAF_CHAT_ID = "6096292831";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "scheduler-secret";
    originalFetch = global.fetch;
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    employeeId = (await createTestEmployee(ctx.db, { name: "موظف المجدول" })).id;
  });

  afterAll(async () => {
    stopTelegramDeliveryScheduler();
    setTelegramDeliveryClock(null);
    global.fetch = originalFetch;
    for (const key of Object.keys(previous)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await destroyTestContext(ctx);
  });

  beforeEach(() => {
    now = T0;
    setTelegramDeliveryClock(() => now);
    stopTelegramDeliveryScheduler();
  });

  afterEach(() => {
    stopTelegramDeliveryScheduler();
    setTelegramDeliveryClock(null);
  });

  async function tick() {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  test("retry_after=300 stays in force until the deadline, and the scheduler sends only then", async () => {
    let sends = 0;
    global.fetch = async (url) => {
      if (!String(url).includes("/sendMessage")) throw new Error(`unexpected ${url}`);
      sends += 1;
      if (sends === 1) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 300 },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 930 } }) };
    };

    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 4, notes: "مهلة 300" });
    expect(created.status).toBe(201);
    const requestId = unwrap(created.body).request_id;
    const stored = await ctx.db.get(
      "SELECT state, attempts, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    const deadline = Date.parse(stored.next_attempt_at);
    expect(deadline - T0).toBe(300000);
    expect(stored.attempts).toBe(1);
    expect(stored.state).toBe("queued");

    now = T0 + 120000;
    await tick();
    expect(sends).toBe(1);

    const manual = await retrySavedTelegramDelivery(ctx.db, "advance_requests", requestId);
    expect(manual.telegram_delivery).toBe("queued");
    expect(manual.next_attempt_at).toBe(stored.next_attempt_at);
    expect(sends).toBe(1);

    stopTelegramDeliveryScheduler();
    const restarted = await resendPendingTelegramApprovals(ctx.db);
    expect(restarted.sulaf).toBe(0);
    expect(sends).toBe(1);
    const afterRestart = await ctx.db.get(
      "SELECT state, attempts, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    expect(afterRestart).toEqual(stored);

    now = deadline - 1;
    await tick();
    expect(sends).toBe(1);

    now = deadline;
    await tick();
    expect(sends).toBe(2);
    const delivered = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(delivered.status).toBe("pending");
    expect(delivered.telegram_message_id).toBe("930");
    expect(
      await ctx.db.get("SELECT state FROM telegram_outbound WHERE request_table = ? AND request_id = ?", [
        "advance_requests",
        requestId,
      ])
    ).toBeFalsy();
  });

  test("a future deadline is not sent, a held claim is not duplicated, and shutdown clears the timer", async () => {
    let sends = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    global.fetch = async (url) => {
      if (!String(url).includes("/sendMessage")) throw new Error(`unexpected ${url}`);
      sends += 1;
      if (sends === 1) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 300 },
          }),
        };
      }
      await gate;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 931 } }) };
    };

    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 2, notes: "ازدواج" });
    const requestId = unwrap(created.body).request_id;
    const row = await ctx.db.get(
      "SELECT next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    now = Date.parse(row.next_attempt_at) - 1;
    await tick();
    expect(sends).toBe(1);

    now = Date.parse(row.next_attempt_at);
    await tick();
    expect(sends).toBe(2);
    const during = await resendPendingTelegramApprovals(ctx.db);
    expect(during.sulaf).toBe(0);
    expect(sends).toBe(2);
    stopTelegramDeliveryScheduler();
    release();
    await tick();
    const delivered = await ctx.db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(delivered.telegram_message_id).toBe("931");

    sends = 0;
    global.fetch = async (url) => {
      if (!String(url).includes("/sendMessage")) throw new Error(`unexpected ${url}`);
      sends += 1;
      return {
        ok: true,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 300 },
        }),
      };
    };
    const later = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 1, notes: "إيقاف المجدول" });
    expect(sends).toBe(1);
    stopTelegramDeliveryScheduler();
    const laterRow = await ctx.db.get(
      "SELECT next_attempt_at FROM telegram_outbound WHERE request_id = ?",
      [unwrap(later.body).request_id]
    );
    now = Date.parse(laterRow.next_attempt_at);
    await tick();
    expect(sends).toBe(1);
    expect(
      (await ctx.db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [unwrap(later.body).request_id]))
        .telegram_message_id
    ).toBeFalsy();
  });
});
