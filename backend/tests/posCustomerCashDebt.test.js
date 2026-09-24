import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  configureTelegramApprover,
  createAccountantUser,
} from "./helpers.js";
import { computeExpectedDrawer, computeShiftVisa } from "../utils/salePayments.js";
import { buildCustomerLedger } from "../utils/customerLedger.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

function unwrap(res) {
  const body = res?.body ?? res;
  return body?.data ?? body;
}

async function startShift(app, token, db, opening) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  const shift = await db.get(
    "SELECT * FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
  );
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shift.id]);
  return { ...shift, opening_cash: opening };
}

describe("POS customer cash on account", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let originalFetch;
  const managerChatId = "6096292832";

  beforeAll(async () => {
    process.env.TELEGRAM_ZIMMA_BOT_TOKEN = "test-zimma-token";
    process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET = "test-zimma-secret";
    process.env.TELEGRAM_ZIMMA_CHAT_ID = managerChatId;
    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 41 } }),
    }));
    ctx = await createTestContext();
    await configureTelegramApprover(ctx.db);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_ZIMMA_BOT_TOKEN;
    delete process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_ZIMMA_CHAT_ID;
    await destroyTestContext(ctx);
  });

  async function addCustomer(name, balance, extra = {}) {
    const row = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit, no_credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, `C-${Date.now()}-${Math.random()}`, balance, balance, extra.credit_limit ?? 0, extra.no_credit ? 1 : 0]
    );
    return row.lastID;
  }

  async function requestCash(customerId, amount, key, notes = "صرف نقد") {
    return request(ctx.app)
      .post("/api/v1/customer-cash-debt-requests")
      .set(authHeader(cashierToken))
      .send({ customer_id: customerId, amount, notes, idempotency_key: key });
  }

  function telegram(action, requestId, chatId = managerChatId) {
    return handleTelegramUpdate(ctx.db, {
      callback_query: {
        id: `cq-cash-${action}-${requestId}-${Math.random()}`,
        data: `cashdebt:${action}:${requestId}`,
        message: { chat: { id: Number(chatId) }, message_id: 41 },
        from: { id: Number(chatId) },
      },
    });
  }

  test("pending request does not change debt or drawer", async () => {
    const customerId = await addCustomer("عميل انتظار", 100);
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const res = await requestCash(customerId, 30, "cash-debt-pending-aaaa");
    expect(res.status).toBe(201);
    expect(unwrap(res).status).toBe("pending");
    const customer = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(customer.balance)).toBe(100);
    const drawer = await computeExpectedDrawer(ctx.db, shift.id, 200);
    expect(drawer.expected_cash).toBe(200);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'",
      [shift.id]
    );
    expect(Number(moves.n)).toBe(0);
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("approved 30 raises debt and lowers drawer once, and a receipt settles it", async () => {
    const customerId = await addCustomer("عميل صرف", 100);
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const salesBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);
    const created = await requestCash(customerId, 30, "cash-debt-approve-bbbb", "ملاحظة صرف");
    expect(created.status).toBe(201);
    const requestId = unwrap(created).request_id;
    const sent = global.fetch.mock.calls.map((call) => JSON.parse(call[1].body).text).join("\n");
    expect(sent).toContain("طلب ذمة نقدية لعميل");
    expect(sent).toContain("عميل صرف");
    expect(sent).toContain("30.00");

    const approved = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    expect(unwrap(approved).request.status).toBe("approved");

    const customer = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(customer.balance)).toBe(130);
    const drawer = await computeExpectedDrawer(ctx.db, shift.id, 200);
    const visa = await computeShiftVisa(ctx.db, shift.id);
    expect(drawer.expected_cash).toBe(170);
    expect(drawer.sales_cash_nis).toBe(0);
    expect(visa.visa_sales).toBe(0);
    const moves = await ctx.db.all(
      "SELECT amount FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'",
      [shift.id]
    );
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].amount)).toBe(-30);
    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(Number(detail.summary.customer_cash_debts_total)).toBe(30);
    expect(Number(detail.summary.expected)).toBe(170);
    expect(Number(detail.summary.cash_sales)).toBe(0);
    const full = await ctx.db.get("SELECT * FROM customers WHERE id = ?", [customerId]);
    const ledger = await buildCustomerLedger(ctx.db, full);
    const debtEvent = ledger.events.find((row) => row.ev_type === "cash_debt");
    expect(debtEvent).toBeTruthy();
    expect(Number(debtEvent.debit)).toBe(30);
    expect(ledger.closing_balance).toBe(130);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(salesBefore);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );

    const again = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(again.status).toBe(200);
    expect(unwrap(again).replayed).toBe(true);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(130);

    const draft = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: "receipt",
        lines: [{ line_type: "cash", amount: 30, currency: "NIS", customer_id: customerId }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/vouchers/${unwrap(draft).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(100);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(salesBefore);
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("rejection posts nothing", async () => {
    const customerId = await addCustomer("عميل رفض", 100);
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const created = await requestCash(customerId, 30, "cash-debt-reject-cccc");
    const requestId = unwrap(created).request_id;
    const rejected = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(rejected.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(100);
    expect((await computeExpectedDrawer(ctx.db, shift.id, 200)).expected_cash).toBe(200);
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("concurrent approvals post once", async () => {
    const customerId = await addCustomer("عميل تزامن", 100);
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const created = await requestCash(customerId, 30, "cash-debt-race-dddd");
    const requestId = unwrap(created).request_id;
    const [a, b] = await Promise.all([
      request(ctx.app)
        .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
      request(ctx.app)
        .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(130);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'",
      [shift.id]
    );
    expect(Number(moves.n)).toBe(1);
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("cashier, accountant without permission, and a foreign Telegram chat cannot approve", async () => {
    const customerId = await addCustomer("عميل صلاحية", 40);
    await startShift(ctx.app, cashierToken, ctx.db, 200);
    const created = await requestCash(customerId, 10, "cash-debt-auth-eeee");
    const requestId = unwrap(created).request_id;
    const cashierTry = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(cashierToken))
      .send({ status: "approved" });
    expect(cashierTry.status).toBe(403);

    const accountant = await createAccountantUser(ctx.db, {
      username: "acct-no-zimma",
      permissions: { on_account_approvals: false },
    });
    const acctToken = (await login(ctx.app, accountant.username, accountant.password, "office")).body.token;
    const acctTry = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(acctToken))
      .send({ status: "approved" });
    expect(acctTry.status).toBe(403);

    const denied = await telegram("approve", requestId, "111");
    expect(denied.action).toBe("denied");
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(40);

    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashierId]
    );
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("credit limit needs an office override and no-credit is blocked", async () => {
    const limited = await addCustomer("عميل حد", 100, { credit_limit: 110 });
    await startShift(ctx.app, cashierToken, ctx.db, 200);
    const created = await requestCash(limited, 30, "cash-debt-limit-ffff");
    expect(created.status).toBe(201);
    const requestId = unwrap(created).request_id;
    const fromTelegram = await telegram("approve", requestId);
    expect(fromTelegram.action).toBe("needs_office_override");
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [limited])).balance)).toBe(100);

    const blocked = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("CREDIT_LIMIT_EXCEEDED");

    const allowed = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved", override_credit_limit: true });
    expect(allowed.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [limited])).balance)).toBe(130);

    const blockedCustomer = await addCustomer("عميل ممنوع", 0, { no_credit: true });
    const noCredit = await requestCash(blockedCustomer, 5, "cash-debt-nocredit-gggg");
    expect(noCredit.status).toBe(400);
    expect(noCredit.body.code).toBe("CREDIT_BLOCKED");

    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashierId]
    );
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });

  test("a closed shift is not posted, including a close race", async () => {
    const customerId = await addCustomer("عميل إغلاق", 100);
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const created = await requestCash(customerId, 30, "cash-debt-closed-hhhh");
    const requestId = unwrap(created).request_id;
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
    const late = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(late.status).toBe(400);
    expect(late.body.code).toBe("SHIFT_CLOSED");
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(100);

    const open = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const raceCustomer = await addCustomer("عميل سباق إغلاق", 50);
    const raceCreated = await requestCash(raceCustomer, 10, "cash-debt-close-race-iiii");
    const raceId = unwrap(raceCreated).request_id;
    const [ended, decided] = await Promise.all([
      request(ctx.app).post(`/api/v1/shifts/${open.id}/end`).set(authHeader(cashierToken)).send({}),
      request(ctx.app)
        .put(`/api/v1/customer-cash-debt-requests/${raceId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
    ]);
    const balance = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [raceCustomer])).balance);
    const moves = Number(
      (
        await ctx.db.get(
          "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'",
          [open.id]
        )
      ).n
    );
    if (decided.status === 200 && unwrap(decided).request?.status === "approved") {
      expect(balance).toBe(60);
      expect(moves).toBe(1);
      expect(ended.status).toBeLessThan(500);
    } else {
      expect(decided.body.code).toBe("SHIFT_CLOSED");
      expect(balance).toBe(50);
      expect(moves).toBe(0);
    }
    const live = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [open.id]);
    if (live.status === "open") {
      await request(ctx.app).post(`/api/v1/shifts/${open.id}/end`).set(authHeader(cashierToken)).send({});
    }
  });

  test("employee accounts stay out of the customer list", async () => {
    const empCustomer = await ctx.db.run(
      "INSERT INTO customers (name, customer_code, balance) VALUES ('ذمة موظف', 'C-EMP-CASH', 40)"
    );
    await ctx.db.run("INSERT INTO employees (name, active, customer_id) VALUES ('موظف مربوط', 1, ?)", [
      empCustomer.lastID,
    ]);
    await startShift(ctx.app, cashierToken, ctx.db, 50);
    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/pos/customers").set(authHeader(cashierToken))).body
    );
    expect(listed.find((row) => row.id === empCustomer.lastID)).toBeUndefined();
    const denied = await requestCash(empCustomer.lastID, 5, "cash-debt-employee-jjjj");
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("EMPLOYEE_ACCOUNT");
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashierId]
    );
    await request(ctx.app).post(`/api/v1/shifts/${shift.id}/end`).set(authHeader(cashierToken)).send({});
  });
});
