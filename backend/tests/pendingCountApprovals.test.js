import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createTestEmployee,
  createAccountantUser,
  telegramMemberFetch,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { processPolledUpdate } from "../services/telegramPollRecovery.js";
import { approveRefundRequest } from "../services/refundRequestService.js";
import { approveOnAccountRequest } from "../services/onAccountRequestService.js";
import { PENDING_COUNT_ALERT, CLOSED_SHIFT_ALERT } from "../services/originatingShiftDecision.js";

const CHAT = "6096292831";
const ACTOR = { id: 555001, first_name: "مدير", last_name: "الجرد" };

function unwrap(body) {
  return body?.data ?? body;
}

describe("pending-count approvals stay on the originating shift", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let adminUser;
  let originalFetch;
  const answers = [];

  beforeAll(async () => {
    process.env.TELEGRAM_REFUND_BOT_TOKEN = "pc-refund-token";
    process.env.TELEGRAM_REFUND_CHAT_ID = CHAT;
    process.env.TELEGRAM_REFUND_WEBHOOK_SECRET = "pc-refund-secret";
    process.env.TELEGRAM_ZIMMA_BOT_TOKEN = "pc-zimma-token";
    process.env.TELEGRAM_ZIMMA_CHAT_ID = CHAT;
    process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET = "pc-zimma-secret";
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "pc-sulaf-token";
    process.env.TELEGRAM_SULAF_CHAT_ID = CHAT;
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "pc-sulaf-secret";
    originalFetch = global.fetch;
    const base = telegramMemberFetch({ messageId: 77, memberStatus: "member" });
    global.fetch = async (url, opts) => {
      if (opts?.body && String(url).includes("answerCallbackQuery")) {
        try {
          answers.push(JSON.parse(opts.body).text);
        } catch {
          /* ignore */
        }
      }
      return base(url, opts);
    };
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminUser = await ctx.db.get("SELECT id, username, role FROM users WHERE username = 'testadmin'");
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    delete process.env.TELEGRAM_REFUND_CHAT_ID;
    delete process.env.TELEGRAM_REFUND_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_ZIMMA_BOT_TOKEN;
    delete process.env.TELEGRAM_ZIMMA_CHAT_ID;
    delete process.env.TELEGRAM_ZIMMA_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_SULAF_BOT_TOKEN;
    delete process.env.TELEGRAM_SULAF_CHAT_ID;
    delete process.env.TELEGRAM_SULAF_WEBHOOK_SECRET;
    await destroyTestContext(ctx);
  });

  async function startShift() {
    const open = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = (SELECT id FROM users WHERE username = 'testcashier') AND status = 'open'"
    );
    if (open) await endShift(open.id);
    const res = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(res.status).toBe(201);
    const shift = await ctx.db.get(
      "SELECT * FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    );
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 500 WHERE id = ?", [shift.id]);
    return { ...shift, opening_cash: 500 };
  }

  async function endShift(shiftId) {
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(res.status).toBe(200);
    expect(unwrap(res.body).status).toBe("pending_count");
  }

  async function sale(method) {
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
          payment_method: method,
        })
      );
    expect([200, 201]).toContain(res.status);
    return unwrap(res.body).transaction_id;
  }

  async function refundRequest(txId, method) {
    const res = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: method,
        reason: "جرد",
      });
    expect(res.status).toBe(201);
    return unwrap(res.body).request_id;
  }

  async function customer() {
    const row = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit, no_credit)
       VALUES ('عميل جرد', ?, 0, 0, 100000, 0)`,
      [`PC-${Date.now()}-${Math.random()}`]
    );
    return row.lastID;
  }

  async function zimma(customerId) {
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
          payment_method: "on_account",
          customer_id: customerId,
        })
      );
    expect(res.status).toBe(202);
    return unwrap(res.body).request_id;
  }

  async function debt(customerId, n) {
    const res = await request(ctx.app)
      .post("/api/v1/customer-cash-debt-requests")
      .set(authHeader(cashierToken))
      .send({
        customer_id: customerId,
        amount: 15,
        notes: "جرد",
        idempotency_key: `pc-debt-${n}-${Date.now()}`,
      });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    return body.request_id ?? body.row?.id ?? body.request?.id;
  }

  async function advance(employeeId) {
    const res = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 20, notes: "جرد" });
    expect(res.status).toBe(201);
    return unwrap(res.body).request_id;
  }

  function callback(kind, action, requestId) {
    return {
      update_id: 9000 + requestId,
      callback_query: {
        id: `cq-${kind}-${action}-${requestId}`,
        data: `${kind}:${action}:${requestId}`,
        message: { message_id: 77, chat: { id: Number(CHAT) } },
        from: ACTOR,
      },
    };
  }

  async function telegram(kind, action, requestId) {
    answers.length = 0;
    const result = await handleTelegramUpdate(ctx.db, callback(kind, action, requestId));
    return { result, answer: answers.at(-1) || null };
  }

  test("an open shift still approves a cash refund from Telegram and a visa refund from the office", async () => {
    const shift = await startShift();
    const cashId = await refundRequest(await sale("cash"), "cash");
    const visaId = await refundRequest(await sale("visa"), "visa");
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);

    const approved = await telegram("refund", "approve", cashId);
    expect(approved.result.action).toBe("approve");
    const cashRefund = await ctx.db.get(
      "SELECT shift_id FROM refunds WHERE id = (SELECT refund_id FROM refund_requests WHERE id = ?)",
      [cashId]
    );
    expect(Number(cashRefund.shift_id)).toBe(Number(shift.id));

    const visa = await request(ctx.app)
      .put(`/api/v1/refund-requests/${visaId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(visa.status).toBe(200);
    const visaRefund = await ctx.db.get(
      "SELECT shift_id, payment_method FROM refunds WHERE id = (SELECT refund_id FROM refund_requests WHERE id = ?)",
      [visaId]
    );
    expect(visaRefund.payment_method).toBe("visa");
    expect(Number(visaRefund.shift_id)).toBe(Number(shift.id));
    const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(stockAfter).toBe(stockBefore + 2);

    const officeRejectId = await refundRequest(await sale("cash"), "cash");
    const officeRejected = await request(ctx.app)
      .put(`/api/v1/refund-requests/${officeRejectId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(officeRejected.status).toBe(200);
    const telegramRejectId = await refundRequest(await sale("visa"), "visa");
    const telegramRejected = await telegram("refund", "reject", telegramRejectId);
    expect(telegramRejected.result.action).toBe("reject");
    const leftOpen = await ctx.db.all(
      "SELECT handover_disposition FROM refund_requests WHERE id IN (?, ?)",
      [officeRejectId, telegramRejectId]
    );
    expect(leftOpen.every((row) => row.handover_disposition == null)).toBe(true);
    await endShift(shift.id);
  });

  test("Telegram alerts on pending_count and closed shifts without posting or retrying", async () => {
    const shift = await startShift();
    const customerId = await customer();
    const employee = await createTestEmployee(ctx.db, { name: "موظف تنبيه" });
    const ids = {
      refund: await refundRequest(await sale("cash"), "cash"),
      visa: await refundRequest(await sale("visa"), "visa"),
      zimma: await zimma(customerId),
      debt: await debt(customerId, 1),
      advance: await advance(employee.id),
    };
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    await endShift(shift.id);

    for (const [kind, id] of [
      ["refund", ids.refund],
      ["refund", ids.visa],
      ["zimma", ids.zimma],
      ["cashdebt", ids.debt],
      ["sulaf", ids.advance],
    ]) {
      const approve = await telegram(kind, "approve", id);
      const reject = await telegram(kind, "reject", id);
      expect(approve.result.action).toBe("shift_pending_count");
      expect(approve.answer).toBe(PENDING_COUNT_ALERT);
      expect(reject.result.action).toBe("shift_pending_count");
      expect(reject.answer).toBe(PENDING_COUNT_ALERT);
    }

    const polled = await processPolledUpdate(ctx.db, "refund", callback("refund", "approve", ids.refund));
    expect(polled.advanced).toBe(true);
    expect(polled.skipped).toBe(false);
    expect(polled.result.action).toBe("shift_pending_count");

    const webhook = await request(ctx.app)
      .post("/api/v1/telegram/webhook/pc-refund-secret")
      .send(callback("refund", "reject", ids.refund));
    expect(webhook.status).toBe(200);
    expect(unwrap(webhook.body).ok).toBe(true);

    const still = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [ids.refund]);
    expect(still.status).toBe("pending");
    const movements = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type IN ('refund', 'advance', 'customer_cash_debt')",
      [shift.id]
    );
    expect(Number(movements.n)).toBe(0);
    const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(stockAfter).toBe(stockBefore);

    await ctx.db.run(
      "UPDATE cashier_shifts SET status = 'closed', closing_cash = 1, expected_cash = 1, variance = 0 WHERE id = ?",
      [shift.id]
    );
    const closedTap = await telegram("refund", "approve", ids.refund);
    expect(closedTap.result.action).toBe("shift_closed_reconcile");
    expect(closedTap.answer).toBe(CLOSED_SHIFT_ALERT);
    const report = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/shifts/closed-pending-requests")
          .set(authHeader(adminToken))
      ).body
    );
    expect(report.requests.some((row) => Number(row.request_id) === Number(ids.refund) && Number(row.shift_id) === Number(shift.id))).toBe(
      true
    );
    const saved = await ctx.db.get(
      "SELECT status, expected_cash, variance, closing_cash FROM cashier_shifts WHERE id = ?",
      [shift.id]
    );
    expect(saved.status).toBe("closed");
    expect(Number(saved.expected_cash)).toBe(1);
    expect(Number(saved.closing_cash)).toBe(1);
    expect(Number(saved.variance)).toBe(0);
  });

  test("office approval on pending_count posts to the originating shift even if a newer shift is open", async () => {
    const shift = await startShift();
    const customerId = await customer();
    const employee = await createTestEmployee(ctx.db, { name: "موظف ترحيل" });
    const cashId = await refundRequest(await sale("cash"), "cash");
    const visaId = await refundRequest(await sale("visa"), "visa");
    const zimmaId = await zimma(customerId);
    const debtId = await debt(customerId, 2);
    const advanceId = await advance(employee.id);
    const day = shift.business_day;
    await endShift(shift.id);
    const newer = await startShift();

    for (const [path, id] of [
      ["/api/v1/refund-requests", cashId],
      ["/api/v1/refund-requests", visaId],
      ["/api/v1/on-account-requests", zimmaId],
      ["/api/v1/customer-cash-debt-requests", debtId],
      ["/api/v1/advance-requests", advanceId],
    ]) {
      const res = await request(ctx.app).put(`${path}/${id}`).set(authHeader(adminToken)).send({ status: "approved" });
      expect(res.status).toBe(200);
      const again = await request(ctx.app).put(`${path}/${id}`).set(authHeader(adminToken)).send({ status: "approved" });
      if (again.status === 200) expect(unwrap(again.body).replayed).toBe(true);
      else expect(again.status).toBe(400);
    }

    const cashMove = await ctx.db.get(
      `SELECT m.shift_id, m.amount FROM shift_cash_movements m
       JOIN refunds r ON r.id = m.refund_id
       JOIN refund_requests q ON q.refund_id = r.id
       WHERE q.id = ?`,
      [cashId]
    );
    expect(Number(cashMove.shift_id)).toBe(Number(shift.id));
    expect(Number(cashMove.amount)).toBe(-10);
    const cashCount = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM shift_cash_movements m
       JOIN refunds r ON r.id = m.refund_id
       WHERE r.id = (SELECT refund_id FROM refund_requests WHERE id = ?)`,
      [cashId]
    );
    expect(Number(cashCount.n)).toBe(1);

    const visaRefund = await ctx.db.get(
      "SELECT shift_id, business_day, payment_method FROM refunds WHERE id = (SELECT refund_id FROM refund_requests WHERE id = ?)",
      [visaId]
    );
    expect(visaRefund.payment_method).toBe("visa");
    expect(Number(visaRefund.shift_id)).toBe(Number(shift.id));
    expect(visaRefund.business_day).toBe(day);
    const visaMove = await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements WHERE refund_id = (SELECT refund_id FROM refund_requests WHERE id = ?)", [
      visaId,
    ]);
    expect(Number(visaMove.n)).toBe(0);

    const saleRow = await ctx.db.get(
      `SELECT t.shift_id, s.business_day FROM transactions t
       JOIN on_account_requests o ON o.transaction_id = t.id
       JOIN cashier_shifts s ON s.id = t.shift_id
       WHERE o.id = ?`,
      [zimmaId]
    );
    expect(Number(saleRow.shift_id)).toBe(Number(shift.id));
    expect(saleRow.business_day).toBe(day);
    const saleCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transactions t JOIN on_account_requests o ON o.transaction_id = t.id WHERE o.id = ?",
      [zimmaId]
    );
    expect(Number(saleCount.n)).toBe(1);

    const debtMove = await ctx.db.get(
      `SELECT m.shift_id, v.voucher_date FROM shift_cash_movements m
       JOIN vouchers v ON v.id = m.voucher_id
       JOIN customer_cash_debt_requests r ON r.voucher_id = v.id
       WHERE r.id = ?`,
      [debtId]
    );
    expect(Number(debtMove.shift_id)).toBe(Number(shift.id));
    expect(String(debtMove.voucher_date).slice(0, 10)).toBe(String(day).slice(0, 10));
    const debtCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE voucher_id = (SELECT voucher_id FROM customer_cash_debt_requests WHERE id = ?)",
      [debtId]
    );
    expect(Number(debtCount.n)).toBe(1);

    const advMove = await ctx.db.get(
      "SELECT shift_id, amount FROM shift_cash_movements WHERE advance_request_id = ?",
      [advanceId]
    );
    expect(Number(advMove.shift_id)).toBe(Number(shift.id));
    expect(Number(advMove.amount)).toBe(-20);
    const advCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE advance_request_id = ?",
      [advanceId]
    );
    expect(Number(advCount.n)).toBe(1);

    const newerMoves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type IN ('refund', 'advance', 'customer_cash_debt', 'payment')",
      [newer.id]
    );
    expect(Number(newerMoves.n)).toBe(0);
    await endShift(newer.id);
  });

  test("rejection records the handover, and an accepted loss can be counted without looking balanced", async () => {
    const shift = await startShift();
    const refundId = await refundRequest(await sale("cash"), "cash");
    await endShift(shift.id);

    const missing = await request(ctx.app)
      .put(`/api/v1/refund-requests/${refundId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("HANDOVER_DISPOSITION_REQUIRED");

    const rejected = await request(ctx.app)
      .put(`/api/v1/refund-requests/${refundId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", handover_disposition: "outstanding" });
    expect(rejected.status).toBe(200);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'refund'",
      [shift.id]
    );
    expect(Number(moves.n)).toBe(0);

    const blocked = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: 510 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("COUNT_BLOCKED");

    const detailBlocked = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(detailBlocked.count_blocked).toBe(true);
    expect(detailBlocked.summary.balanced).toBe(false);
    expect(detailBlocked.pending_requests).toHaveLength(0);

    const accepted = await request(ctx.app)
      .post(`/api/v1/refund-requests/${refundId}/handover`)
      .set(authHeader(adminToken))
      .send({ disposition: "loss_accepted" });
    expect(accepted.status).toBe(200);

    const before = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(before.summary.balanced).toBe(false);
    expect(before.count_blocked).toBe(false);
    const saved = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: before.summary.expected });
    expect([200, 202]).toContain(saved.status);
    const after = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(after.shift.status).toBe("closed");
    expect(after.summary.balanced).toBe(false);
    expect(after.handover_discrepancies.some((row) => row.disposition === "loss_accepted")).toBe(true);
  });

  test("marking the handover returned allows a count, and viewing the popup does not grant approval", async () => {
    const shift = await startShift();
    const refundId = await refundRequest(await sale("cash"), "cash");
    await endShift(shift.id);
    const viewer = await createAccountantUser(ctx.db, {
      username: "shiftviewer",
      permissions: { shift_audit: true },
    });
    const viewerToken = (await login(ctx.app, viewer.username, viewer.password, "office")).body.token;

    const rejected = await request(ctx.app)
      .put(`/api/v1/refund-requests/${refundId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", handover_disposition: "outstanding" });
    expect(rejected.status).toBe(200);

    const seen = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(viewerToken))).body
    );
    expect(seen.handover_discrepancies[0].can_decide).toBe(false);
    const denied = await request(ctx.app)
      .post(`/api/v1/refund-requests/${refundId}/handover`)
      .set(authHeader(viewerToken))
      .send({ disposition: "returned" });
    expect(denied.status).toBe(403);

    const returned = await request(ctx.app)
      .post(`/api/v1/refund-requests/${refundId}/handover`)
      .set(authHeader(adminToken))
      .send({ disposition: "returned" });
    expect(returned.status).toBe(200);
    const ready = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(ready.summary.balanced).toBe(true);
    expect(ready.count_blocked).toBe(false);
    const saved = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: ready.summary.expected });
    expect([200, 202]).toContain(saved.status);
  });

  test("a count and an approval cannot both leave a pending request on a closed shift", async () => {
    const shift = await startShift();
    const refundId = await refundRequest(await sale("cash"), "cash");
    await endShift(shift.id);
    const [approved, counted] = await Promise.all([
      request(ctx.app)
        .put(`/api/v1/refund-requests/${refundId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
      request(ctx.app)
        .post(`/api/v1/shifts/${shift.id}/reconcile`)
        .set(authHeader(adminToken))
        .send({ closing_cash: 490 }),
    ]);
    const row = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [refundId]);
    const live = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shift.id]);
    const posted = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refunds WHERE id = (SELECT refund_id FROM refund_requests WHERE id = ?)",
      [refundId]
    );
    expect(Number(posted.n)).toBeLessThanOrEqual(1);
    if (row.status === "pending") expect(live.status).not.toBe("closed");
    if (live.status === "closed") expect(row.status).not.toBe("pending");
    expect([200, 400, 409]).toContain(approved.status);
    expect([200, 202, 409]).toContain(counted.status);
    if (live.status === "open") await endShift(shift.id);
  });

  test("a visa refund rejection is a goods discrepancy and does not move drawer cash", async () => {
    const shift = await startShift();
    const visaId = await refundRequest(await sale("visa"), "visa");
    await endShift(shift.id);
    const rejected = await request(ctx.app)
      .put(`/api/v1/refund-requests/${visaId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", handover_disposition: "outstanding" });
    expect(rejected.status).toBe(200);
    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(detail.handover_discrepancies[0].cash_amount).toBeNull();
    expect(detail.handover_discrepancies[0].goods.length).toBeGreaterThan(0);
    expect(detail.count_blocked).toBe(true);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'refund'",
      [shift.id]
    );
    expect(Number(moves.n)).toBe(0);
    const blocked = await request(ctx.app)
      .post(`/api/v1/shifts/${shift.id}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: detail.summary.expected });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("COUNT_BLOCKED");
  });

  test("a posting failure rolls the decision back", async () => {
    const shift = await startShift();
    const customerId = await customer();
    const refundId = await refundRequest(await sale("cash"), "cash");
    const zimmaId = await zimma(customerId);
    await endShift(shift.id);
    const manager = { ...adminUser, failAfterPost: true };
    await expect(
      approveRefundRequest(ctx.db, refundId, manager, null, null, "admin")
    ).rejects.toMatchObject({ code: "FORCED_ROLLBACK" });
    await expect(
      approveOnAccountRequest(ctx.db, zimmaId, manager, null, null, "admin")
    ).rejects.toMatchObject({ code: "FORCED_ROLLBACK" });
    expect((await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [refundId])).status).toBe("pending");
    expect((await ctx.db.get("SELECT status FROM on_account_requests WHERE id = ?", [zimmaId])).status).toBe("pending");
    expect(
      Number(
        (
          await ctx.db.get(
            "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'refund'",
            [shift.id]
          )
        ).n
      )
    ).toBe(0);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions WHERE shift_id = ? AND payment_method = 'on_account'", [shift.id])).n)
    ).toBe(0);
  });
});
