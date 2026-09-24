import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createAccountantUser,
} from "./helpers.js";
import { computeExpectedCash } from "../utils/salePayments.js";
import { postPosSupplierPayment } from "../services/posSupplierPaymentService.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function approveSupplierRequest(app, adminToken, created) {
  const body = unwrap(created.body);
  expect(body.pending_approval).toBe(true);
  const approved = await request(app)
    .post(`/api/v1/supplier-payment-requests/${body.request_id}/approve`)
    .set(authHeader(adminToken));
  expect(approved.status).toBe(200);
  return unwrap(approved.body);
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

describe("POS supplier cash payment", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"])).id;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد درج', 'S-POS-1', 500, 500)`
    );
    supplierId = sup.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("lookup returns only id and name; cashiers cannot write office vouchers", async () => {
    const res = await request(ctx.app).get("/api/v1/pos/suppliers").set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((r) => r.id === supplierId);
    expect(row).toEqual({ id: supplierId, name: "مورد درج" });
    expect(row).not.toHaveProperty("balance");

    const office = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(cashierToken))
      .send({
        voucher_type: "payment",
        voucher_date: "2026-09-24",
        lines: [{ line_type: "cash", amount: 1, currency: "NIS", supplier_id: supplierId }],
      });
    expect(office.status).toBe(403);

    const finance = await request(ctx.app)
      .post("/api/v1/finance/payments")
      .set(authHeader(cashierToken))
      .send({ supplier_id: supplierId, amount: 1, paid_on: "2026-09-24", payment_method: "cash" });
    expect(finance.status).toBe(403);
  });

  test("pays 100 from a 300 drawer against 500 debt once", async () => {
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 300);
    const stockBefore = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    const visaBefore = await ctx.db.get(
      "SELECT COALESCE(SUM(total),0) AS s FROM transactions WHERE shift_id = ? AND payment_method = 'visa'",
      [shift.id]
    );
    const opexBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n;

    const res = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 100,
        notes: "دفعة درج",
        idempotency_key: "pos-sup-pay-100-aaaa",
      });
    expect(res.status).toBe(201);
    const body = await approveSupplierRequest(ctx.app, adminToken, res);
    expect(body.replayed).toBe(false);
    expect(Number(body.amount)).toBe(100);
    expect(body.supplier_name).toBe("مورد درج");
    expect(body.voucher_no).toBeTruthy();
    expect(Number(body.shift_id)).toBe(shift.id);

    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(supplier.balance)).toBe(400);
    const expected = await computeExpectedCash(ctx.db, shift.id, 300);
    expect(expected).toBe(200);

    const vouchers = await ctx.db.all(
      "SELECT id FROM vouchers WHERE shift_id = ? AND voucher_type = 'payment'",
      [shift.id]
    );
    expect(vouchers).toHaveLength(1);
    const moves = await ctx.db.all(
      "SELECT * FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
      [shift.id]
    );
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].amount)).toBe(-100);
    expect(Number(moves[0].voucher_id)).toBe(vouchers[0].id);
    const legacy = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM supplier_payments WHERE supplier_id = ?",
      [supplierId]
    );
    expect(Number(legacy.n)).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      Number(stockBefore)
    );
    const visaAfter = await ctx.db.get(
      "SELECT COALESCE(SUM(total),0) AS s FROM transactions WHERE shift_id = ? AND payment_method = 'visa'",
      [shift.id]
    );
    expect(Number(visaAfter.s)).toBe(Number(visaBefore.s));
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)).toBe(opexBefore);

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shift.id}`).set(authHeader(adminToken))).body
    );
    expect(Number(detail.summary.supplier_payments_total)).toBe(100);
    expect(detail.supplier_payments).toHaveLength(1);
    expect(detail.supplier_payments[0].supplier_name).toBe("مورد درج");
    expect(Number(detail.summary.expected)).toBe(200);

    const ledger = unwrap(
      (await request(ctx.app).get(`/api/v1/suppliers/${supplierId}/ledger`).set(authHeader(adminToken))).body
    );
    const payEvents = (ledger.events || ledger.rows || []).filter(
      (row) => row.ev_type === "payment" || row.type === "payment" || row.kind === "payment"
    );
    expect(payEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("keeps two-decimal amounts and allows a second genuine payment", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 12.5,
        idempotency_key: "pos-sup-pay-12-50-bbbb",
      });
    expect(res.status).toBe(201);
    expect(Number((await approveSupplierRequest(ctx.app, adminToken, res)).amount)).toBe(12.5);
    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(supplier.balance)).toBe(387.5);

    const second = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 12.5,
        idempotency_key: "pos-sup-pay-12-50-cccc",
      });
    expect(second.status).toBe(201);
    await approveSupplierRequest(ctx.app, adminToken, second);
    expect(Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)).toBe(
      375
    );
  });

  test("replays the same key and rejects a changed payload", async () => {
    const first = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        notes: "نفس المفتاح",
        idempotency_key: "pos-sup-pay-replay-dddd",
      });
    expect(first.status).toBe(201);
    expect(unwrap(first.body).voucher_id).toBeNull();
    const replay = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 5,
        notes: "نفس المفتاح",
        idempotency_key: "pos-sup-pay-replay-dddd",
      });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).replayed).toBe(true);
    expect(unwrap(replay.body).request_id).toBe(unwrap(first.body).request_id);
    const approved = await approveSupplierRequest(ctx.app, adminToken, first);
    expect(approved.voucher_id).toBeTruthy();
    const secondDecision = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${unwrap(first.body).request_id}/approve`)
      .set(authHeader(adminToken));
    expect(secondDecision.status).toBe(409);

    const mismatch = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 6,
        notes: "نفس المفتاح",
        idempotency_key: "pos-sup-pay-replay-dddd",
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code || unwrap(mismatch.body)?.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  test("rejects invalid amounts and unknown suppliers", async () => {
    for (const amount of [0, -3, "abc", 1.234]) {
      const res = await request(ctx.app)
        .post("/api/v1/pos/supplier-payments")
        .set(authHeader(cashierToken))
        .send({
          supplier_id: supplierId,
          amount,
          idempotency_key: `pos-sup-pay-bad-${String(amount)}-eeee`,
        });
      expect(res.status).toBe(400);
    }
    const missing = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: 999999,
        amount: 1,
        idempotency_key: "pos-sup-pay-missing-ffff",
      });
    expect(missing.status).toBe(400);
  });

  test("rolls back the voucher when the movement insert fails", async () => {
    const beforeBalance = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );
    const beforeVouchers = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n);
    const originalRun = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (...args) => {
      if (typeof args[0] === "string" && args[0].includes("supplier_payment")) {
        throw new Error("forced movement failure");
      }
      return originalRun(...args);
    };
    await expect(
      postPosSupplierPayment(ctx.db, {
        cashierId,
        supplierId,
        amount: 3,
        idempotencyKey: "pos-sup-pay-rollback-gggg",
      })
    ).rejects.toThrow(/forced movement failure/);
    ctx.db.run = originalRun;
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n)).toBe(beforeVouchers);
    expect(
      Number((await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance)
    ).toBe(beforeBalance);
  });

  test("rejects a closed shift, another cashier, and unauthorized callers", async () => {
    const open = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashierId]
    );
    const ended = await request(ctx.app)
      .post(`/api/v1/shifts/${open.id}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(ended.status).toBe(200);

    const afterClose = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 1,
        idempotency_key: "pos-sup-pay-closed-hhhh",
      });
    expect(afterClose.status).toBe(400);
    expect(afterClose.body.code || unwrap(afterClose.body)?.code).toBe("NO_OPEN_SHIFT");

    const otherHash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["othertill", otherHash]
    );
    const otherToken = (await login(ctx.app, "othertill", "cashpass123", "pos")).body.token;
    const foreign = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(otherToken))
      .send({
        supplier_id: supplierId,
        amount: 1,
        idempotency_key: "pos-sup-pay-foreign-iiii",
      });
    expect(foreign.status).toBe(400);

    const anon = await request(ctx.app).post("/api/v1/pos/supplier-payments").send({
      supplier_id: supplierId,
      amount: 1,
      idempotency_key: "pos-sup-pay-anon-jjjj",
    });
    expect(anon.status).toBe(401);

    await createAccountantUser(ctx.db, { username: "acctpospay", password: "acctpass123" });
    const acctToken = (await login(ctx.app, "acctpospay", "acctpass123")).body.token;
    const acct = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(acctToken))
      .send({
        supplier_id: supplierId,
        amount: 1,
        idempotency_key: "pos-sup-pay-acct-kkkk",
      });
    expect(acct.status).toBe(403);
  });

  test("concurrent close either includes the payment or rejects it cleanly", async () => {
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 80);
    const [pay, close] = await Promise.all([
      request(ctx.app).post("/api/v1/pos/supplier-payments").set(authHeader(cashierToken)).send({
        supplier_id: supplierId,
        amount: 10,
        idempotency_key: "pos-sup-pay-race-llll",
      }),
      request(ctx.app)
        .post(`/api/v1/shifts/${shift.id}/end`)
        .set(authHeader(adminToken))
        .send({ closing_cash: 80 }),
    ]);
    expect([200, 201, 202, 400].includes(pay.status)).toBe(true);
    expect([200, 202, 400].includes(close.status)).toBe(true);
    const vouchers = await ctx.db.all(
      "SELECT id FROM vouchers WHERE idempotency_key = ?",
      ["pos-sup-pay-race-llll"]
    );
    const moves = await ctx.db.all(
      "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
      [shift.id]
    );
    expect(vouchers).toHaveLength(0);
    expect(moves).toHaveLength(0);
  });
});
