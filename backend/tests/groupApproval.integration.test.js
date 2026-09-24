import { jest } from "@jest/globals";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
} from "./helpers.js";
import { claimNextPrintJob } from "../services/operationPrintService.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { computeExpectedCash } from "../utils/salePayments.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("group approval flows", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let adminId;
  let categoryId;
  let supplierId;
  const prev = {};

  beforeAll(async () => {
    for (const key of ["TELEGRAM_APPROVALS_BOT_TOKEN", "TELEGRAM_APPROVALS_CHAT_ID", "TELEGRAM_APPROVALS_USER_IDS"]) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
    global.fetch = jest.fn(async () => {
      throw new Error("live Telegram must not be called");
    });
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"])).id;
    adminId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"])).id;
    const cat = await ctx.db.run(
      "INSERT INTO expense_categories (name, name_ar, active) VALUES ('rent', 'إيجار', 1)"
    );
    categoryId = cat.lastID;
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد موافقة', 'S-APR', 200, 200)"
    );
    supplierId = sup.lastID;
  });

  afterAll(async () => {
    for (const key of Object.keys(prev)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.db.run("DELETE FROM operation_print_jobs");
  });

  test("missing credentials keep an expense pending and startup config stays empty", async () => {
    const before = (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n;
    const res = await request(ctx.app)
      .post("/api/v1/expense-requests")
      .set(authHeader(adminToken))
      .send({
        category_id: categoryId,
        amount: 15,
        paid_on: "2026-09-24",
        payment_method: "cash",
        reference_note: "إيجار يوم",
        idempotency_key: "exp-req-pending-aaaa",
      });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    expect(body.pending_approval).toBe(true);
    expect(body.telegram).toBe(false);
    expect(body.operating_expense_id).toBeNull();
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)).toBe(Number(before));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("expense approval posts once, prints a receipt, and blocks a duplicate decision", async () => {
    const created = unwrap(
      (
        await request(ctx.app).post("/api/v1/expense-requests").set(authHeader(adminToken)).send({
          category_id: categoryId,
          amount: 20,
          paid_on: "2026-09-24",
          payment_method: "cash",
          idempotency_key: "exp-req-approve-bbbb",
        })
      ).body
    );
    const replay = await request(ctx.app).post("/api/v1/expense-requests").set(authHeader(adminToken)).send({
      category_id: categoryId,
      amount: 20,
      paid_on: "2026-09-24",
      payment_method: "cash",
      idempotency_key: "exp-req-approve-bbbb",
    });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).request_id).toBe(created.request_id);

    const limited = await createAccountantUser(ctx.db, {
      username: "noexpense",
      password: "acctpass123",
      permissions: { expenses: false, suppliers: true },
    });
    const limitedToken = (await login(ctx.app, limited.username, limited.password)).body.token;
    const denied = await request(ctx.app)
      .post(`/api/v1/expense-requests/${created.request_id}/approve`)
      .set(authHeader(limitedToken));
    expect(denied.status).toBe(403);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source_id = ?", [created.request_id])).n)).toBe(0);

    const approved = await request(ctx.app)
      .post(`/api/v1/expense-requests/${created.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    const again = await request(ctx.app)
      .post(`/api/v1/expense-requests/${created.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(again.status).toBe(409);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'expense_approval' AND source_id = ?", [created.request_id])).n)
    ).toBe(1);

    const slip = await claimNextPrintJob(ctx.db, adminId);
    expect(slip.kind).toBe("expense_approval");
    expect(slip.receipt_html).toContain("مصروف معتمد");
    expect(slip.receipt_html).toContain("20.00");
  });

  test("supplier payment does not move cash until approval, then prints once", async () => {
    const start = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(start.status).toBe(201);
    const beforeBal = Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance);
    const res = await request(ctx.app).post("/api/v1/pos/supplier-payments").set(authHeader(cashierToken)).send({
      supplier_id: supplierId,
      amount: 40,
      notes: "دفعة بانتظار الموافقة",
      idempotency_key: "sup-req-approve-cccc",
    });
    expect(res.status).toBe(201);
    const pending = unwrap(res.body);
    expect(pending.pending_approval).toBe(true);
    expect(pending.voucher_id).toBeNull();
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(beforeBal);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'supplier_payment' AND shift_id = ?", [pending.shift_id])).n)
    ).toBe(0);

    const rejectedUser = await createAccountantUser(ctx.db, {
      username: "nosupplier",
      password: "acctpass123",
      permissions: { expenses: true, suppliers: false },
    });
    const rejectedToken = (await login(ctx.app, rejectedUser.username, rejectedUser.password)).body.token;
    const denied = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${pending.request_id}/approve`)
      .set(authHeader(rejectedToken));
    expect(denied.status).toBe(403);

    const approved = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${pending.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    expect(Number(unwrap(approved.body).amount)).toBe(40);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(beforeBal - 40);
    const duplicate = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${pending.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(duplicate.status).toBe(409);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'supplier_payment' AND shift_id = ?", [pending.shift_id])).n)
    ).toBe(1);

    const slip = await claimNextPrintJob(ctx.db, cashierId);
    expect(slip.kind).toBe("supplier_payment");
    expect(slip.receipt_html).toContain("دفع لمورد");
    expect(slip.receipt_html).toContain("40.00");
  });

  test("POS ₪30 against debt ₪100 and expected cash ₪200 posts once after approval", async () => {
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE cashier_id = ? AND status = 'open'", [
      cashierId,
    ]);
    const start = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(start.status).toBe(201);
    const shiftId = unwrap(start.body).shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 200 WHERE id = ?", [shiftId]);
    await ctx.db.run("UPDATE suppliers SET balance = 100, opening_balance = 100 WHERE id = ?", [supplierId]);
    const created = unwrap(
      (
        await request(ctx.app).post("/api/v1/pos/supplier-payments").set(authHeader(cashierToken)).send({
          supplier_id: supplierId,
          amount: 30,
          idempotency_key: "sup-req-30-from-200",
        })
      ).body
    );
    expect(created.pending_approval).toBe(true);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(100);
    expect(await computeExpectedCash(ctx.db, shiftId, 200)).toBe(200);

    const approved = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${created.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(70);
    expect(await computeExpectedCash(ctx.db, shiftId, 200)).toBe(170);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'shop_consumption'")).n).toBe(0);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'", [shiftId])).n)
    ).toBe(1);
  });

  test("telegram approval uses the mapped account and ignores a second click", async () => {
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "approvals-test-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = "-100777";
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (String(url).includes("sendMessage")) {
        return { json: async () => ({ ok: true, result: { message_id: 77 } }) };
      }
      if (String(url).includes("editMessageText") || String(url).includes("answerCallbackQuery")) {
        return { json: async () => ({ ok: true, result: true }) };
      }
      return { json: async () => ({ ok: true, result: body }) };
    });

    const created = unwrap(
      (
        await request(ctx.app).post("/api/v1/expense-requests").set(authHeader(adminToken)).send({
          category_id: categoryId,
          amount: 8,
          paid_on: "2026-09-24",
          payment_method: "transfer",
          idempotency_key: "exp-req-telegram-dddd",
        })
      ).body
    );
    expect(created.telegram).toBe(true);
    const click = {
      callback_query: {
        id: "cq-live",
        data: `expense:approve:${created.request_id}`,
        from: { id: 555, username: "boss" },
        message: { message_id: 77, chat: { id: "-100777", type: "supergroup" } },
      },
    };
    const first = await handleTelegramUpdate(ctx.db, click, { sourceBot: "approvals" });
    expect(first.action).toBe("approve");
    const second = await handleTelegramUpdate(ctx.db, click, { sourceBot: "approvals" });
    expect(second.action).toBe("already_handled");
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source_id = ?", [created.request_id])).n)
    ).toBe(1);

    const saved = await ctx.db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [created.request_id]);
    expect(saved.telegram_actor_id).toBe("555");
    expect(saved.manager_id).toBeNull();

    const pay = unwrap(
      (
        await request(ctx.app).post("/api/v1/pos/supplier-payments").set(authHeader(cashierToken)).send({
          supplier_id: supplierId,
          amount: 11,
          notes: "من الصندوق",
          idempotency_key: "sup-req-telegram-eeee",
        })
      ).body
    );
    expect(pay.telegram).toBe(true);
    const sent = global.fetch.mock.calls.find((call) => {
      if (!String(call[0]).includes("sendMessage") || !call[1]?.body) return false;
      try {
        return JSON.parse(call[1].body).text.includes("طلب دفع لمورد");
      } catch {
        return false;
      }
    });
    expect(sent).toBeTruthy();
    const sentBody = JSON.parse(sent[1].body);
    expect(sentBody.text).toContain("11.00");
    delete process.env.TELEGRAM_APPROVALS_BOT_TOKEN;
    delete process.env.TELEGRAM_APPROVALS_CHAT_ID;
  });
});
