import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import {
  computeExpectedDrawer,
  computeShiftVisa,
  SHIFT_CASH_SALES_LABEL,
  SHIFT_EXPECTED_CASH_LABEL,
  SHIFT_VISA_LABELS,
} from "../utils/salePayments.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function startShift(app, token, db, opening) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  const shiftId = unwrap(res.body).shift_id;
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shiftId]);
  await db.run(
    "UPDATE shift_cash_movements SET amount = ? WHERE shift_id = ? AND movement_type = 'opening'",
    [opening, shiftId]
  );
  return shiftId;
}

async function sell(app, token, body, key) {
  const res = await request(app)
    .post("/api/v1/checkout")
    .set(authHeader(token))
    .send(withCheckoutKey(body, key));
  expect(res.status).toBe(201);
  return unwrap(res.body);
}

function expectShiftTotals(row, { cashSales, visaSales, visaRefunds, visaNet, expected }) {
  const visa = row.visa || row;
  expect(Number(row.cash_sales)).toBe(cashSales);
  expect(Number(visa.visa_sales)).toBe(visaSales);
  expect(Number(visa.visa_refunds)).toBe(visaRefunds);
  expect(Number(visa.visa_net)).toBe(visaNet);
  expect(Number(row.expected_cash ?? row.expected)).toBe(expected);
  expect(row.cash_sales_label || SHIFT_CASH_SALES_LABEL).toBe(SHIFT_CASH_SALES_LABEL);
  expect((visa.visa_labels || row.visa_labels)?.net || SHIFT_VISA_LABELS.net).toBe(SHIFT_VISA_LABELS.net);
}

