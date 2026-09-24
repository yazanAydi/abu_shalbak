import request from "supertest";
import {
  authHeader,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { round2, roundPosPayable, sumMoney } from "../utils/money.js";
import { shopTodayYmd } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("office screens keep the saved POS payable", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let shiftId;
  let customerId;
  let employeeId;
  const saved = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(shift.status).toBe(201);
    shiftId = unwrap(shift.body).id || unwrap(shift.body).shift_id;
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('ذمة تقريب', 'RND-OFF', 0, 0, 1000)`
    );
    customerId = cust.lastID;
    const emp = await createTestEmployee(ctx.db, { name: "موظف مكتب تقريب" });
    employeeId = emp.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function setPrice(price) {
    await ctx.db.run("UPDATE products SET price = ? WHERE id = ?", [price, ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = ? WHERE product_id = ?", [price, ctx.productId]);
  }

  async function sell(body) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(res.status).toBe(201);
    const sale = unwrap(res.body);
    saved.push(sale);
    return sale;
  }

  async function approveOnAccount(customerOrEmployee) {
    const pending = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(customerOrEmployee));
    expect(pending.status).toBe(202);
    const requestId = unwrap(pending.body).request_id;
    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const txId = unwrap(approved.body).transaction_id || unwrap(approved.body).request?.transaction_id;
    const row = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    return { requestId, txId, row, approved: unwrap(approved.body) };
  }

  test("saved finals flow through shift, reports, debt, refunds, and print", async () => {
    const cases = [
      { price: 21, payable: 21, adjustment: 0 },
      { price: 21.3, payable: 21, adjustment: -0.3 },
      { price: 21.49, payable: 21, adjustment: -0.49 },
      { price: 2.5, payable: 2.5, adjustment: 0 },
      { price: 2.5, payable: 2.5, adjustment: 0 },
      { price: 2.51, payable: 3, adjustment: 0.49 },
      { price: 45.6, payable: 46, adjustment: 0.4 },
    ];
    for (const row of cases) {
      await setPrice(row.price);
      const sale = await sell({
        items: [{ product_id: ctx.productId, quantity: 1, price: row.price }],
        payment_method: "cash",
      });
      expect(sale.total).toBe(row.payable);
      expect(sale.rounding_adjustment).toBe(row.adjustment);
      expect(sale.amount_before_rounding).toBe(row.price);
    }

    await setPrice(21.3);
    const visa = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
      payment_method: "visa",
    });
    expect(visa.total).toBe(21);
    expect(visa.rounding_adjustment).toBe(-0.3);

    await setPrice(10.3);
    const mixed = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
      payments: [
        { method: "cash", amount: 4 },
        { method: "visa", amount: 6 },
      ],
    });
    expect(mixed.total).toBe(10);
    expect(mixed.payment_method).toBe("mixed");
    expect(round2(mixed.payments.reduce((sum, line) => sum + Number(line.nis_equivalent || line.amount), 0))).toBe(10);

    await ctx.db.run("UPDATE products SET is_weighed = 1, unit = 'كغم', price = 10 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET unit_name = 'كغم', price = 10 WHERE product_id = ?", [ctx.productId]);
    const weighedQty = await sell({
      items: [{ product_id: ctx.productId, quantity: 1.375, price: 10 }],
      payment_method: "cash",
    });
    await ctx.db.run("UPDATE products SET is_weighed = 0, unit = 'حبة' WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET unit_name = 'حبة' WHERE product_id = ?", [ctx.productId]);
    expect(weighedQty.amount_before_rounding).toBe(13.75);
    expect(weighedQty.rounding_adjustment).toBe(0.25);
    expect(weighedQty.total).toBe(14);
    const qtyRow = await ctx.db.get("SELECT quantity FROM transaction_items WHERE transaction_id = ?", [
      weighedQty.transaction_id,
    ]);
    expect(qtyRow.quantity).toBe(1.375);

    await setPrice(5.6);
    const onAccount = await approveOnAccount({
      items: [{ product_id: ctx.productId, quantity: 1, price: 5.6 }],
      payment_method: "on_account",
      customer_id: customerId,
    });
    expect(onAccount.row.total).toBe(6);
    expect(onAccount.row.rounding_adjustment).toBe(0.4);
    const listed = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/on-account-requests/history")
          .query({ status: "approved" })
          .set(authHeader(adminToken))
      ).body
    );
    const listedRow = (Array.isArray(listed) ? listed : listed.requests || []).find(
      (row) => Number(row.id) === Number(onAccount.requestId)
    );
    expect(listedRow.total_amount).toBe(6);
    expect(listedRow.rounding_adjustment).toBe(0.4);
    expect(listedRow.items[0].line_total).toBe(5.6);

    await setPrice(2.3);
    const employeeSale = await approveOnAccount({
      items: [{ product_id: ctx.productId, quantity: 1, price: 2.3 }],
      payment_method: "on_account",
      employee_id: employeeId,
    });
    expect(employeeSale.row.total).toBe(2);
    expect(employeeSale.row.rounding_adjustment).toBe(-0.3);

    await ctx.db.run(
      `INSERT INTO transactions (
         cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at
       ) VALUES (
         (SELECT id FROM users WHERE username = 'testcashier'),
         ?, 21.3, 0, 21.3, 0, 'cash', ?, 'completed', datetime('now')
       )`,
      [JSON.stringify([{ product_id: ctx.productId, name: "قديم", quantity: 1, price: 21.3 }]), shiftId]
    );
    const historical = await ctx.db.get(
      "SELECT id, total, rounding_adjustment FROM transactions WHERE total = 21.3 AND rounding_adjustment IS NULL"
    );
    expect(historical.total).toBe(21.3);
    expect(historical.rounding_adjustment).toBeNull();
    await ctx.db.run(
      `INSERT INTO transaction_items (transaction_id, product_id, name, quantity, unit_price, line_net, line_gross)
       VALUES (?, ?, 'قديم', 1, 21.3, 21.3, 21.3)`,
      [historical.id, ctx.productId]
    );

    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [ctx.productId]);
    await setPrice(10.3);
    const partialSale = await sell({
      items: [{ product_id: ctx.productId, quantity: 2, price: 10.3 }],
      payment_method: "cash",
    });
    expect(partialSale.total).toBe(21);
    expect(partialSale.amount_before_rounding).toBe(20.6);

    async function refundQty(transactionId, qty, method) {
      const created = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: transactionId,
          payment_method: method,
          reason: "تدقيق",
          lines: [{ product_id: ctx.productId, unit_id: unit.id, quantity: qty }],
        });
      expect(created.status).toBe(201);
      const body = unwrap(created.body);
      const approved = await request(ctx.app)
        .put(`/api/v1/refund-requests/${body.request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(approved.status).toBe(200);
      return body.request;
    }

    const partial = await refundQty(partialSale.transaction_id, 1, "cash");
    expect(partial.total_amount).toBe(10.5);
    expect(partial.rounding_adjustment).toBe(0.2);
    const rest = await refundQty(partialSale.transaction_id, 1, "cash");
    expect(round2(partial.total_amount + rest.total_amount)).toBe(21);

    const full = await refundQty(visa.transaction_id, 1, "visa");
    expect(full.total_amount).toBe(21);
    expect(full.rounding_adjustment).toBe(-0.3);

    const refundRow = await ctx.db.get(
      "SELECT id, total, rounding_adjustment FROM refunds WHERE original_transaction_id = ? ORDER BY id ASC LIMIT 1",
      [partialSale.transaction_id]
    );
    const refundDetail = unwrap(
      (await request(ctx.app).get(`/api/v1/refunds/${refundRow.id}`).set(authHeader(adminToken))).body
    );
    expect(refundDetail.refund.total).toBe(10.5);
    expect(refundDetail.refund.rounding_adjustment).toBe(0.2);
    expect(refundDetail.items_refunded[0].line_total).toBe(10.3);
    const refundHtml = (
      await request(ctx.app).get(`/api/v1/refunds/${refundRow.id}/receipt`).set(authHeader(adminToken))
    ).text;
    expect(refundHtml).toContain("تقريب");
    expect(refundHtml).toContain("10.5");

    const today = shopTodayYmd();
    const dbSales = await ctx.db.all(
      "SELECT id, total, rounding_adjustment, subtotal FROM transactions WHERE status = 'completed'"
    );
    const dbRefunds = await ctx.db.all("SELECT total FROM refunds WHERE status = 'approved'");
    const expectedSales = sumMoney(dbSales.map((row) => row.total));
    const expectedAdjustment = sumMoney(dbSales.map((row) => row.rounding_adjustment || 0));
    const expectedRefunds = sumMoney(dbRefunds.map((row) => row.total));

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(adminToken))).body
    );
    const shown = detail.transactions.find((row) => Number(row.id) === Number(saved[1].transaction_id));
    expect(shown.total).toBe(21);
    expect(shown.subtotal).toBe(21.3);
    expect(shown.rounding_adjustment).toBe(-0.3);
    expect(sumMoney(detail.transactions.map((row) => row.total))).toBe(expectedSales);
    const shownRefund = detail.refunds.find((row) => Number(row.id) === Number(refundRow.id));
    expect(shownRefund.total).toBe(10.5);
    expect(shownRefund.rounding_adjustment).toBe(0.2);

    const daily = unwrap(
      (await request(ctx.app).get("/api/v1/reports/daily").query({ date: today }).set(authHeader(adminToken))).body
    );
    expect(daily.total_sales).toBe(expectedSales);
    expect(daily.rounding_adjustment).toBe(expectedAdjustment);
    expect(round2(daily.item_revenue + daily.rounding_adjustment)).toBe(daily.total_sales);
    expect(daily.refunds_total).toBe(expectedRefunds);
    expect(round2(daily.cash_total + daily.card_total + daily.on_account_total + 21.3)).toBe(expectedSales);
    expect(daily.net_sales).toBe(round2(expectedSales - expectedRefunds));

    const range = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/reports/range")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      ).body
    );
    expect(range.total_sales).toBe(expectedSales);
    expect(range.rounding_adjustment).toBe(expectedAdjustment);
    expect(round2(range.item_revenue + range.rounding_adjustment)).toBe(range.total_sales);
    expect(range.by_day[0].total_sales).toBe(expectedSales);

    const finance = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/finance/overview")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      ).body
    );
    expect(finance.sales.pos).toBe(expectedSales);
    expect(finance.sales.refunds).toBe(expectedRefunds);
    expect(finance.sales.net).toBe(round2(expectedSales - expectedRefunds));

    const ledger = unwrap(
      (await request(ctx.app).get(`/api/v1/customers/${customerId}/ledger`).set(authHeader(adminToken))).body
    );
    const saleEvent = (ledger.events || []).find((row) => row.ev_type === "sale");
    expect(Number(saleEvent.debit)).toBe(6);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(6);

    const history = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${employeeId}/history`).set(authHeader(adminToken))).body
    );
    expect(history.debts.items[0].original).toBe(2);
    expect(history.debts.period_total).toBe(2);

    const byPrice = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
          .query({ date_from: today, date_to: today })
          .set(authHeader(adminToken))
      ).body
    );
    const qtyTotal = round2((byPrice.rows || byPrice).reduce?.((sum, row) => sum + Number(row.net_quantity_sold || 0), 0) || 0);
    expect(qtyTotal).toBeGreaterThanOrEqual(1.375);

    const receipt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/shifts/transactions/${saved[1].transaction_id}/receipt`)
          .set(authHeader(adminToken))
      ).body
    );
    expect(receipt.receipt_html).toContain("تقريب");
    expect(receipt.receipt_html).toContain("-0.30");
    expect(receipt.receipt_html).toContain("21.00");
    expect(receipt.receipt_html).toContain("21.30");

    const supplier = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('مورد تقريب')");
    const payment = await request(ctx.app)
      .post("/api/v1/finance/payments")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplier.lastID, amount: 21.3, paid_on: today, payment_method: "cash" });
    expect(payment.status).toBe(201);
    expect(Number(unwrap(payment.body).amount)).toBe(21.3);
    const voucherLine = await ctx.db.get(
      "SELECT amount_nis FROM voucher_lines WHERE voucher_id = ?",
      [unwrap(payment.body).voucher_id]
    );
    expect(voucherLine.amount_nis).toBe(21.3);
    expect(roundPosPayable(21.3).payable).toBe(21);
  });
});
