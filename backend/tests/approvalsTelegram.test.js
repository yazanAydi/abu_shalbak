import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import {
  getApprovalBotPollConfigs,
  observeApprovalsSetupCommand,
  sendApprovalsConnectionTest,
} from "../utils/telegram.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

function callback(data, { fromId = 555, messageId = 77, chatId = "-100777", status } = {}) {
  return {
    callback_query: {
      id: "cq1",
      data,
      from: { id: fromId, username: "approver", ...(status ? { status } : {}) },
      message: { message_id: messageId, chat: { id: chatId, type: "supergroup" } },
    },
  };
}

function fakeDb({ user = null, target = null } = {}) {
  const runs = [];
  return {
    runs,
    async get(sql, params) {
      if (String(sql).includes("FROM users")) return user;
      if (String(sql).includes("expense_approval_requests") || String(sql).includes("supplier_payment_approval_requests")) {
        return target;
      }
      return null;
    },
    async run(sql, params) {
      runs.push({ sql, params });
      return { lastID: 1 };
    },
  };
}

describe("expenses/supplier approvals bot", () => {
  const prev = {};
  const keys = [
    "TELEGRAM_APPROVALS_BOT_TOKEN",
    "TELEGRAM_APPROVALS_CHAT_ID",
    "TELEGRAM_APPROVALS_WEBHOOK_SECRET",
    "TELEGRAM_APPROVALS_USER_IDS",
    "TELEGRAM_REFUND_BOT_TOKEN",
    "TELEGRAM_REFUND_WEBHOOK_SECRET",
    "TELEGRAM_MANAGER_CHAT_ID",
  ];

  beforeEach(() => {
    for (const key of keys) prev[key] = process.env[key];
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "approvals-test-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = "-100777";
    process.env.TELEGRAM_APPROVALS_WEBHOOK_SECRET = "approvals-secret";
    process.env.TELEGRAM_APPROVALS_USER_IDS = "555";
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "refund-token";
    process.env.TELEGRAM_REFUND_WEBHOOK_SECRET = "refund-secret";
    process.env.TELEGRAM_MANAGER_CHAT_ID = "6096292831";
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    });
  });

  afterEach(() => {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  test("polls the approvals bot with the existing loop even when the group id is empty", () => {
    delete process.env.TELEGRAM_APPROVALS_CHAT_ID;
    const bots = getApprovalBotPollConfigs();
    const approvals = bots.filter((b) => b.kind === "approvals");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].allowedUpdates).toEqual(["message", "callback_query"]);
    expect(bots.filter((b) => b.kind === "refund")).toHaveLength(1);
  });

  test("/start reports the group id and does not authorize the sender", async () => {
    const noticed = observeApprovalsSetupCommand({
      text: "/start@AbuShalbakApprovalsBot",
      chat: { id: -100777, type: "supergroup" },
      from: { id: 555, username: "someone" },
    });
    expect(noticed.authorized).toBe(false);
    expect(noticed.chatId).toBe("-100777");
    expect(process.env.TELEGRAM_APPROVALS_CHAT_ID).toBe("-100777");
    expect(process.env.TELEGRAM_APPROVALS_USER_IDS).toBe("555");

    const db = fakeDb();
    const result = await handleTelegramUpdate(
      db,
      {
        message: {
          text: "/start@AbuShalbakApprovalsBot",
          chat: { id: -100777, type: "supergroup" },
          from: { id: 555 },
        },
      },
      { sourceBot: "approvals" }
    );
    expect(result.action).toBe("setup_observed");
    expect(result.authorized).toBe(false);
    expect(db.runs).toHaveLength(0);
  });

  test("Telegram admin status does not approve someone who left the group", async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "left" } }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    });
    const db = fakeDb({
      target: {
        id: 9,
        kind: "expense",
        request_id: 9,
        telegram_message_id: "77",
        status: "pending",
      },
    });
    const result = await handleTelegramUpdate(
      db,
      callback("expense:approve:9", { fromId: 999, status: "administrator" }),
      { sourceBot: "approvals" }
    );
    expect(result.action).toBe("denied");
    expect(db.runs).toHaveLength(0);
  });

  test("consumption callbacks stay on the approvals bot", async () => {
    const result = await handleTelegramUpdate(fakeDb(), callback("consumption:approve:3"), {
      sourceBot: "approvals",
    });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("mismatch");
    const wrongBot = await handleTelegramUpdate(fakeDb(), callback("consumption:approve:3"), {
      sourceBot: "refund",
    });
    expect(wrongBot.handled).toBe(false);
  });

  test("the click must match this bot, group, message, and request", async () => {
    const user = {
      id: 2,
      username: "boss",
      role: "admin",
      telegram_user_id: "555",
      permissions_json: null,
    };
    const target = {
      id: 9,
      kind: "expense",
      request_id: 9,
      telegram_message_id: "77",
      chat_id: "-100777",
      bot_kind: "approvals",
      status: "pending",
    };
    const wrongMessage = await handleTelegramUpdate(
      fakeDb({ user, target }),
      callback("expense:approve:9", { messageId: 1 }),
      { sourceBot: "approvals" }
    );
    expect(wrongMessage.action).toBe("mismatch");

    const wrongChat = await handleTelegramUpdate(
      fakeDb({ user, target }),
      callback("expense:approve:9", { chatId: "-1001" }),
      { sourceBot: "approvals" }
    );
    expect(wrongChat.action).toBe("denied");

    const wrongBot = await handleTelegramUpdate(fakeDb({ user, target }), callback("expense:approve:9"), {
      sourceBot: "refund",
    });
    expect(wrongBot.handled).toBe(false);
  });

  test("compose passes the approvals variables into the store container", () => {
    const compose = fs.readFileSync(path.resolve("..", "docker-compose.yml"), "utf8");
    for (const key of [
      "TELEGRAM_APPROVALS_BOT_TOKEN",
      "TELEGRAM_APPROVALS_CHAT_ID",
      "TELEGRAM_APPROVALS_WEBHOOK_SECRET",
    ]) {
      expect(compose).toContain(`${key}:`);
    }
    const example = fs.readFileSync(path.resolve("..", ".env.store.example"), "utf8");
    expect(example).toMatch(/^TELEGRAM_APPROVALS_BOT_TOKEN=\s*$/m);
    expect(example).not.toMatch(/^TELEGRAM_APPROVALS_BOT_TOKEN=\S/m);
  });

  test("an empty token does not register a poller", () => {
    delete process.env.TELEGRAM_APPROVALS_BOT_TOKEN;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    expect(() => getApprovalBotPollConfigs()).not.toThrow();
    expect(getApprovalBotPollConfigs().some((b) => b.kind === "approvals")).toBe(false);
  });

  test("connection test sends one labeled message and no financial payload", async () => {
    const calls = [];
    await sendApprovalsConnectionTest(async (method, body, token) => {
      calls.push({ method, body, token });
      return { message_id: 42 };
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("sendMessage");
    expect(calls[0].body.chat_id).toBe("-100777");
    expect(calls[0].body.text).toContain("اختبار اتصال");
    expect(calls[0].body.text).toContain("لم يُنشأ أي مصروف");
    expect(calls[0].body.reply_markup).toBeUndefined();
    expect(calls[0].token).toBe("approvals-test-token");
  });
});
