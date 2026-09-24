import request from "supertest";
import {
  authHeader,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { round2 } from "../utils/money.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { shopTodayYmd } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("POS final payable rounding", () => {
  let ctx;
  let cashierToken;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 500 });
    expect(shift.status).toBe(201);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function setPrice(price, cost = 5) {
    await ctx.db.run("UPDATE products SET price = ?, cost = ? WHERE id = ?", [price, cost, ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = ?, cost = ? WHERE product_id = ?", [
      price,
      cost,
      ctx.productId,
    ]);
  }

  async function sell(body) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    return res;
  }

  test("cash, visa, mixed, and change use the rounded payable", async () => {
    await setPrice(21.3);
    const cash = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
          payment_method: "cash",
        })
      ).body
    );
    expect(cash.tax).toBe(0);
    expect(cash.discount).toBe(0);
    expect(cash.amount_before_rounding).toBe(21.3);
    expect(cash.rounding_adjustment).toBe(-0.3);
    expect(cash.total).toBe(21);
    const row = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [cash.transaction_id]);
    expect(row.amount_before_rounding).toBe(21.3);
    expect(row.rounding_adjustment).toBe(-0.3);
    expect(row.total).toBe(21);
    const item = await ctx.db.get("SELECT line_net, unit_cost_at_sale FROM transaction_items WHERE transaction_id = ?", [
      cash.transaction_id,
    ]);
    expect(item.line_net).toBe(21.3);
    expect(item.unit_cost_at_sale).toBe(5);
    expect(cash.receipt_html).toContain("تقريب");
    expect(cash.receipt_html).toContain("-0.30");
    expect(cash.receipt_html).toContain("21.00");
    expect(cash.receipt_html).not.toContain("خصم: -0.30");
    expect(cash.receipt_text).toContain("تقريب");

    const replayKey = "payable-replay-2130";
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const first = await sell({
      idempotency_key: replayKey,
      items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
      payment_method: "cash",
    });
    const second = await sell({
      idempotency_key: replayKey,
      items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
      payment_method: "cash",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(unwrap(second.body).transaction_id).toBe(unwrap(first.body).transaction_id);
    expect(unwrap(second.body).total).toBe(21);
    expect(unwrap(second.body).idempotent_replay).toBe(true);
    const copies = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?", [replayKey]);
    expect(Number(copies.n)).toBe(1);
    const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(stockAfter).toBe(stockBefore - 1);

    const overVisa = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
      payment_method: "visa",
      original_amount: 21.3,
    });
    expect(overVisa.status).toBe(400);

    const visa = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 21.3 }],
          payment_method: "visa",
        })
      ).body
    );
    expect(visa.total).toBe(21);
    expect(visa.payment_method).toBe("visa");

    await setPrice(10.3);
    const mixed = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
          payments: [
            { method: "cash", amount: 4 },
            { method: "visa", amount: 6 },
          ],
        })
      ).body
    );
    expect(mixed.total).toBe(10);
    expect(mixed.rounding_adjustment).toBe(-0.3);
    const paid = round2(mixed.payments.reduce((sum, line) => sum + Number(line.nis_equivalent || line.amount), 0));
    expect(paid).toBe(10);

    const change = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
          payments: [{ method: "cash", amount: 50 }],
        })
      ).body
    );
    const changeRow = await ctx.db.get("SELECT change_amount, total FROM transactions WHERE id = ?", [
      change.transaction_id,
    ]);
    expect(changeRow.total).toBe(10);
    expect(changeRow.change_amount).toBe(40);

    const reprint = await request(ctx.app)
      .get(`/api/v1/shifts/transactions/${cash.transaction_id}/receipt`)
      .set(authHeader(adminToken));
    expect(reprint.status).toBe(200);
    const printed = `${unwrap(reprint.body).receipt_html || ""}\n${unwrap(reprint.body).receipt_text || ""}`;
    expect(printed).toContain("تقريب");
    expect(printed).toContain("-0.30");
    expect(printed).toContain("21.00");
  });

  test("discount, weighed lines, and zero tax are applied before the final rounding", async () => {
    await ctx.db.run(
      `INSERT INTO promotions (name, offer_type, product_id, discount_value, active)
       VALUES ('تقريب 10', 'percentage', ?, 10, 1)`,
      [ctx.productId]
    );
    invalidatePromotionsCache();
    await setPrice(6);
    const discounted = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 6 }],
          payment_method: "cash",
        })
      ).body
    );
    expect(discounted.tax).toBe(0);
    expect(discounted.discount).toBe(0.6);
    expect(discounted.amount_before_rounding).toBe(5.4);
    expect(discounted.rounding_adjustment).toBe(-0.4);
    expect(discounted.total).toBe(5);
    const line = await ctx.db.get("SELECT line_net FROM transaction_items WHERE transaction_id = ?", [
      discounted.transaction_id,
    ]);
    expect(line.line_net).toBe(5.4);
    await ctx.db.run("DELETE FROM promotions WHERE name = 'تقريب 10'");
    invalidatePromotionsCache();

    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "7702000099",
        name: "ميزان تقريب",
        price: 20,
        cost: 10,
        stock: 5,
        category: "ألبان",
        unit: "كغم",
        is_weighed: true,
      });
    expect(created.status).toBe(201);
    const weighed = unwrap(created.body);
    const units = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/products/${weighed.id}/units`)
          .set(authHeader(adminToken))
      ).body
    );
    const kg = (Array.isArray(units) ? units : units.units || []).find((unit) => unit.unit_name === "كغم");
    expect(kg).toBeTruthy();
    await setPrice(2.3);
    const combined = unwrap(
      (
        await sell({
          items: [
            { product_id: weighed.id, unit_id: kg.id, quantity: 0.255, price: 20 },
            { product_id: ctx.productId, quantity: 1, price: 2.3 },
          ],
          payment_method: "cash",
        })
      ).body
    );
    expect(combined.subtotal).toBe(7.3);
    expect(combined.tax).toBe(0);
    expect(combined.amount_before_rounding).toBe(7.3);
    expect(combined.total).toBe(7);
    expect(combined.rounding_adjustment).toBe(-0.3);
    const lines = await ctx.db.all(
      "SELECT line_gross FROM transaction_items WHERE transaction_id = ? ORDER BY line_gross",
      [combined.transaction_id]
    );
    expect(lines.map((entry) => entry.line_gross)).toEqual([2.3, 5]);
  });

  test("customer and employee ذمة use the rounded credit, including the limit override", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('حد التقريب', 'RND-LIM', 0, 0, 5)`
    );
    await setPrice(5.6);
    const over = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 5.6 }],
      payment_method: "on_account",
      customer_id: cust.lastID,
    });
    expect(over.status).toBe(202);
    const overId = unwrap(over.body).request_id;
    const blocked = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${overId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code || unwrap(blocked.body).code).toBe("CREDIT_LIMIT_EXCEEDED");
    const forced = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${overId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved", override_credit_limit: true });
    expect(forced.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [cust.lastID])).balance)).toBe(6);

    const exact = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('حد مطابق', 'RND-EXACT', 0, 0, 5)`
    );
    await setPrice(5.4);
    const within = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 5.4 }],
      payment_method: "on_account",
      customer_id: exact.lastID,
    });
    expect(within.status).toBe(202);
    const withinApproved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(within.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(withinApproved.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [exact.lastID])).balance)).toBe(5);

    const emp = await createTestEmployee(ctx.db, { name: "موظف تقريب" });
    await setPrice(2.3);
    const pending = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 2.3 }],
      payment_method: "on_account",
      employee_id: emp.id,
    });
    expect(pending.status).toBe(202);
    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(pending.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const linked = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id]);
    expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [linked.customer_id])).balance)).toBe(
      2
    );
  });

  test("full and repeated partial refunds stay inside the original paid total", async () => {
    await setPrice(10.3);
    const sale = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 2, price: 10.3 }],
          payment_method: "cash",
        })
      ).body
    );
    expect(sale.amount_before_rounding).toBe(20.6);
    expect(sale.total).toBe(21);
    expect(sale.rounding_adjustment).toBe(0.4);
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [ctx.productId]);

    async function refundQty(qty) {
      const created = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: sale.transaction_id,
          payment_method: "cash",
          reason: "تقريب",
          lines: [{ product_id: ctx.productId, unit_id: unit.id, quantity: qty }],
        });
      expect(created.status).toBe(201);
      const body = unwrap(created.body);
      const approved = await request(ctx.app)
        .put(`/api/v1/refund-requests/${body.request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(approved.status).toBe(200);
      return Number(body.request.total_amount);
    }

    const first = await refundQty(1);
    expect(first).toBe(10.5);
    expect(first).not.toBe(10);
    const second = await refundQty(1);
    expect(round2(first + second)).toBe(21);
    const refunds = await ctx.db.all("SELECT total, rounding_adjustment FROM refunds WHERE original_transaction_id = ?", [
      sale.transaction_id,
    ]);
    expect(round2(refunds.reduce((sum, row) => sum + Number(row.total), 0))).toBe(21);
    const extra = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.transaction_id,
        payment_method: "cash",
        lines: [{ product_id: ctx.productId, quantity: 1 }],
      });
    expect(extra.status).toBe(400);

    const whole = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
          payment_method: "visa",
        })
      ).body
    );
    const full = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: whole.transaction_id,
        payment_method: "visa",
        lines: [{ product_id: ctx.productId, unit_id: unit.id, quantity: 1 }],
      });
    expect(Number(unwrap(full.body).request.total_amount)).toBe(10);
    expect(whole.total).toBe(10);
  });

  test("a zero payable still moves stock and is not raised to one shekel", async () => {
    await setPrice(0.4);
    const before = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const res = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: 0.4 }],
      payment_method: "cash",
    });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    expect(body.total).toBe(0);
    expect(body.amount_before_rounding).toBe(0.4);
    expect(body.rounding_adjustment).toBe(-0.4);
    const after = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    expect(after).toBe(before - 1);
    const ledger = await ctx.db.get(
      "SELECT quantity_delta FROM inventory_ledger WHERE reference_id = ? AND movement_type = 'sale'",
      [body.transaction_id]
    );
    expect(Number(ledger.quantity_delta)).toBe(-1);
  });

  test("historical sales without an adjustment stay at the stored amount", async () => {
    await setPrice(2.3);
    const sale = unwrap(
      (
        await sell({
          items: [{ product_id: ctx.productId, quantity: 1, price: 2.3 }],
          payment_method: "cash",
        })
      ).body
    );
    expect(sale.total).toBe(2);
    await ctx.db.run(
      `UPDATE transactions
          SET total = 2.3, amount_before_rounding = NULL, rounding_adjustment = NULL
        WHERE id = ?`,
      [sale.transaction_id]
    );
    await ctx.db.run(
      `UPDATE transaction_items SET unit_price = 2.3, line_net = 2.3, line_gross = 2.3 WHERE transaction_id = ?`,
      [sale.transaction_id]
    );
    await ctx.db.run(
      `UPDATE sale_payments SET amount = 2.3, original_amount = 2.3, nis_equivalent = 2.3 WHERE transaction_id = ?`,
      [sale.transaction_id]
    );
    const unit = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [ctx.productId]);
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.transaction_id,
        payment_method: "cash",
        lines: [{ product_id: ctx.productId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    expect(Number(unwrap(created.body).request.total_amount)).toBe(2.3);
    const stored = await ctx.db.get("SELECT total, rounding_adjustment FROM transactions WHERE id = ?", [
      sale.transaction_id,
    ]);
    expect(stored.total).toBe(2.3);
    expect(stored.rounding_adjustment).toBeNull();
  });

  test("an office invoice keeps its document total", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('مكتب تقريب', 'RND-OFF', 0, 0)`
    );
    const draft = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: cust.lastID,
        invoice_date: "2026-09-23",
        items: [{ product_id: ctx.productId, quantity: 1, total_price: 2.3 }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(posted.status).toBe(200);
    const tx = await ctx.db.get("SELECT total, rounding_adjustment, amount_before_rounding FROM transactions WHERE id = ?", [
      unwrap(posted.body).transaction_id,
    ]);
    expect(tx.total).toBe(2.3);
    expect(tx.rounding_adjustment).toBeNull();
    expect(tx.amount_before_rounding).toBeNull();
  });

  test("the daily report reconciles item revenue and rounding without changing cost", async () => {
    const today = shopTodayYmd();
    const reportRes = await request(ctx.app)
      .get("/api/v1/reports/daily")
      .query({ date: today })
      .set(authHeader(adminToken));
    expect(reportRes.status).toBe(200);
    const report = unwrap(reportRes.body);
    const pos = await ctx.db.all(
      `SELECT t.id, t.total, t.rounding_adjustment
         FROM transactions t
        WHERE NOT EXISTS (
          SELECT 1 FROM sales_invoices si WHERE si.transaction_id = t.id AND si.status = 'posted'
        )`
    );
    const ids = pos.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const items = await ctx.db.get(
      `SELECT COALESCE(SUM(line_net), 0) AS revenue,
              COALESCE(SUM(unit_cost_at_sale * quantity), 0) AS cogs
         FROM transaction_items
        WHERE transaction_id IN (${placeholders})
          AND unit_cost_at_sale IS NOT NULL`,
      ids
    );
    const adjustment = round2(pos.reduce((sum, row) => sum + (Number(row.rounding_adjustment) || 0), 0));
    const payable = round2(pos.reduce((sum, row) => sum + Number(row.total), 0));
    expect(report.rounding_adjustment).toBe(adjustment);
    expect(round2(Number(items.revenue) + adjustment)).toBe(payable);
    expect(report.total_sales).toBe(round2(payable + 2.3));
    const sample = await ctx.db.get(
      `SELECT unit_cost_at_sale, line_net, gross_profit
         FROM transaction_items
        WHERE line_net = 21.3`
    );
    expect(sample.unit_cost_at_sale).toBe(5);
    expect(round2(sample.line_net - sample.unit_cost_at_sale)).toBe(sample.gross_profit);
  });
});
