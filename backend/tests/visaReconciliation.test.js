import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createAccountantUser,
} from "./helpers.js";
import { allAccountantPermissionsDisabled } from "../utils/accountantPermissions.js";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";

function unwrap(res) {
  return res.body?.data !== undefined ? res.body.data : res.body;
}

async function startShift(app, token, db, opening = 200) {
  let res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  if (res.status === 409) {
    const open = await db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    );
    if (open) {
      await request(app).post(`/api/v1/shifts/${open.id}/end`).set(authHeader(token)).send({});
      res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    }
  }
  expect(res.status).toBe(201);
  const id = unwrap(res).shift_id;
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, id]);
  await db.run(
    "UPDATE shift_cash_movements SET amount = ? WHERE shift_id = ? AND movement_type = 'opening'",
    [opening, id]
  );
  return id;
}

async function sell(app, token, body, key) {
  const res = await request(app)
    .post("/api/v1/checkout")
    .set(authHeader(token))
    .send(withCheckoutKey(body, key));
  expect(res.status).toBe(201);
  return unwrap(res);
}

async function approveRefund(app, cashierToken, adminToken, transactionId, qty, paymentMethod, productId) {
  const created = await request(app)
    .post("/api/v1/refund-requests")
    .set(authHeader(cashierToken))
    .send({
      original_transaction_id: transactionId,
      lines: [{ product_id: productId, quantity: qty }],
      payment_method: paymentMethod,
      reason: "visa reconciliation",
    });
  expect(created.status).toBe(201);
  const requestId = unwrap(created).request_id;
  const approved = await request(app)
    .put(`/api/v1/refund-requests/${requestId}`)
    .set(authHeader(adminToken))
    .send({ status: "approved" });
  expect(approved.status).toBe(200);
  return unwrap(approved);
}

async function endShift(app, token, shiftId) {
  const res = await request(app).post(`/api/v1/shifts/${shiftId}/end`).set(authHeader(token)).send({});
  expect(res.status).toBe(200);
  return unwrap(res);
}

function basisOf(visa) {
  return {
    visa_sales: visa.visa_sales,
    visa_other_receipts: visa.visa_other_receipts,
    visa_refunds: visa.visa_refunds,
    visa_net: visa.visa_net,
    visa_receipt_count: visa.visa_receipt_count,
    visa_refund_count: visa.visa_refund_count,
  };
}

async function moneyFingerprint(db) {
  const pays = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM sale_payments");
  const ledger = await db.get("SELECT COUNT(*) AS n FROM inventory_ledger");
  const cash = await db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements"
  );
  return {
    payments: Number(pays.n),
    paymentSum: Number(pays.s),
    ledger: Number(ledger.n),
    cashCount: Number(cash.n),
    cashSum: Number(cash.s),
  };
}

