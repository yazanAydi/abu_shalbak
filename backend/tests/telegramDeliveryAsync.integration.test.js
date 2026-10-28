import request from "supertest";
import {
  authHeader,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { settleTelegramDeliveries, runDueTelegramRetries } from "../services/telegramDelivery.js";
import { resendPendingTelegramApprovals } from "../services/telegramPendingResend.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { sendAdvanceApprovalMessage, telegramGet } from "../utils/telegram.js";

const CHAT = "6096292831";

function unwrap(body) {
  return body?.data ?? body;
}

describe("async Telegram delivery for every approval workflow", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let otherToken;
  let employeeId;
  let customerId;
  let categoryId;
  let supplierId;
  let transactionId;
  let originalFetch;
  const envKeys = [
    "TELEGRAM_DELIVERY_ASYNC",
    "TELEGRAM_RETRY_TIMERS",
    "TELEGRAM_USE_POLLING",
    "TELEGRAM_HTTP_TIMEOUT_MS",
    "TELEGRAM_REFUND_BOT_TOKEN",
    "TELEGRAM_REFUND_WEBHOOK_SECRET",
    "TELEGRAM_MANAGER_CHAT_ID",
    "TELEGRAM_ZIMMA_BOT_TOKEN",
    "TELEGRAM_ZIMMA_WEBHOOK_SECRET",
    "TELEGRAM_ZIMMA_CHAT_ID",
    "TELEGRAM_SULAF_BOT_TOKEN",
    "TELEGRAM_SULAF_WEBHOOK_SECRET",
    "TELEGRAM_SULAF_CHAT_ID",
    "TELEGRAM_APPROVALS_BOT_TOKEN",
    "TELEGRAM_APPROVALS_CHAT_ID",
    "TELEGRAM_APPROVALS_USER_IDS",
    "TELEGRAM_MANAGER_USER_IDS",
  ];
  const previous = {};

  beforeAll(async () => {
    for (const key of envKeys) previous[key] = process.env[key];
    process.env.TELEGRAM_DELIVERY_ASYNC = "1";
    process.env.TELEGRAM_RETRY_TIMERS = "0";
    process.env.TELEGRAM_USE_POLLING = "0";
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "test-refund-token";
    process.env.TELEGRAM_REFUND_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.TELEGRAM_MANAGER_CHAT_ID = CHAT;
    process.env.TELEGRAM_ZIMMA_BOT_TOKEN = "test-zimma-token";
    process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET = "test-zimma-secret";
    process.env.TELEGRAM_ZIMMA_CHAT_ID = CHAT;
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "test-sulaf-secret";
    process.env.TELEGRAM_SULAF_CHAT_ID = CHAT;
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "test-approvals-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = CHAT;
    process.env.TELEGRAM_APPROVALS_USER_IDS = "4242";
    process.env.TELEGRAM_MANAGER_USER_IDS = "4242";
    originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("live Telegram must not be called");
    };
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const bcrypt = (await import("bcrypt")).default;
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES ('cashier-other', ?, 'cashier', 0)",
      [hash]
    );
    otherToken = (await login(ctx.app, "cashier-other", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    await ctx.db.run("UPDATE products SET stock = 1000, price = 10, cost = 4 WHERE id = ?", [ctx.productId]);
    employeeId = (await createTestEmployee(ctx.db, { name: "موظف التسليم" })).id;
    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('عميل التسليم', 'TD-1', 0, 0, 100000)`
    );
    customerId = customer.lastID;
    categoryId = (
      await ctx.db.run("INSERT INTO expense_categories (name, name_ar, active) VALUES ('power', 'كهرباء', 1)")
    ).lastID;
    supplierId = (
      await ctx.db.run(
        "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد التسليم', 'TD-S', 50, 50)"
      )
    ).lastID;
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 20, price: 10 }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);
    transactionId = unwrap(sale.body).transaction_id;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await destroyTestContext(ctx);
  });

  function memberResult(status = "member") {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: { status, is_member: status === "member" || status === "restricted", message_id: 1 },
      }),
    };
  }

  function installHold() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let markEntered;
    const entered = new Promise((resolve) => {
      markEntered = resolve;
    });
    let sends = 0;
    let messageId = null;
    global.fetch = async (url) => {
      const href = String(url);
      if (!href.includes("api.telegram.org")) throw new Error(`blocked ${href}`);
      if (!href.includes("/sendMessage")) return memberResult();
      sends += 1;
      if (sends > 1) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 900 + sends } }) };
      }
      messageId = 701;
      markEntered();
      await gate;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: messageId } }) };
    };
    return {
      entered,
      release,
      sends: () => sends,
      messageId: () => messageId,
    };
  }

  async function promptCreate({ start, table, getPath, token }) {
    const hold = installHold();
    let httpDone = false;
    const pending = start().then((res) => {
      httpDone = true;
      return res;
    });
    try {
      await Promise.race([
        hold.entered,
        new Promise((_, reject) => setTimeout(() => reject(new Error("delivery did not start")), 3000)),
      ]);
      const res = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("create waited on Telegram")), 500)),
      ]);
      expect(httpDone).toBe(true);
      expect([201, 202]).toContain(res.status);
      const body = unwrap(res.body);
      expect(body.telegram).toBe(false);
      expect(body.telegram_delivery).toBe("queued");
      const requestId = body.request_id;
      const saved = await ctx.db.get(`SELECT status, telegram_message_id FROM ${table} WHERE id = ?`, [requestId]);
      expect(saved.status).toBe("pending");
      expect(saved.telegram_message_id == null || saved.telegram_message_id === "").toBe(true);
      const queued = unwrap(
        (await request(ctx.app).get(`${getPath}/${requestId}`).set(authHeader(token))).body
      );
      expect(queued.status).toBe("pending");
      expect(queued.telegram_delivery).toBe("queued");
      expect(hold.sends()).toBe(1);
      const during = await resendPendingTelegramApprovals(ctx.db);
      expect(Object.values(during).reduce((sum, count) => sum + count, 0)).toBe(0);
      expect(hold.sends()).toBe(1);
      hold.release();
      await settleTelegramDeliveries();
      await settleTelegramDeliveries();
      const delivered = await ctx.db.get(`SELECT status, telegram_message_id FROM ${table} WHERE id = ?`, [requestId]);
      expect(delivered.status).toBe("pending");
      expect(String(delivered.telegram_message_id)).toBe(String(hold.messageId()));
      const sent = unwrap(
        (await request(ctx.app).get(`${getPath}/${requestId}`).set(authHeader(token))).body
      );
      expect(sent.telegram_delivery).toBe("sent");
      expect(String(sent.telegram_message_id)).toBe(String(hold.messageId()));
      const outbound = await ctx.db.get(
        "SELECT state FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
        [table, requestId]
      );
      expect(outbound).toBeFalsy();
      return { requestId, messageId: hold.messageId() };
    } finally {
      hold.release();
    }
  }

  test("refund create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "refund_requests",
      getPath: "/api/v1/refund-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app).post("/api/v1/refund-requests").set(authHeader(cashierToken)).send({
          original_transaction_id: transactionId,
          lines: [{ product_id: ctx.productId, quantity: 1 }],
          reason: "تسليم",
          payment_method: "cash",
        }),
    });
  });

  test("on-account create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "on_account_requests",
      getPath: "/api/v1/on-account-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/checkout")
          .set(authHeader(cashierToken))
          .send(
            withCheckoutKey({
              items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
              payment_method: "on_account",
              customer_id: customerId,
            })
          ),
    });
  });

  test("advance create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "advance_requests",
      getPath: "/api/v1/advance-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/advance-requests")
          .set(authHeader(cashierToken))
          .send({ employee_id: employeeId, amount: 4, notes: "تسليم" }),
    });
  });

  test("customer cash-debt create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "customer_cash_debt_requests",
      getPath: "/api/v1/customer-cash-debt-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/customer-cash-debt-requests")
          .set(authHeader(cashierToken))
          .send({
            customer_id: customerId,
            amount: 3,
            notes: "تسليم",
            idempotency_key: `cash-async-${Date.now()}`,
          }),
    });
  });

  test("expense create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "expense_approval_requests",
      getPath: "/api/v1/expense-requests",
      token: adminToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/expense-requests")
          .set(authHeader(adminToken))
          .send({
            category_id: categoryId,
            amount: 9,
            paid_on: "2026-10-28",
            payment_method: "cash",
            reference_note: "تسليم",
            idempotency_key: `exp-async-${Date.now()}`,
          }),
    });
  });

  test("supplier payment create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "supplier_payment_approval_requests",
      getPath: "/api/v1/supplier-payment-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/pos/supplier-payments")
          .set(authHeader(cashierToken))
          .send({
            supplier_id: supplierId,
            amount: 6,
            notes: "تسليم",
            idempotency_key: `sup-async-${Date.now()}`,
          }),
    });
  });

  test("shop consumption create returns while send is held, then stores the message id", async () => {
    await promptCreate({
      table: "shop_consumption_requests",
      getPath: "/api/v1/shop-consumption-requests",
      token: cashierToken,
      start: () =>
        request(ctx.app)
          .post("/api/v1/pos/shop-consumption")
          .set(authHeader(cashierToken))
          .send({
            items: [{ product_id: ctx.productId, quantity: 1 }],
            reason: "تسليم",
            idempotency_key: `shop-async-${Date.now()}`,
          }),
    });
  });

  test("a failed advance is retried from the saved row without restarting, including 429 timing", async () => {
    let mode = "down";
    let sends = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (!href.includes("api.telegram.org")) throw new Error(`blocked ${href}`);
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      sends += 1;
      if (mode === "down") throw new Error("network down");
      if (mode === "limited") {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 17 },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 880 } }) };
    };

    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 5, notes: "إعادة" });
    expect(created.status).toBe(201);
    const requestId = unwrap(created.body).request_id;
    await settleTelegramDeliveries();
    const failed = await ctx.db.get(
      "SELECT state, attempts, next_attempt_at, last_error FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    expect(failed.state).toBe("queued");
    expect(failed.attempts).toBe(1);
    expect(sends).toBe(1);
    const tooSoon = Date.parse(failed.next_attempt_at) - 1000;
    expect(await runDueTelegramRetries(ctx.db, tooSoon)).toBe(0);
    expect(sends).toBe(1);

    mode = "limited";
    expect(await runDueTelegramRetries(ctx.db, Date.parse(failed.next_attempt_at) + 1000)).toBe(0);
    const limited = await ctx.db.get(
      "SELECT state, attempts, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    expect(limited.state).toBe("queued");
    expect(limited.attempts).toBe(2);
    const limitedAt = Date.parse(failed.next_attempt_at) + 1000;
    expect(Date.parse(limited.next_attempt_at) - limitedAt).toBeGreaterThan(16000);
    expect(Date.parse(limited.next_attempt_at) - limitedAt).toBeLessThan(18000);
    expect(await runDueTelegramRetries(ctx.db, Date.parse(limited.next_attempt_at) - 1000)).toBe(0);
    expect(sends).toBe(2);

    mode = "ok";
    expect(await runDueTelegramRetries(ctx.db, Date.parse(limited.next_attempt_at) + 1000)).toBe(1);
    const row = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("pending");
    expect(row.telegram_message_id).toBe("880");
    const viewed = unwrap(
      (await request(ctx.app).get(`/api/v1/advance-requests/${requestId}`).set(authHeader(cashierToken))).body
    );
    expect(viewed.telegram_delivery).toBe("sent");
  });

  test("startup recovery sends a pending row, and a resolved row is not sent again", async () => {
    let sends = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      sends += 1;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 881 } }) };
    };
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 2, notes: "إيقاف" });
    const requestId = unwrap(created.body).request_id;
    await settleTelegramDeliveries();
    await ctx.db.run("UPDATE advance_requests SET telegram_message_id = NULL WHERE id = ?", [requestId]);
    await ctx.db.run("DELETE FROM telegram_outbound WHERE request_table = ? AND request_id = ?", [
      "advance_requests",
      requestId,
    ]);
    sends = 0;
    const recovered = await resendPendingTelegramApprovals(ctx.db);
    expect(recovered.sulaf).toBeGreaterThanOrEqual(1);
    const row = await ctx.db.get("SELECT telegram_message_id, status FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.telegram_message_id).toBe("881");
    expect(row.status).toBe("pending");

    await ctx.db.run("UPDATE advance_requests SET status = 'rejected', telegram_message_id = NULL WHERE id = ?", [
      requestId,
    ]);
    const before = sends;
    await resendPendingTelegramApprovals(ctx.db);
    expect(sends).toBe(before);
    const retry = await request(ctx.app)
      .post("/api/v1/telegram/outbound/retry")
      .set(authHeader(cashierToken))
      .send({ kind: "advance", request_id: requestId });
    expect(retry.status).toBe(409);
    expect(sends).toBe(before);
  });

  test("rejecting while delivery is held does not store a message or move cash", async () => {
    const hold = installHold();
    const movementsBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n);
    const pending = request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 8, notes: "أثناء الإرسال" })
      .then((res) => res);
    try {
      await Promise.race([
        hold.entered,
        new Promise((_, reject) => setTimeout(() => reject(new Error("delivery did not start")), 3000)),
      ]);
      const created = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("create waited on Telegram")), 500)),
      ]);
      const requestId = unwrap(created.body).request_id;
      const rejected = await request(ctx.app)
        .put(`/api/v1/advance-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "rejected", review_notes: "لا" });
      expect(rejected.status).toBe(200);
      hold.release();
      await settleTelegramDeliveries();
      const row = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
      expect(row.status).toBe("rejected");
      expect(row.telegram_message_id == null || row.telegram_message_id === "").toBe(true);
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n)).toBe(movementsBefore);
      expect(hold.sends()).toBeGreaterThanOrEqual(1);
    } finally {
      hold.release();
    }
  });

  test("replaying an expense key does not send twice, and a repeated approval does not post twice", async () => {
    let sends = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes("editMessageText") || href.includes("answerCallbackQuery") || href.includes("getChatMember")) {
        return memberResult();
      }
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      sends += 1;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 882 } }) };
    };
    const payload = {
      category_id: categoryId,
      amount: 11,
      paid_on: "2026-10-28",
      payment_method: "cash",
      idempotency_key: "exp-async-replay-01",
    };
    const first = await request(ctx.app).post("/api/v1/expense-requests").set(authHeader(adminToken)).send(payload);
    const second = await request(ctx.app).post("/api/v1/expense-requests").set(authHeader(adminToken)).send(payload);
    expect(unwrap(second.body).request_id).toBe(unwrap(first.body).request_id);
    await settleTelegramDeliveries();
    expect(sends).toBe(1);
    const requestId = unwrap(first.body).request_id;
    const expensesBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n);
    const approved = await request(ctx.app)
      .post(`/api/v1/expense-requests/${requestId}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    const again = await request(ctx.app)
      .post(`/api/v1/expense-requests/${requestId}/approve`)
      .set(authHeader(adminToken));
    expect(again.status).toBe(409);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)).toBe(expensesBefore + 1);
  });

  test("only the stored message can approve an advance, and a second click does not pay twice", async () => {
    let sends = 0;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes("getChatMember") || href.includes("answerCallbackQuery") || href.includes("editMessage")) {
        return memberResult();
      }
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      sends += 1;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 883 } }) };
    };
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 7, notes: "زر" });
    const requestId = unwrap(created.body).request_id;
    await settleTelegramDeliveries();
    expect(sends).toBe(1);
    const movementsBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n
    );

    function click(messageId, chat = CHAT) {
      return handleTelegramUpdate(ctx.db, {
        callback_query: {
          id: `cq-adv-${requestId}-${messageId}-${Math.random()}`,
          data: `sulaf:approve:${requestId}`,
          from: { id: 4242, first_name: "ليلى" },
          message: { message_id: messageId, chat: { id: chat, type: "supergroup" } },
        },
      });
    }

    const wrongMessage = await click(1);
    expect(wrongMessage.action).not.toBe("approve");
    const wrongChat = await click(883, "111");
    expect(wrongChat.action).toBe("denied");
    global.fetch = async (url) => {
      const href = String(url);
      if (String(url).includes("getChatMember")) return memberResult("left");
      if (href.includes("answerCallbackQuery") || href.includes("editMessage")) return memberResult();
      throw new Error(`unexpected ${href}`);
    };
    const outsider = await click(883);
    expect(outsider.action).toBe("denied");
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n)).toBe(
      movementsBefore
    );

    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes("getChatMember")) return memberResult("administrator");
      if (href.includes("answerCallbackQuery") || href.includes("editMessage")) return memberResult();
      throw new Error(`unexpected ${href}`);
    };
    const approved = await click(883);
    expect(approved.action).toBe("approve");
    const repeat = await click(883);
    expect(repeat.action).toBe("already_handled");
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n)).toBe(
      movementsBefore + 1
    );
    const row = await ctx.db.get("SELECT status FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("approved");
  });

  test("a timeout is ambiguous, a later retry binds only the new message, and money posts once", async () => {
    process.env.TELEGRAM_HTTP_TIMEOUT_MS = "1000";
    let phase = "timeout";
    global.fetch = async (url, options) => {
      const href = String(url);
      if (href.includes("getChatMember")) return memberResult("administrator");
      if (href.includes("answerCallbackQuery") || href.includes("editMessage")) return memberResult();
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      if (phase === "timeout") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 884 } }) };
    };
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 3, notes: "مهلة غامضة" });
    const requestId = unwrap(created.body).request_id;
    await settleTelegramDeliveries();
    const failed = await ctx.db.get(
      "SELECT state, last_error, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?",
      ["advance_requests", requestId]
    );
    expect(failed.state).toBe("queued");
    expect(String(failed.last_error).startsWith("ambiguous_timeout")).toBe(true);
    const pending = await ctx.db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(pending.telegram_message_id == null || pending.telegram_message_id === "").toBe(true);

    phase = "ok";
    expect(await runDueTelegramRetries(ctx.db, Date.parse(failed.next_attempt_at) + 1000)).toBe(1);
    const bound = await ctx.db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(bound.telegram_message_id).toBe("884");
    const movementsBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n
    );
    const click = (messageId) =>
      handleTelegramUpdate(ctx.db, {
        callback_query: {
          id: `cq-timeout-${requestId}-${messageId}-${Math.random()}`,
          data: `sulaf:approve:${requestId}`,
          from: { id: 4242, first_name: "ليلى" },
          message: { message_id: messageId, chat: { id: CHAT, type: "supergroup" } },
        },
      });
    expect((await click(1)).action).not.toBe("approve");
    expect((await click(884)).action).toBe("approve");
    expect((await click(884)).action).toBe("already_handled");
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'advance'")).n)).toBe(
      movementsBefore + 1
    );
    delete process.env.TELEGRAM_HTTP_TIMEOUT_MS;
  });

  test("permanent failure is visible, and the same request can be retried by its cashier", async () => {
    let mode = "forbidden";
    global.fetch = async (url) => {
      const href = String(url);
      if (!href.includes("/sendMessage")) throw new Error(`unexpected ${href}`);
      if (mode === "forbidden") {
        return {
          ok: true,
          json: async () => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 885 } }) };
    };
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 1.5, notes: "ممنوع" });
    const requestId = unwrap(created.body).request_id;
    await settleTelegramDeliveries();
    const viewed = unwrap(
      (await request(ctx.app).get(`/api/v1/advance-requests/${requestId}`).set(authHeader(cashierToken))).body
    );
    expect(viewed.status).toBe("pending");
    expect(viewed.telegram_delivery).toBe("failed");
    const denied = await request(ctx.app)
      .post("/api/v1/telegram/outbound/retry")
      .set(authHeader(otherToken))
      .send({ kind: "advance", request_id: requestId });
    expect(denied.status).toBe(403);
    mode = "ok";
    const retried = await request(ctx.app)
      .post("/api/v1/telegram/outbound/retry")
      .set(authHeader(cashierToken))
      .send({ kind: "advance", request_id: requestId });
    expect(retried.status).toBe(200);
    expect(unwrap(retried.body).telegram_delivery).toBe("sent");
    const row = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("pending");
    expect(row.telegram_message_id).toBe("885");
  });

  test("invalid send timeout falls back, and getUpdates is not cut to the send timeout", async () => {
    const realSetTimeout = global.setTimeout;
    const delays = [];
    const timers = [];
    global.setTimeout = (fn, ms, ...args) => {
      delays.push(ms);
      const id = realSetTimeout(fn, ms, ...args);
      timers.push(id);
      return id;
    };
    const calls = [];
    process.env.TELEGRAM_HTTP_TIMEOUT_MS = "nope";
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), signal: options?.signal });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 4, id: 9, username: "bot" } }) };
    };
    try {
      await sendAdvanceApprovalMessage({
        requestId: 1,
        cashierName: "cashier",
        employeeName: "employee",
        amount: 1,
        notes: "",
      });
      await telegramGet("getUpdates", { timeout: 30, offset: 0 }, process.env.TELEGRAM_SULAF_BOT_TOKEN);
      expect(delays).toContain(15000);
      const send = calls.find((call) => call.url.includes("/sendMessage"));
      const poll = calls.find((call) => call.url.includes("/getUpdates"));
      expect(send.signal).toBeTruthy();
      expect(poll.signal).toBeUndefined();
      expect(poll.url).toContain("timeout=30");
    } finally {
      for (const id of timers) clearTimeout(id);
      global.setTimeout = realSetTimeout;
      delete process.env.TELEGRAM_HTTP_TIMEOUT_MS;
    }
  });
});
