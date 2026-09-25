import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  telegramMemberFetch,
  createTestEmployee,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { approveRefundRequest } from "../services/refundRequestService.js";
import { resendPendingTelegramApprovals } from "../services/telegramPendingResend.js";

const chatId = "6096292831";

function click(data, { fromId = 4242, messageId = 77, chat = chatId, first = "ليلى", last = "حسن", status } = {}) {
  return {
    callback_query: {
      id: `cq-${data}-${fromId}-${messageId}`,
      data,
      from: { id: fromId, first_name: first, last_name: last, username: "layla" },
      message: { message_id: messageId, chat: { id: chat, type: "supergroup" } },
    },
    _status: status,
  };
}

describe("Telegram group membership", () => {
  let ctx;
  let cashierToken;
  let originalFetch;

  beforeAll(async () => {
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "test-refund-token";
    process.env.TELEGRAM_REFUND_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.TELEGRAM_MANAGER_CHAT_ID = chatId;
    process.env.TELEGRAM_ZIMMA_BOT_TOKEN = "test-zimma-token";
    process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET = "test-zimma-secret";
    process.env.TELEGRAM_ZIMMA_CHAT_ID = chatId;
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "test-sulaf-secret";
    process.env.TELEGRAM_SULAF_CHAT_ID = chatId;
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "test-approvals-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = chatId;
    process.env.TELEGRAM_MANAGER_USER_IDS = "1";
    process.env.TELEGRAM_APPROVALS_USER_IDS = "1";
    originalFetch = global.fetch;
    global.fetch = jest.fn(telegramMemberFetch({ messageId: 77 }));
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    for (const key of [
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
      "TELEGRAM_MANAGER_USER_IDS",
      "TELEGRAM_APPROVALS_USER_IDS",
    ]) {
      delete process.env[key];
    }
    await destroyTestContext(ctx);
  });

  beforeEach(() => {
    global.fetch = jest.fn(telegramMemberFetch({ messageId: 77 }));
  });

  async function pendingRefund() {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.body.data.transaction_id,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });
    expect(created.status).toBe(201);
    return created.body.data.request_id;
  }

  function setMember(status, fail = false) {
    global.fetch = jest.fn(telegramMemberFetch({ messageId: 77, memberStatus: status, failMembership: fail }));
  }

  test("a current member approves once and the audit stores their telegram id and name", async () => {
    const requestId = await pendingRefund();
    const result = await handleTelegramUpdate(ctx.db, click(`refund:approve:${requestId}`));
    expect(result.action).toBe("approve");
    const row = await ctx.db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("approved");
    expect(row.telegram_actor_id).toBe("4242");
    expect(row.telegram_actor_name).toBe("ليلى حسن");
    expect(row.manager_id).toBeNull();
    const audit = await ctx.db.get(
      "SELECT * FROM audit_logs WHERE entity_type = 'refund_requests' AND entity_id = ? AND action = 'REFUND_REQUEST_APPROVE'",
      [requestId]
    );
    expect(audit.username).toBe("ليلى حسن");
    expect(audit.new_value).toContain("4242");
    const edited = global.fetch.mock.calls.map((call) => String(call[1]?.body || "")).join("\n");
    expect(edited).toContain("ليلى حسن");
  });

  test("a former member and an outsider leave the refund pending", async () => {
    const requestId = await pendingRefund();
    setMember("left");
    const former = await handleTelegramUpdate(ctx.db, click(`refund:approve:${requestId}`, { fromId: 7 }));
    expect(former.action).toBe("denied");
    setMember("kicked");
    const kicked = await handleTelegramUpdate(ctx.db, click(`refund:reject:${requestId}`, { fromId: 8 }));
    expect(kicked.action).toBe("denied");
    setMember("member");
    const outside = await handleTelegramUpdate(
      ctx.db,
      click(`refund:approve:${requestId}`, { chat: "999", fromId: 9 })
    );
    expect(outside.action).toBe("denied");
    const forwarded = await handleTelegramUpdate(
      ctx.db,
      click(`refund:approve:${requestId}`, { messageId: 1, fromId: 10 })
    );
    expect(forwarded.action).toBe("mismatch");
    const row = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("pending");
  });

  test("membership lookup failure does not decide the request", async () => {
    const requestId = await pendingRefund();
    setMember("member", true);
    const result = await handleTelegramUpdate(ctx.db, click(`refund:approve:${requestId}`));
    expect(result.action).toBe("membership_failed");
    const answers = global.fetch.mock.calls.map((call) => String(call[1]?.body || ""));
    expect(answers.some((body) => body.includes("تعذّر التحقق من عضوية المجموعة"))).toBe(true);
    const row = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("pending");
  });

  test("two members tapping together post one refund", async () => {
    const requestId = await pendingRefund();
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const [a, b] = await Promise.all([
      handleTelegramUpdate(ctx.db, click(`refund:approve:${requestId}`, { fromId: 11, first: "أ" })),
      handleTelegramUpdate(ctx.db, click(`refund:approve:${requestId}`, { fromId: 12, first: "ب" })),
    ]);
    const actions = [a.action, b.action].sort();
    expect(actions).toEqual(["already_handled", "approve"]);
    const refunds = await ctx.db.get("SELECT COUNT(*) AS n FROM refunds WHERE id IN (SELECT refund_id FROM refund_requests WHERE id = ?)", [requestId]);
    expect(Number(refunds.n)).toBe(1);
    const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(stockAfter).toBe(stockBefore + 1);
  });

  test("a failure after the refund post rolls the decision and the stock back", async () => {
    const requestId = await pendingRefund();
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    await expect(
      approveRefundRequest(
        ctx.db,
        requestId,
        { id: null, username: "ليلى", telegram_user_id: "4242", telegram_actor_name: "ليلى", failAfterPost: true },
        null,
        null,
        "telegram"
      )
    ).rejects.toThrow("forced");
    const row = await ctx.db.get("SELECT status, refund_id FROM refund_requests WHERE id = ?", [requestId]);
    expect(row.status).toBe("pending");
    expect(row.refund_id).toBeNull();
    const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(stockAfter).toBe(stockBefore);
  });

  test("resend fills a missing message id and leaves a stored id alone", async () => {
    const missingId = await pendingRefund();
    const keptId = await pendingRefund();
    await ctx.db.run("UPDATE refund_requests SET telegram_message_id = NULL WHERE id = ?", [missingId]);
    await ctx.db.run("UPDATE refund_requests SET telegram_message_id = '555' WHERE id = ?", [keptId]);
    global.fetch = jest.fn(telegramMemberFetch({ messageId: 88 }));
    const counts = await resendPendingTelegramApprovals(ctx.db);
    expect(counts.refund).toBeGreaterThanOrEqual(1);
    const missing = await ctx.db.get("SELECT telegram_message_id FROM refund_requests WHERE id = ?", [missingId]);
    const kept = await ctx.db.get("SELECT telegram_message_id FROM refund_requests WHERE id = ?", [keptId]);
    expect(missing.telegram_message_id).toBe("88");
    expect(kept.telegram_message_id).toBe("555");
    const again = await resendPendingTelegramApprovals(ctx.db);
    expect(again.refund).toBe(0);
  });

  test("sulaf, zimma, cash debt, and approvals deny a former member without writing", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const emp = await createTestEmployee(ctx.db, { name: "عضو سابق" });
    const sulaf = await ctx.db.run(
      `INSERT INTO advance_requests (cashier_id, shift_id, employee_id, employee_name, amount, status, telegram_message_id)
       VALUES (?, (SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1), ?, 'عضو سابق', 5, 'pending', '77')`,
      [cashier.id, emp.id]
    );
    setMember("left");
    const sulafResult = await handleTelegramUpdate(ctx.db, click(`sulaf:approve:${sulaf.lastID}`, { fromId: 70 }));
    expect(sulafResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM advance_requests WHERE id = ?", [sulaf.lastID])).status).toBe("pending");

    const customer = await ctx.db.run("INSERT INTO customers (name, balance) VALUES ('خارج', 0)");
    const debt = await ctx.db.run(
      `INSERT INTO customer_cash_debt_requests
         (cashier_id, shift_id, customer_id, customer_name, amount, status, telegram_message_id)
       VALUES (?, (SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1), ?, 'خارج', 4, 'pending', '77')`,
      [cashier.id, customer.lastID]
    );
    const debtResult = await handleTelegramUpdate(ctx.db, click(`cashdebt:reject:${debt.lastID}`, { fromId: 71 }));
    expect(debtResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM customer_cash_debt_requests WHERE id = ?", [debt.lastID])).status).toBe("pending");

    const cat = await ctx.db.run("INSERT INTO expense_categories (name) VALUES ('اختبار')");
    const expense = await ctx.db.run(
      `INSERT INTO expense_approval_requests
         (requester_id, category_id, category_name, amount, paid_on, payment_method, status, telegram_message_id)
       VALUES (?, ?, 'اختبار', 3, '2026-09-25', 'cash', 'pending', '77')`,
      [cashier.id, cat.lastID]
    );
    const expenseResult = await handleTelegramUpdate(
      ctx.db,
      click(`expense:approve:${expense.lastID}`, { fromId: 72 }),
      { sourceBot: "approvals" }
    );
    expect(expenseResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM expense_approval_requests WHERE id = ?", [expense.lastID])).status).toBe("pending");

    const supplier = await ctx.db.run("INSERT INTO suppliers (name, balance) VALUES ('مورد', 0)");
    const pay = await ctx.db.run(
      `INSERT INTO supplier_payment_approval_requests
         (cashier_id, shift_id, supplier_id, supplier_name, amount, status, telegram_message_id)
       VALUES (?, (SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1), ?, 'مورد', 6, 'pending', '77')`,
      [cashier.id, supplier.lastID]
    );
    const payResult = await handleTelegramUpdate(
      ctx.db,
      click(`supplier:reject:${pay.lastID}`, { fromId: 73 }),
      { sourceBot: "approvals" }
    );
    expect(payResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM supplier_payment_approval_requests WHERE id = ?", [pay.lastID])).status).toBe("pending");

    const zimma = await ctx.db.run(
      `INSERT INTO on_account_requests
         (cashier_id, sale_snapshot_json, subtotal, tax, total_amount, on_account_amount, payment_method, status, telegram_message_id)
       VALUES (?, '{}', 10, 0, 10, 10, 'on_account', 'pending', '77')`,
      [cashier.id]
    );
    const zimmaResult = await handleTelegramUpdate(ctx.db, click(`zimma:approve:${zimma.lastID}`, { fromId: 74 }));
    expect(zimmaResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM on_account_requests WHERE id = ?", [zimma.lastID])).status).toBe("pending");

    const consumption = await ctx.db.run(
      `INSERT INTO shop_consumption_requests
         (cashier_id, shift_id, items_json, status, telegram_message_id)
       VALUES (?, (SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1), '[]', 'pending', '77')`,
      [cashier.id]
    );
    const consumptionResult = await handleTelegramUpdate(
      ctx.db,
      click(`consumption:reject:${consumption.lastID}`, { fromId: 75 }),
      { sourceBot: "approvals" }
    );
    expect(consumptionResult.action).toBe("denied");
    expect((await ctx.db.get("SELECT status FROM shop_consumption_requests WHERE id = ?", [consumption.lastID])).status).toBe("pending");
  });
});