describe("visa collections and shift reconciliation", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let otherToken;
  let product;

  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    process.env.TELEGRAM_CHAT_ID = "";
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "";
    process.env.TELEGRAM_USE_POLLING = "";
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const bcrypt = (await import("bcrypt")).default;
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["visa-other", hash]
    );
    otherToken = (await login(ctx.app, "visa-other", "cashpass123", "pos")).body.token;
    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("canonical mixed visa example agrees across count, snapshot, report, and lines", async () => {
    const shiftId = await startShift(ctx.app, cashierToken, ctx.db, 500);
    const visaSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 12, price: product.price }],
      payment_method: "visa",
    });
    const mixed = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 10, price: product.price }],
      payment_method: "mixed",
      payments: [
        { method: "cash", amount: 70 },
        { method: "visa", amount: 30 },
      ],
    });
    const cashSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
      payment_method: "cash",
    });
    await approveRefund(ctx.app, cashierToken, adminToken, visaSale.transaction_id, 1, "visa", ctx.productId);
    await approveRefund(ctx.app, cashierToken, adminToken, visaSale.transaction_id, 1, "cash", ctx.productId);

    const customer = await ctx.db.run(
      "INSERT INTO customers (name, balance, credit_limit) VALUES ('عميل فيزا', 0, 1000)"
    );
    const onAccount = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, customer_id, status, store_id)
       VALUES (?, '[]', 25, 0, 25, 0, 'on_account', ?, ?, 'completed', 1)`,
      [
        (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id,
        shiftId,
        customer.lastID,
      ]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'on_account', 25, 1, 25)`,
      [onAccount.lastID]
    );
    await ctx.db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
       VALUES (?, 'customer_collection', 25, 'قبض نقدي')`,
      [shiftId]
    );

    const mixedPays = await ctx.db.all(
      "SELECT payment_method, amount FROM sale_payments WHERE transaction_id = ?",
      [mixed.transaction_id]
    );
    expect(Number(mixedPays.find((row) => row.payment_method === "cash").amount)).toBe(70);
    expect(Number(mixedPays.find((row) => row.payment_method === "visa").amount)).toBe(30);

    const detail = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(adminToken))
    );
    expect(detail.shift.visa_sales).toBe(150);
    expect(detail.shift.visa_other_receipts).toBe(0);
    expect(detail.shift.visa_refunds).toBe(10);
    expect(detail.shift.visa_net).toBe(140);
    expect(detail.shift.visa_receipt_count).toBe(2);
    expect(detail.shift.visa_refund_count).toBe(1);
    expect(detail.shift.visa_reconciliation.state).toBe("awaiting");
    expect(detail.shift.visa_reconciliation.status_label).toBe("بانتظار المطابقة");
    expect(detail.summary.cash_sales).toBe(80);

    const before = await moneyFingerprint(ctx.db);
    const ended = await endShift(ctx.app, cashierToken, shiftId);
    expect(ended.visa_net).toBe(140);
    expect(ended.status).toBe("pending_count");

    const recon = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({
        counted_currencies: [{ currency_code: "NIS", amount: ended.expected_cash }],
        visa_machine_net: 135,
        visa_basis: basisOf(ended),
      });
    expect(recon.status).toBe(200);
    const saved = unwrap(recon);
    expect(saved.visa_reconciliation.saved.net).toBe(140);
    expect(saved.visa_reconciliation.saved.machine_net).toBe(135);
    expect(saved.visa_reconciliation.saved.difference).toBe(-5);
    expect(saved.visa_reconciliation.status_label).toBe("ناقص 5");
    expect(saved.visa_reconciliation.saved.counted_by).toBeTruthy();
    expect(saved.visa_reconciliation.saved.counted_at).toBeTruthy();

    const row = await ctx.db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(row.visa_expected_net).toBe(140);
    expect(row.visa_machine_net).toBe(135);
    expect(row.visa_difference).toBe(-5);
    expect(row.status).toBe("closed");

    const day = row.business_day;
    const report = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: day, to: day, shift_id: shiftId })
        .set(authHeader(adminToken))
    );
    const listed = report.shifts.find((item) => item.shift_id === shiftId);
    expect(listed.expected_net).toBe(140);
    expect(listed.machine_net).toBe(135);
    expect(listed.difference).toBe(-5);
    expect(listed.receipt_count).toBe(2);
    expect(listed.refund_count).toBe(1);
    expect(listed.sales).toBe(150);
    expect(listed.refunds).toBe(10);
    expect(report.summary.expected_net).toBe(140);
    expect(report.summary.machine_net).toBe(135);
    expect(report.summary.difference).toBe(-5);
    expect(report.summary.awaiting_expected_net).toBe(0);

    const summary = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa-summary")
        .query({ from: day, to: day })
        .set(authHeader(adminToken))
    );
    expect(summary.summary.live_expected_net).toBe(140);
    expect(summary.summary.receipt_count).toBe(2);

    const lines = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftId}/visa-activity`).set(authHeader(adminToken))
    );
    const saleLines = lines.lines.filter((line) => line.kind === "sale");
    const refundLines = lines.lines.filter((line) => line.kind === "refund");
    expect(saleLines).toHaveLength(2);
    expect(refundLines).toHaveLength(1);
    expect(saleLines.map((line) => line.visa_amount).sort((a, b) => a - b)).toEqual([30, 120]);
    expect(refundLines[0].visa_amount).toBe(10);
    expect(refundLines[0].reversal.original_transaction_id).toBe(visaSale.transaction_id);

    const replay = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 135, visa_basis: basisOf(ended) });
    expect(replay.status).toBe(200);
    expect(unwrap(replay).idempotent).toBe(true);
    const still = await ctx.db.get(
      "SELECT visa_expected_net, visa_machine_net, visa_counted_at FROM cashier_shifts WHERE id = ?",
      [shiftId]
    );
    expect(still.visa_expected_net).toBe(140);
    expect(still.visa_counted_at).toBe(row.visa_counted_at);

    const overwrite = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 130, visa_basis: basisOf(ended) });
    expect(overwrite.status).toBe(409);
    expect(overwrite.body.code).toBe("VISA_ALREADY_RECONCILED");

    const cashBefore = await ctx.db.get(
      "SELECT status, closing_cash, expected_cash, variance, requires_approval FROM cashier_shifts WHERE id = ?",
      [shiftId]
    );
    const corrected = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-correct`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 140, reason: "خطأ إدخال" });
    expect(corrected.status).toBe(200);
    const afterCorrect = unwrap(corrected);
    expect(afterCorrect.reconciliation.saved.machine_net).toBe(140);
    expect(afterCorrect.reconciliation.saved.difference).toBe(0);
    expect(afterCorrect.reconciliation.saved.net).toBe(140);
    expect(afterCorrect.reconciliation.status_label).toBe("مطابق");
    const cashAfter = await ctx.db.get(
      "SELECT status, closing_cash, expected_cash, variance, requires_approval FROM cashier_shifts WHERE id = ?",
      [shiftId]
    );
    expect(cashAfter).toEqual(cashBefore);
    const history = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftId}/visa-corrections`).set(authHeader(adminToken))
    );
    expect(history.corrections).toHaveLength(1);
    expect(history.corrections[0].previous_machine_net).toBe(135);
    expect(history.corrections[0].revised_machine_net).toBe(140);
    expect(history.corrections[0].reason).toBe("خطأ إدخال");
    const audit = await ctx.db.get(
      "SELECT action, old_value, new_value FROM audit_logs WHERE entity_id = ? AND action = 'SHIFT_VISA_CORRECT'",
      [shiftId]
    );
    expect(audit).toBeTruthy();
    expect(audit.old_value).toContain("135");
    expect(audit.new_value).toContain("140");

    const denied = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-correct`)
      .set(authHeader(cashierToken))
      .send({ visa_machine_net: 100, reason: "لا" });
    expect(denied.status).toBe(403);

    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'visa', 15, 1, 15)`,
      [cashSale.transaction_id]
    );
    const changed = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: day, to: day, shift_id: shiftId })
        .set(authHeader(adminToken))
    );
    const changedRow = changed.shifts[0];
    expect(changedRow.expected_net).toBe(140);
    expect(changedRow.machine_net).toBe(140);
    expect(changedRow.difference).toBe(0);
    expect(changedRow.basis_changed).toBe(true);
    expect(changedRow.current.net).toBe(155);
    expect(changed.summary.basis_changed_shifts).toBe(1);

    const afterView = await moneyFingerprint(ctx.db);
    expect(afterView.ledger).toBe(before.ledger);
    expect(afterView.cashCount).toBe(before.cashCount + 1);
    expect(Number(mixedPays.find((row) => row.payment_method === "cash").amount)).toBe(70);
    void cashSale;
  });

  test("blank is awaiting, zero and negative nets are real, and uncounted shifts are not zero", async () => {
    const blankId = await startShift(ctx.app, cashierToken, ctx.db, 100);
    await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
      payment_method: "visa",
    });
    const blankEnded = await endShift(ctx.app, cashierToken, blankId);
    const blankClose = await request(ctx.app)
      .post(`/api/v1/shifts/${blankId}/reconcile`)
      .set(authHeader(adminToken))
      .send({ counted_currencies: [{ currency_code: "NIS", amount: blankEnded.expected_cash }] });
    expect(blankClose.status).toBe(200);
    const blankRow = await ctx.db.get("SELECT visa_machine_net, status FROM cashier_shifts WHERE id = ?", [blankId]);
    expect(blankRow.visa_machine_net).toBeNull();
    expect(blankRow.status).toBe("closed");
    const blankView = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${blankId}`).set(authHeader(adminToken))
    );
    expect(blankView.shift.visa_reconciliation.state).toBe("awaiting");

    const zeroId = await startShift(ctx.app, cashierToken, ctx.db, 100);
    const zeroSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
      payment_method: "visa",
    });
    await approveRefund(ctx.app, cashierToken, adminToken, zeroSale.transaction_id, 1, "visa", ctx.productId);
    const zeroEnded = await endShift(ctx.app, cashierToken, zeroId);
    expect(zeroEnded.visa_net).toBe(0);
    expect(zeroEnded.visa_receipt_count).toBe(1);
    expect(zeroEnded.visa_refund_count).toBe(1);
    const zeroSave = await request(ctx.app)
      .post(`/api/v1/shifts/${zeroId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 0, visa_basis: basisOf(zeroEnded) });
    expect(zeroSave.status).toBe(200);
    expect(unwrap(zeroSave).reconciliation.status_label).toBe("مطابق");
    const zeroLines = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${zeroId}/visa-activity`).set(authHeader(adminToken))
    );
    expect(zeroLines.lines.filter((line) => line.kind === "refund")).toHaveLength(1);

    const negativeId = await startShift(ctx.app, cashierToken, ctx.db, 100);
    await endShift(ctx.app, cashierToken, negativeId);
    const refundShift = await startShift(ctx.app, cashierToken, ctx.db, 100);
    const source = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
      payment_method: "cash",
    });
    await ctx.db.run("UPDATE transactions SET shift_id = ? WHERE id = ?", [negativeId, source.transaction_id]);
    await ctx.db.run(
      "UPDATE sale_payments SET payment_method = 'visa' WHERE transaction_id = ?",
      [source.transaction_id]
    );
    await approveRefund(ctx.app, cashierToken, adminToken, source.transaction_id, 2, "visa", ctx.productId);
    const refundEnded = await endShift(ctx.app, cashierToken, refundShift);
    expect(refundEnded.visa_sales).toBe(0);
    expect(refundEnded.visa_refunds).toBe(20);
    expect(refundEnded.visa_net).toBe(-20);
    const negativeSave = await request(ctx.app)
      .post(`/api/v1/shifts/${refundShift}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: -15, visa_basis: basisOf(refundEnded) });
    expect(negativeSave.status).toBe(200);
    expect(unwrap(negativeSave).reconciliation.saved.difference).toBe(5);
    expect(unwrap(negativeSave).reconciliation.status_label).toBe("زائد 5");
    const refundLines = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${refundShift}/visa-activity`).set(authHeader(adminToken))
    );
    expect(refundLines.lines).toHaveLength(1);

    await ctx.db.run("UPDATE cashier_shifts SET business_day = '2026-03-15' WHERE id IN (?, ?, ?)", [
      blankId,
      zeroId,
      refundShift,
    ]);
    const partial = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: "2026-03-15", to: "2026-03-15" })
        .set(authHeader(adminToken))
    );
    expect(partial.summary.expected_net).toBe(-10);
    expect(partial.summary.machine_net).toBe(-15);
    expect(partial.summary.difference).toBe(5);
    expect(partial.summary.awaiting_expected_net).toBe(10);
    expect(partial.summary.counted_expected_net).toBe(-20);
    const blank = partial.shifts.find((row) => row.shift_id === blankId);
    expect(blank.state).toBe("awaiting");
    expect(blank.machine_net).toBeNull();
    expect(blank.current.net).toBe(10);
  });

  test("partial reconciliation keeps an uncounted 60 out of the shortage", async () => {
    const day = "2026-06-02";
    const price = Number(product.price);
    const countedId = await startShift(ctx.app, cashierToken, ctx.db, 200);
    await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 14, price }],
      payment_method: "visa",
    });
    const countedEnd = await endShift(ctx.app, cashierToken, countedId);
    expect(countedEnd.visa_net).toBe(140);
    const saved = await request(ctx.app)
      .post(`/api/v1/shifts/${countedId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 135, visa_basis: basisOf(countedEnd) });
    expect(saved.status).toBe(200);
    expect(unwrap(saved).reconciliation.saved.difference).toBe(-5);

    const waitingId = await startShift(ctx.app, cashierToken, ctx.db, 200);
    await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 6, price }],
      payment_method: "visa",
    });
    const waitingEnd = await endShift(ctx.app, cashierToken, waitingId);
    expect(waitingEnd.visa_net).toBe(60);
    expect(waitingEnd.visa_machine_net ?? null).toBeNull();
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id IN (?, ?)", [
      day,
      countedId,
      waitingId,
    ]);

    const report = unwrap(
      await request(ctx.app).get("/api/v1/reports/visa").query({ from: day, to: day }).set(authHeader(adminToken))
    );
    expect(report.summary.expected_net).toBe(200);
    expect(report.summary.machine_net).toBe(135);
    expect(report.summary.difference).toBe(-5);
    expect(report.summary.awaiting_expected_net).toBe(60);
    expect(report.summary.counted_expected_net).toBe(140);
    const waiting = report.shifts.find((row) => row.shift_id === waitingId);
    expect(waiting.state).toBe("awaiting");
    expect(waiting.machine_net).toBeNull();
    expect(waiting.expected_net).toBe(60);
  });

  test("incomplete visa data is not reconciled and does not block the cash count", async () => {
    const shiftId = await startShift(ctx.app, cashierToken, ctx.db, 80);
    const sale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 4, price: product.price }],
      payment_method: "visa",
    });
    await ctx.db.run("DELETE FROM sale_payments WHERE transaction_id = ?", [sale.transaction_id]);
    const ended = await endShift(ctx.app, cashierToken, shiftId);
    expect(ended.visa_incomplete).toBe(true);
    expect(ended.visa_net).toBe(0);
    const rejected = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 0, visa_basis: basisOf(ended) });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("VISA_INCOMPLETE");
    const closed = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({ counted_currencies: [{ currency_code: "NIS", amount: ended.expected_cash }] });
    expect(closed.status).toBe(200);
    const row = await ctx.db.get("SELECT status, visa_machine_net FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(row.status).toBe("closed");
    expect(row.visa_machine_net).toBeNull();
    const day = (
      await ctx.db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [shiftId])
    ).business_day;
    const report = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: day, to: day, shift_id: shiftId })
        .set(authHeader(adminToken))
    );
    expect(report.summary.coverage).toBe("incomplete");
    expect(report.summary.expected_label).toBe("صافي معروف");
    expect(report.shifts[0].state).toBe("awaiting");
    expect(report.shifts[0].known_only).toBe(true);
  });

  test("stale basis is rejected and a later refund stays on its own business day", async () => {
    const shiftId = await startShift(ctx.app, cashierToken, ctx.db, 50);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = '2026-01-31' WHERE id = ?", [shiftId]);
    const sale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 6, price: product.price }],
      payment_method: "visa",
    });
    const ended = await endShift(ctx.app, cashierToken, shiftId);
    const stale = { ...basisOf(ended), visa_net: 1 };
    const rejected = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 60, visa_basis: stale });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("VISA_BASIS_STALE");
    const untouched = await ctx.db.get("SELECT visa_machine_net, status FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(untouched.visa_machine_net).toBeNull();
    expect(untouched.status).toBe("pending_count");

    const saved = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/visa-reconcile`)
      .set(authHeader(adminToken))
      .send({ visa_machine_net: 60, visa_basis: basisOf(ended) });
    expect(saved.status).toBe(200);

    const nextId = await startShift(ctx.app, cashierToken, ctx.db, 50);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = '2026-02-01' WHERE id = ?", [nextId]);
    await approveRefund(ctx.app, cashierToken, adminToken, sale.transaction_id, 1, "visa", ctx.productId);
    const february = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: "2026-02-01", to: "2026-02-01", shift_id: nextId })
        .set(authHeader(adminToken))
    );
    expect(february.shifts[0].current.refunds).toBe(10);
    expect(february.shifts[0].current.sales).toBe(0);
    const january = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: "2026-01-31", to: "2026-01-31", shift_id: shiftId })
        .set(authHeader(adminToken))
    );
    expect(january.shifts[0].expected_net).toBe(60);
    expect(january.shifts[0].current.refunds).toBe(0);
    expect(january.summary.expected_net).toBe(60);
  });

  test("permissions separate the dashboard summary, the report, and shift lines", async () => {
    const dashboardOnly = allAccountantPermissionsDisabled();
    dashboardOnly.dashboard = true;
    const dashUser = await createAccountantUser(ctx.db, {
      username: "visa-dash",
      permissions: dashboardOnly,
    });
    const dashToken = (await login(ctx.app, dashUser.username, dashUser.password, "office")).body.token;
    const day = "2026-01-31";
    const summary = await request(ctx.app)
      .get("/api/v1/reports/visa-summary")
      .query({ from: day, to: day })
      .set(authHeader(dashToken));
    expect(summary.status).toBe(200);
    const report = await request(ctx.app)
      .get("/api/v1/reports/visa")
      .query({ from: day, to: day })
      .set(authHeader(dashToken));
    expect(report.status).toBe(403);
    const shift = await ctx.db.get("SELECT id, cashier_id FROM cashier_shifts ORDER BY id DESC LIMIT 1");
    const lines = await request(ctx.app)
      .get(`/api/v1/reports/visa/shifts/${shift.id}/lines`)
      .set(authHeader(dashToken));
    expect(lines.status).toBe(403);
    const activity = await request(ctx.app)
      .get(`/api/v1/shifts/${shift.id}/visa-activity`)
      .set(authHeader(dashToken));
    expect(activity.status).toBe(403);

    const auditOnly = allAccountantPermissionsDisabled();
    auditOnly.shift_audit = true;
    const auditUser = await createAccountantUser(ctx.db, {
      username: "visa-audit",
      permissions: auditOnly,
    });
    const auditToken = (await login(ctx.app, auditUser.username, auditUser.password, "office")).body.token;
    const allowedLines = await request(ctx.app)
      .get(`/api/v1/shifts/${shift.id}/visa-activity`)
      .set(authHeader(auditToken));
    expect(allowedLines.status).toBe(200);
    const blockedReport = await request(ctx.app)
      .get("/api/v1/reports/visa")
      .query({ from: day, to: day })
      .set(authHeader(auditToken));
    expect(blockedReport.status).toBe(403);

    const own = await request(ctx.app)
      .get(`/api/v1/shifts/${shift.id}/visa-activity`)
      .set(authHeader(otherToken));
    expect(own.status).toBe(403);
    const cashierReport = await request(ctx.app)
      .get("/api/v1/reports/visa-summary")
      .query({ from: day, to: day })
      .set(authHeader(cashierToken));
    expect(cashierReport.status).toBe(403);
  });

  test("daily visa sales match shift collections except an office invoice", async () => {
    const day = "2026-04-11";
    const price = Number(product.price);
    const shiftId = await startShift(ctx.app, cashierToken, ctx.db, 200);
    const visaSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 12, price }],
      payment_method: "visa",
    });
    await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 10, price }],
      payment_method: "mixed",
      payments: [
        { method: "cash", amount: 70 },
        { method: "visa", amount: 30 },
      ],
    });
    await approveRefund(ctx.app, cashierToken, adminToken, visaSale.transaction_id, 1, "visa", ctx.productId);
    await approveRefund(ctx.app, cashierToken, adminToken, visaSale.transaction_id, 1, "cash", ctx.productId);
    const customer = await ctx.db.run(
      "INSERT INTO customers (name, balance, credit_limit) VALUES ('ذمة اليوم', 0, 1000)"
    );
    const pending = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price }],
          payment_method: "on_account",
          customer_id: customer.lastID,
        })
      );
    expect(pending.status).toBe(202);
    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(pending).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const oaTx = await ctx.db.get(
      "SELECT transaction_id FROM on_account_requests WHERE id = ?",
      [unwrap(pending).request_id]
    );
    await approveRefund(ctx.app, cashierToken, adminToken, oaTx.transaction_id, 1, "on_account", ctx.productId);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [day, shiftId]);

    const daily = unwrap(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: day }).set(authHeader(adminToken))
    );
    const collections = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/visa")
        .query({ from: day, to: day, shift_id: shiftId })
        .set(authHeader(adminToken))
    );
    const expectedCard = unwrap(
      await request(ctx.app).get("/api/v1/finance/cash/expected").query({ date: day }).set(authHeader(adminToken))
    );
    expect(daily.card_total).toBe(150);
    expect(daily.visa_refunds).toBe(10);
    expect(daily.net_card_total).toBe(140);
    expect(daily.visa_incomplete).toBe(false);
    expect(collections.summary.expected_net).toBe(140);
    expect(collections.summary.coverage).toBe("complete");
    expect(expectedCard.sales_card).toBe(150);
    expect(expectedCard.refund_card).toBe(10);
    expect(expectedCard.expected_card).toBe(daily.net_card_total);

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const office = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, store_id, business_day)
       VALUES (?, '[]', 25, 0, 25, 0, 'visa', NULL, 'completed', 1, ?)`,
      [cashier.id, day]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'visa', 25, 1, 25)`,
      [office.lastID]
    );
    const withOffice = unwrap(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: day }).set(authHeader(adminToken))
    );
    const shiftsOnly = unwrap(
      await request(ctx.app).get("/api/v1/reports/visa").query({ from: day, to: day }).set(authHeader(adminToken))
    );
    expect(withOffice.card_total).toBe(175);
    expect(withOffice.net_card_total).toBe(165);
    expect(shiftsOnly.summary.expected_net).toBe(140);

    const incompleteId = await startShift(ctx.app, cashierToken, ctx.db, 0);
    const broken = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 4, price }],
      payment_method: "visa",
    });
    await ctx.db.run("DELETE FROM sale_payments WHERE transaction_id = ?", [broken.transaction_id]);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [day, incompleteId]);
    const known = unwrap(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: day }).set(authHeader(adminToken))
    );
    const flagged = unwrap(
      await request(ctx.app).get("/api/v1/reports/visa").query({ from: day, to: day }).set(authHeader(adminToken))
    );
    expect(known.visa_incomplete).toBe(true);
    expect(known.card_total).toBe(175);
    expect(known.net_card_total).toBe(165);
    expect(flagged.summary.coverage).toBe("incomplete");
    expect(flagged.summary.expected_label).toBe("صافي معروف");
    expect(flagged.summary.expected_net).toBe(140);
  });

  test("repeated initialization keeps an unsaved historical machine total null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visa-migrate-"));
    const dbPath = path.join(dir, "visa.db");
    const first = await initDatabase(dbPath);
    await closeSqliteConnection(first);
    const second = await initDatabase(dbPath);
    const cols = await second.all("PRAGMA table_info(cashier_shifts)");
    expect(cols.map((col) => col.name)).toEqual(
      expect.arrayContaining(["visa_machine_net", "visa_expected_net", "visa_counted_by", "visa_counted_at"])
    );
    const table = await second.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shift_visa_corrections'"
    );
    expect(table?.name).toBe("shift_visa_corrections");
    await closeSqliteConnection(second);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
