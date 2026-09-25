import { jest } from "@jest/globals";
import request from "supertest";
import { startTelegramBotPollLoops } from "../services/telegramPolling.js";
import {
  TELEGRAM_HANDLE_FAILURE_LIMIT,
  processPolledUpdate,
  loadPollOffset,
  persistPollOffset,
  retryTelegramPollFailure,
} from "../services/telegramPollRecovery.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  configureTelegramApprover,
} from "./helpers.js";

describe("Telegram poll loops", () => {
  test("bots receive overlapping getUpdates calls", async () => {
    let resolveA;
    let resolveB;
    const started = [];
    const get = (method, _query, token) => {
      if (method !== "getUpdates") {
        return Promise.resolve([]);
      }
      started.push({ token, at: Date.now() });
      if (token === "token-a") {
        return new Promise((resolve) => {
          resolveA = () => resolve([]);
        });
      }
      if (token === "token-b") {
        return new Promise((resolve) => {
          resolveB = () => resolve([]);
        });
      }
      return Promise.resolve([]);
    };

    const stop = startTelegramBotPollLoops(
      {},
      [
        { kind: "refund", token: "token-a" },
        { kind: "zimma", token: "token-b" },
      ],
      { get, pollTimeoutSec: 1, errorRetryMs: 10 }
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(started.map((s) => s.token).sort()).toEqual(["token-a", "token-b"]);
    expect(Math.abs(started[0].at - started[1].at)).toBeLessThan(30);
    expect(typeof resolveA).toBe("function");
    expect(typeof resolveB).toBe("function");

    stop();
    resolveA();
    resolveB();
  });

  test("error in one bot does not prevent the other from polling", async () => {
    let aCalls = 0;
    let bCalls = 0;
    let resolveB;
    const get = (method, _query, token) => {
      if (method !== "getUpdates") return Promise.resolve([]);
      if (token === "token-a") {
        aCalls += 1;
        return Promise.reject(new Error("refund down"));
      }
      bCalls += 1;
      return new Promise((resolve) => {
        resolveB = () => resolve([]);
      });
    };

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const stop = startTelegramBotPollLoops(
      {},
      [
        { kind: "refund", token: "token-a" },
        { kind: "sulaf", token: "token-b" },
      ],
      { get, pollTimeoutSec: 1, errorRetryMs: 50 }
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(bCalls).toBeGreaterThanOrEqual(1);
    expect(typeof resolveB).toBe("function");

    stop();
    resolveB?.();
    errSpy.mockRestore();
    expect(aCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("Telegram poll recoverability", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    await configureTelegramApprover(ctx.db);
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("persists offset only after a successful handle", async () => {
    const update = { update_id: 40, callback_query: { id: "ok-1", data: "refund:approve:1" } };
    const handle = jest.fn(async () => ({ handled: true, action: "approve", kind: "refund", requestId: 1 }));

    const outcome = await processPolledUpdate(ctx.db, "refund-ok", update, { handle });

    expect(outcome.advanced).toBe(true);
    expect(outcome.skipped).toBe(false);
    expect(await loadPollOffset(ctx.db, "refund-ok")).toBe(41);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test("already_handled is treated as success (NOT_PENDING-safe)", async () => {
    await persistPollOffset(ctx.db, "zimma", 0);
    const handle = jest.fn(async () => ({
      handled: true,
      action: "already_handled",
      kind: "zimma",
      requestId: 9,
    }));

    const outcome = await processPolledUpdate(
      ctx.db,
      "zimma",
      { update_id: 80, callback_query: { id: "done" } },
      { handle }
    );

    expect(outcome.advanced).toBe(true);
    expect(await loadPollOffset(ctx.db, "zimma")).toBe(81);
  });

  test("does not advance offset until N handle failures, then stores and skips", async () => {
    const update = { update_id: 50, callback_query: { id: "poison", data: "refund:approve:2" } };
    const handle = jest.fn(async () => {
      throw new Error("handler boom");
    });

    for (let i = 1; i < TELEGRAM_HANDLE_FAILURE_LIMIT; i += 1) {
      const mid = await processPolledUpdate(ctx.db, "refund-poison", update, { handle });
      expect(mid.advanced).toBe(false);
      expect(mid.skipped).toBe(false);
      expect(mid.attempts).toBe(i);
      expect(await loadPollOffset(ctx.db, "refund-poison")).toBe(0);
    }

    const last = await processPolledUpdate(ctx.db, "refund-poison", update, { handle });
    expect(last.advanced).toBe(true);
    expect(last.skipped).toBe(true);
    expect(last.attempts).toBe(TELEGRAM_HANDLE_FAILURE_LIMIT);
    expect(await loadPollOffset(ctx.db, "refund-poison")).toBe(51);

    const row = await ctx.db.get(
      "SELECT * FROM telegram_poll_failures WHERE bot_kind = ? AND update_id = ?",
      ["refund-poison", 50]
    );
    expect(row).toBeTruthy();
    expect(row.status).toBe("skipped");
    expect(Number(row.attempts)).toBe(TELEGRAM_HANDLE_FAILURE_LIMIT);
    expect(JSON.parse(row.payload_json).update_id).toBe(50);
    expect(row.error).toContain("handler boom");
  });

  test("poll loop uses persisted offset after handle, not before", async () => {
    const offsetsSeen = [];
    let resolveIdle;
    const get = (method, query) => {
      if (method !== "getUpdates") return Promise.resolve([]);
      offsetsSeen.push(Number(query.offset) || 0);
      if (offsetsSeen.length === 1) {
        return Promise.resolve([{ update_id: 100, callback_query: { id: "u100" } }]);
      }
      return new Promise((resolve) => {
        resolveIdle = () => resolve([]);
      });
    };
    const handleOrder = [];
    const handle = async (_db, update) => {
      handleOrder.push({
        updateId: update.update_id,
        offsetAtHandle: offsetsSeen[offsetsSeen.length - 1],
      });
      return { handled: true, action: "approve", kind: "refund", requestId: 3 };
    };

    const stop = startTelegramBotPollLoops(ctx.db, [{ kind: "sulaf-loop", token: "token-sulaf" }], {
      get,
      handle,
      pollTimeoutSec: 1,
      errorRetryMs: 10,
    });

    await new Promise((r) => setTimeout(r, 80));
    stop();
    resolveIdle?.();

    expect(handleOrder).toEqual([{ updateId: 100, offsetAtHandle: 0 }]);
    expect(offsetsSeen[0]).toBe(0);
    expect(offsetsSeen.some((o) => o === 101)).toBe(true);
    expect(await loadPollOffset(ctx.db, "sulaf-loop")).toBe(101);
  });

  test("admin can list stored failures and retry payload without double-apply", async () => {
    await ctx.db.run(
      `INSERT INTO telegram_poll_failures
         (bot_kind, update_id, payload_json, error, attempts, status)
       VALUES (?, ?, ?, ?, 3, 'skipped')`,
      [
        "refund",
        77,
        JSON.stringify({
          update_id: 77,
          callback_query: {
            id: "retry-me",
            data: "refund:approve:77",
            message: { chat: { id: 6096292831 } },
            from: { id: 6096292831 },
          },
        }),
        "previous boom",
      ]
    );
    const stored = await ctx.db.get(
      "SELECT id FROM telegram_poll_failures WHERE bot_kind = ? AND update_id = ?",
      ["refund", 77]
    );

    const cashierList = await request(ctx.app)
      .get("/api/v1/admin/telegram-poll-failures")
      .set(authHeader(cashierToken));
    expect(cashierList.status).toBe(403);

    const listRes = await request(ctx.app)
      .get("/api/v1/admin/telegram-poll-failures")
      .query({ status: "skipped" })
      .set(authHeader(adminToken));
    expect(listRes.status).toBe(200);
    const rows = listRes.body.data?.rows ?? listRes.body.rows;
    expect(rows.some((r) => r.id === stored.id)).toBe(true);

    const handle = jest.fn(async () => ({
      handled: true,
      action: "already_handled",
      kind: "refund",
      requestId: 77,
    }));
    const retried = await retryTelegramPollFailure(ctx.db, stored.id, { handle });
    expect(retried.result.action).toBe("already_handled");
    expect(handle).toHaveBeenCalledTimes(1);

    const after = await ctx.db.get("SELECT status FROM telegram_poll_failures WHERE id = ?", [
      stored.id,
    ]);
    expect(after.status).toBe("retried");

    process.env.TELEGRAM_REFUND_BOT_TOKEN = "test-refund-token";
    process.env.TELEGRAM_MANAGER_CHAT_ID = "6096292831";
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    });
    try {
      const retryRes = await request(ctx.app)
        .post(`/api/v1/admin/telegram-poll-failures/${stored.id}/retry`)
        .set(authHeader(adminToken))
        .send({});
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.data?.result?.action ?? retryRes.body.result?.action).toBe(
        "already_handled"
      );
    } finally {
      global.fetch = originalFetch;
      delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
      delete process.env.TELEGRAM_MANAGER_CHAT_ID;
    }
  });

  test("handleTelegramUpdate retry of a missing request stays already_handled", async () => {
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "test-refund-token";
    process.env.TELEGRAM_MANAGER_CHAT_ID = "6096292831";
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    });

    try {
      const result = await handleTelegramUpdate(ctx.db, {
        callback_query: {
          id: "already-done",
          data: "refund:approve:999999",
          message: { chat: { id: 6096292831 } },
          from: { id: 6096292831 },
        },
      });
      expect(result.action).toBe("already_handled");
    } finally {
      global.fetch = originalFetch;
      delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
      delete process.env.TELEGRAM_MANAGER_CHAT_ID;
    }
  });
});