describe("count-dialog cash sales and expected visa", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let otherToken;
  let product;
  let shiftId;
  let cashSaleId;
  let visaSaleId;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const otherHash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["count-b", otherHash]
    );
    otherToken = (await login(ctx.app, "count-b", "cashpass123", "pos")).body.token;
    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد الملخص', 'S-SUM-1', 400, 400)`
    );
    supplierId = sup.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function refund(transactionId, qty, paymentMethod) {
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: qty }],
        payment_method: paymentMethod,
        reason: "count summary",
      });
    expect(created.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    return unwrap(approved.body);
  }

  test("example: cash 500, visa net 190, drawer 580 after a forgotten supplier payment", async () => {
    shiftId = await startShift(ctx.app, cashierToken, ctx.db, 200);

    const cashSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 40, price: product.price }],
      payment_method: "cash",
    });
    cashSaleId = cashSale.transaction_id;

    await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 15, price: product.price }],
      payment_method: "mixed",
      payments: [
        { method: "cash", amount: 100 },
        { method: "visa", amount: 50 },
      ],
    });

    const visaSale = await sell(ctx.app, cashierToken, {
      items: [{ product_id: ctx.productId, quantity: 15, price: product.price }],
      payment_method: "visa",
    });
    visaSaleId = visaSale.transaction_id;

    await refund(cashSaleId, 2, "cash");
    await refund(visaSaleId, 1, "visa");

    const pendingRefund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: visaSaleId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "visa",
        reason: "still pending",
      });
    expect(pendingRefund.status).toBe(201);

    const admin = await ctx.db.get("SELECT id FROM users WHERE username = 'testadmin'");
    const office = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 70, 0, 70, 'visa', NULL, 'completed', 1)`,
      [admin.id]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'visa', 70, 70, 1, 70)`,
      [office.lastID]
    );

    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance) VALUES ('عميل تحصيل', 'C-SUM-1', 90)`
    );
    await ctx.db.run(
      `INSERT INTO vouchers (voucher_type, voucher_date, notes, total_amount, recorded_by_id, status)
       VALUES ('receipt', '2026-09-24', 'تسديد ذمة', 40, ?, 'posted')`,
      [admin.id]
    );

    const otherShift = await startShift(ctx.app, otherToken, ctx.db, 50);
    await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(otherToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 3, price: product.price }],
          payment_method: "visa",
        })
      );

    const beforePay = await computeExpectedDrawer(ctx.db, shiftId, 200);
    const visaBefore = await computeShiftVisa(ctx.db, shiftId);
    expect(beforePay.sales_cash_nis).toBe(500);
    expect(beforePay.cash_only_nis).toBe(400);
    expect(beforePay.mixed_cash_nis).toBe(100);
    expect(beforePay.expected_cash).toBe(680);
    expect(visaBefore.visa_sales).toBe(200);
    expect(visaBefore.visa_refunds).toBe(10);
    expect(visaBefore.visa_net).toBe(190);
    expect(visaBefore.visa_incomplete).toBe(false);
    expect(visaBefore.cash_sales_incomplete).toBe(false);

    const otherVisa = await computeShiftVisa(ctx.db, otherShift);
    expect(otherVisa.visa_sales).toBe(30);

    const endRes = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(endRes.status).toBe(200);

    const paid = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 100,
        notes: "دفعة منسية",
        idempotency_key: "count-summary-supplier-100",
      });
    expect(paid.status).toBe(201);
    const paidBody = unwrap(paid.body);
    expect(Number(paidBody.expected_cash)).toBe(580);
    expect(Number(paidBody.cash_sales)).toBe(500);

    const drawer = await computeExpectedDrawer(ctx.db, shiftId, 200);
    const visa = await computeShiftVisa(ctx.db, shiftId);
    expect(drawer.sales_cash_nis).toBe(500);
    expect(drawer.cash_only_nis).toBe(400);
    expect(drawer.mixed_cash_nis).toBe(100);
    expect(drawer.expected_cash).toBe(580);
    expect(visa.visa_sales).toBe(200);
    expect(visa.visa_refunds).toBe(10);
    expect(visa.visa_net).toBe(190);

    const detailRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftId}`)
      .set(authHeader(adminToken));
    expect(detailRes.status).toBe(200);
    const detail = unwrap(detailRes.body);
    expectShiftTotals(detail.shift, {
      cashSales: 500,
      visaSales: 200,
      visaRefunds: 10,
      visaNet: 190,
      expected: 580,
    });
    expectShiftTotals(detail.summary, {
      cashSales: 500,
      visaSales: 200,
      visaRefunds: 10,
      visaNet: 190,
      expected: 580,
    });
    expect(detail.summary.visa.visa_sales).toBe(200);
    expect(detail.summary.visa.visa_refunds).toBe(10);
    expect(detail.summary.visa.visa_net).toBe(190);
    expect(Number(detail.shift.cash_only_sales)).toBe(400);
    expect(Number(detail.shift.mixed_cash_sales)).toBe(100);
    expect(Number(detail.shift.cash_refunds)).toBe(20);
    expect(Number(detail.shift.cash_net)).toBe(480);
    expect(Number(detail.shift.tender_total)).toBe(700);
    expect(Number(detail.summary.tender_total)).toBe(700);
    expect(detail.summary.cash_sales_label).toBe(SHIFT_CASH_SALES_LABEL);
    expect(detail.summary.expected_cash_label).toBe(SHIFT_EXPECTED_CASH_LABEL);
    expect(detail.shift.mixed_cash_label).toBe("منها نقد من دفعات مختلطة");
    expect(detail.shift.mixed_cash_included_note).toBe("مشمول في المبيعات النقدية");
    expect(detail.shift.visa_amount_label).toBe("مبيعات فيزا");
    expect(detail.shift.tender_total_label).toBe("إجمالي المبيعات النقدية والفيزا");
    expect(detail.shift.visa_note).toContain("ليست تسوية بنكية");
    expect(detail.refunds.find((row) => row.original_transaction_id === visaSaleId)).toBeTruthy();

    const pending = unwrap(
      (await request(ctx.app).get("/api/v1/shifts/pending").set(authHeader(adminToken))).body
    );
    const pendingRow = pending.find((row) => row.id === shiftId);
    expectShiftTotals(pendingRow, {
      cashSales: 500,
      visaSales: 200,
      visaRefunds: 10,
      visaNet: 190,
      expected: 580,
    });

    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/shifts").set(authHeader(adminToken))).body
    );
    expectShiftTotals(
      listed.find((row) => row.id === shiftId),
      {
        cashSales: 500,
        visaSales: 200,
        visaRefunds: 10,
        visaNet: 190,
        expected: 580,
      }
    );

    const csvRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftId}/export.csv`)
      .set(authHeader(adminToken));
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain(SHIFT_CASH_SALES_LABEL);
    expect(csvRes.text).toContain("منها نقد من دفعات مختلطة");
    expect(csvRes.text).toContain("مشمول في المبيعات النقدية");
    expect(csvRes.text).toContain("إجمالي المبيعات النقدية والفيزا");
    expect(csvRes.text).toContain(SHIFT_EXPECTED_CASH_LABEL);
    expect(csvRes.text).toContain(SHIFT_VISA_LABELS.net);
    expect(csvRes.text).toMatch(new RegExp(`${SHIFT_CASH_SALES_LABEL},500`));
    expect(csvRes.text).toMatch(/منها نقد من دفعات مختلطة,100/);
    expect(csvRes.text).toMatch(/مبيعات فيزا,200/);
    expect(csvRes.text).toMatch(/إجمالي المبيعات النقدية والفيزا,700/);
    expect(csvRes.text).toMatch(/مرتجعات نقدية,20/);
    expect(csvRes.text).toMatch(/صافي المبيعات النقدية,480/);
    expect(csvRes.text).toMatch(new RegExp(`${SHIFT_EXPECTED_CASH_LABEL},580`));
    expect(csvRes.text).toMatch(new RegExp(`${SHIFT_VISA_LABELS.sales},200`));
    expect(csvRes.text).toMatch(new RegExp(`${SHIFT_VISA_LABELS.refunds},10`));
    expect(csvRes.text).toMatch(new RegExp(`${SHIFT_VISA_LABELS.net},190`));
    expect(csvRes.text).toContain("ليست تسوية بنكية");

    const otherDetail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${otherShift}`).set(authHeader(adminToken))).body
    );
    expect(Number(otherDetail.summary.cash_sales)).toBe(0);
    expect(Number(otherDetail.summary.visa.visa_sales)).toBe(30);
    expect(Number(otherDetail.summary.expected)).toBe(50);

    void customer;
  });

  test("flags incomplete historical cash allocation and does not guess the missing visa", async () => {
    const cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    const mixed = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 80, 0, 80, 'mixed', ?, 'completed', 1)`,
      [cashierId, shiftId]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'cash', 80, 80, 1, 80)`,
      [mixed.lastID]
    );

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(adminToken))).body
    );
    expect(detail.shift.cash_sales_incomplete).toBe(true);
    expect(detail.shift.visa_incomplete).toBe(true);
    expect(Number(detail.summary.cash_sales)).toBe(580);
    expect(Number(detail.summary.visa.visa_sales)).toBe(200);
    expect(detail.shift.cash_sales_incomplete_note).toContain("لم يُخمَّن");
  });

  test("100 cash + mixed 30/70 + 50 visa = cash 130, visa 120, combined 250", async () => {
    const token = cashierToken;
    const sid = await startShift(ctx.app, token, ctx.db, 0);
    await sell(ctx.app, token, {
      items: [{ product_id: ctx.productId, quantity: 10, price: 10 }],
      payment_method: "cash",
    });
    await sell(ctx.app, token, {
      items: [{ product_id: ctx.productId, quantity: 10, price: 10 }],
      payment_method: "mixed",
      payments: [
        { method: "cash", amount: 30 },
        { method: "visa", amount: 70 },
      ],
    });
    await sell(ctx.app, token, {
      items: [{ product_id: ctx.productId, quantity: 5, price: 10 }],
      payment_method: "visa",
    });

    const drawer = await computeExpectedDrawer(ctx.db, sid, 0);
    const visa = await computeShiftVisa(ctx.db, sid);
    expect(drawer.sales_cash_nis).toBe(130);
    expect(drawer.cash_only_nis).toBe(100);
    expect(drawer.mixed_cash_nis).toBe(30);
    expect(visa.visa_sales).toBe(120);
    expect(drawer.sales_cash_nis + visa.visa_sales).toBe(250);

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${sid}`).set(authHeader(adminToken))).body
    );
    expect(Number(detail.summary.cash_sales)).toBe(130);
    expect(Number(detail.summary.mixed_cash_sales)).toBe(30);
    expect(Number(detail.summary.visa.visa_sales)).toBe(120);
    expect(Number(detail.summary.tender_total)).toBe(250);
    expect(detail.summary.cash_sales_label).toBe("مبيعات نقدية");
    expect(detail.summary.visa_amount_label).toBe("مبيعات فيزا");
    expect(detail.summary.tender_total_label).toBe("إجمالي المبيعات النقدية والفيزا");
    expect(Number(detail.summary.expected)).toBe(130);

    const csvRes = await request(ctx.app)
      .get(`/api/v1/shifts/${sid}/export.csv`)
      .set(authHeader(adminToken));
    expect(csvRes.text).toMatch(/مبيعات نقدية,130/);
    expect(csvRes.text).toMatch(/منها نقد من دفعات مختلطة,30/);
    expect(csvRes.text).toMatch(/مبيعات فيزا,120/);
    expect(csvRes.text).toMatch(/إجمالي المبيعات النقدية والفيزا,250/);
    expect(csvRes.text).not.toContain("نقد من فيزا");
    expect(csvRes.text).not.toContain("نقد عادي");
  });
});
