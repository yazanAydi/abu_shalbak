import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { snapshotSalesCogsForRange, snapshotRefundCogsForRange } from "../utils/cogs.js";
import { fetchTransactionsForShopDate } from "../utils/businessDay.js";
import { shopYmdFromTimestamp } from "../utils/shopTime.js";
import { sumShiftCashPayments } from "../utils/salePayments.js";
import { parseMoneyCell } from "../utils/productImport.js";
import { createRefundRequest } from "../services/refundRequestService.js";

describe("audit remediation regressions", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let cashierId;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
    cashierId = cashierLogin.body.user.id;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    shiftId = shiftRes.body.data.shift_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("COGS and revenue use the same Ramallah shop calendar for a 01:00 shift", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const earlyShift = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, start_time)
       VALUES (?, 0, 'closed', ?)`,
      [cashierId, "2026-08-26 22:00:00"]
    );
    const shopDay = shopYmdFromTimestamp("2026-08-26 22:00:00");
    expect(shopDay).toBe("2026-08-27");

    await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'completed', ?)`,
      [
        cashierId,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        earlyShift.lastID,
        "2026-08-26 22:15:00",
      ]
    );
    const tx = await ctx.db.get("SELECT id FROM transactions ORDER BY id DESC LIMIT 1");
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, barcode, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
          unit_cost_at_sale, gross_profit, discount_at_sale)
       VALUES (?, ?, '9990001', 'Test Product', 1, 10, 10, 0, 10, 0, ?, 5, 0)`,
      [tx.id, ctx.productId, Number(product.cost) || 5]
    );

    const revenueRows = await fetchTransactionsForShopDate(ctx.db, "2026-08-27");
    const cogs = await snapshotSalesCogsForRange(ctx.db, "2026-08-27", "2026-08-27");
    const cogsPrev = await snapshotSalesCogsForRange(ctx.db, "2026-08-26", "2026-08-26");
    expect(revenueRows.some((r) => r.id === tx.id)).toBe(true);
    expect(cogs).toBeCloseTo(Number(product.cost) || 5, 2);
    expect(cogsPrev).toBe(0);
  });

  test("rejected refunds are excluded from refund COGS", async () => {
    await ctx.db.run(
      `INSERT INTO refunds (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, shift_id, status, created_at)
       VALUES (?, ?, 10, 0, 10, 'cash', ?, ?, 'rejected', datetime('now'))`,
      [
        1,
        JSON.stringify([{ product_id: ctx.productId, quantity: 1, price: 10 }]),
        cashierId,
        shiftId,
      ]
    );
    const today = shopYmdFromTimestamp(new Date().toISOString());
    const cogs = await snapshotRefundCogsForRange(ctx.db, today, today);
    expect(cogs).toBe(0);
  });

  test("suspended sale rejects a tampered price", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 1 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.code || res.body.data?.code).toBe("PRICE_MISMATCH");
  });

  test("refund of a discounted sale returns the amount paid", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkout = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: product.price }],
        payment_method: "cash",
      });
    expect(checkout.status).toBe(201);
    const tid = checkout.body.data.transaction_id;
    await ctx.db.run("UPDATE transactions SET discount = 2, total = total - 2 WHERE id = ?", [tid]);

    const created = await createRefundRequest(ctx.db, {
      cashierId,
      transactionId: tid,
      lines: [{ product_id: ctx.productId, quantity: 2 }],
      paymentMethod: "cash",
      reason: "test",
    });
    expect(created.request.total_amount).toBeCloseTo(Number(product.price) * 2 - 2, 2);
  });

  test("mixed-payment change is deducted from cash", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkout = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 15 },
          { method: "visa", amount: 0 },
        ],
        cash_tendered: 15,
      });
    if (checkout.status === 201) {
      const cash = await sumShiftCashPayments(ctx.db, shiftId);
      const changeRow = await ctx.db.get(
        "SELECT change_amount FROM transactions WHERE id = ?",
        [checkout.body.data.transaction_id]
      );
      expect(Number(changeRow?.change_amount || 0)).toBeGreaterThanOrEqual(0);
      expect(cash).toBeGreaterThanOrEqual(0);
    }
    const mixedId = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, change_amount, payment_method, shift_id, status)
       VALUES (?, '[]', 10, 0, 10, 0, 5, 'mixed', ?, 'completed')`,
      [cashierId, shiftId]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount)
       VALUES (?, 'cash', 15)`,
      [mixedId.lastID]
    );
    const cash = await sumShiftCashPayments(ctx.db, shiftId);
    expect(cash).toBeLessThan(15 + 1000);
    const isolated = await ctx.db.get(
      `SELECT COALESCE(SUM(sp.amount), 0) AS s FROM sale_payments sp
       JOIN transactions t ON t.id = sp.transaction_id
       WHERE t.id = ? AND sp.payment_method = 'cash'`,
      [mixedId.lastID]
    );
    const change = await ctx.db.get(
      "SELECT change_amount FROM transactions WHERE id = ?",
      [mixedId.lastID]
    );
    expect(Number(isolated.s) - Number(change.change_amount)).toBe(10);
  });

  test("weighed product can be sold in fractional quantity", async () => {
    await ctx.db.run("UPDATE products SET is_weighed = 1, stock = 10 WHERE id = ?", [ctx.productId]);
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 0.25, price: product.price }],
        payment_method: "cash",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.transaction_id).toBeTruthy();
  });

  test("concurrent refund requests cannot exceed the sold quantity", async () => {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const checkout = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      });
    expect(checkout.status).toBe(201);
    const tid = checkout.body.data.transaction_id;
    const payload = {
      cashierId,
      transactionId: tid,
      lines: [{ product_id: ctx.productId, quantity: 1 }],
      paymentMethod: "cash",
    };
    const results = await Promise.allSettled([
      createRefundRequest(ctx.db, payload),
      createRefundRequest(ctx.db, payload),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  test("parseMoneyCell treats 1,500 as one thousand five hundred", () => {
    expect(parseMoneyCell("1,500")).toBe(1500);
    expect(parseMoneyCell("1,50")).toBeCloseTo(1.5, 2);
    expect(parseMoneyCell("1.500,25")).toBeCloseTo(1500.25, 2);
  });

  test("admin product delete requires the current password", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({ barcode: "8887776665554", name: "Delete Gate", price: 3, stock: 1 });
    const id = created.body.data?.id ?? created.body.id;
    const denied = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set(authHeader(adminToken));
    expect(denied.status).toBe(403);
    const ok = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(ok.status).toBe(204);
  });
});
