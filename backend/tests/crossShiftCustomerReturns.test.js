import bcrypt from "bcrypt";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { approveRefundRequest } from "../services/refundRequestService.js";
import { computeExpectedCash, computeShiftVisa } from "../utils/salePayments.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";

const BANNED_KEYS = new Set([
  "cost",
  "unit_cost",
  "unit_cost_at_sale",
  "gross_profit",
  "supplier",
  "supplier_id",
  "supplier_balance",
  "cost_known",
]);

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function assertNoSensitive(payload) {
  for (const key of collectKeys(payload)) {
    expect(BANNED_KEYS.has(key)).toBe(false);
  }
}

describe("customer returns across shifts", () => {
  let ctx;
  let cashierToken;
  let cashier2Token;
  let adminToken;
  let adminUser;
  let productB;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
    adminUser = await ctx.db.get("SELECT id, username, role FROM users WHERE username = 'testadmin'");

    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["testcashier2", hash]
    );
    const cashier2Login = await login(ctx.app, "testcashier2", "cashpass123", "pos");
    cashier2Token = cashier2Login.body.token;

    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990002', 'Second Product', 8, 3, 'Test', 100)`
    );
    productB = ins.lastID;
    await ctx.db.run(
      `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, '9990002', 1)`,
      [productB]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990002', 8, 3, 1, 1)`,
      [productB]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.db.run(`UPDATE refund_requests SET status = 'rejected' WHERE status = 'pending'`);
    await ctx.db.run(
      `UPDATE cashier_shifts SET status = 'closed', end_time = COALESCE(end_time, datetime('now')) WHERE status != 'closed'`
    );
    await ctx.db.run("UPDATE promotions SET active = 0");
    invalidatePromotionsCache();
    await ctx.db.run("UPDATE products SET is_weighed = 0, price = 10, cost = 5 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      `UPDATE product_units SET unit_name = 'حبة', price = 10, cost = 5, conversion_to_base = 1
        WHERE product_id = ?`,
      [ctx.productId]
    );
  });

  async function startShift(token, opening = 500) {
    const res = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(token))
      .send({ opening_cash: opening });
    expect(res.status).toBe(201);
    const id = res.body.data?.shift_id ?? res.body.shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, id]);
    return id;
  }

  async function endShift(token, shiftId) {
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
  }

  async function finalizeShift(token, shiftId) {
    await endShift(token, shiftId);
    const row = await ctx.db.get("SELECT opening_cash FROM cashier_shifts WHERE id = ?", [shiftId]);
    const expected = await computeExpectedCash(ctx.db, shiftId, row.opening_cash);
    const res = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: expected });
    expect(res.status).toBe(200);
    const closed = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(closed.status).toBe("closed");
    return expected;
  }

  async function frozenShift(shiftId) {
    return ctx.db.get(
      `SELECT status, opening_cash, closing_cash, expected_cash, variance, actual_cash,
              card_total, refund_total, counted_cash_json, business_day
         FROM cashier_shifts WHERE id = ?`,
      [shiftId]
    );
  }

  async function expectedCash(shiftId) {
    const row = await ctx.db.get("SELECT opening_cash FROM cashier_shifts WHERE id = ?", [shiftId]);
    return computeExpectedCash(ctx.db, shiftId, row.opening_cash);
  }

  async function checkout(token, { qty = 1, price = 10, method = "cash", productId = ctx.productId, extraItems = [] } = {}) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(token))
      .send(
        withCheckoutKey({
          items: [{ product_id: productId, quantity: qty, price }, ...extraItems],
          payment_method: method,
        })
      );
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function saleSnapshot(txId) {
    const tx = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    const items = await ctx.db.all(
      "SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [txId]
    );
    return JSON.stringify({ tx, items });
  }

  function refundLines(productId, qty, extra = {}) {
    return [{ product_id: productId, quantity: qty, ...extra }];
  }

  async function postRefund(token, txId, lines, method = "cash", extra = {}) {
    return request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(token))
      .send({
        original_transaction_id: txId,
        lines,
        payment_method: method,
        reason: "customer return",
        ...extra,
      });
  }

  async function approve(requestId) {
    const res = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    return res.body.data?.refund ?? res.body.refund;
  }

  async function lookup(token, key) {
    const res = await request(ctx.app)
      .get(`/api/v1/refunds/lookup/${encodeURIComponent(key)}`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    return res.body.data;
  }

  test("1. cash return during the same open shift reduces that drawer and restores stock", async () => {
    const shiftId = await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, { qty: 2, price: 10 });
    const before = await saleSnapshot(sale.transaction_id);
    const stockAfterSale = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(await expectedCash(shiftId)).toBe(520);

    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 2));
    expect(created.status).toBe(201);
    const stockWhilePending = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(stockWhilePending).toBe(stockAfterSale);

    await approve(created.body.data.request_id);
    expect(await expectedCash(shiftId)).toBe(500);
    const refund = await ctx.db.get(
      "SELECT * FROM refunds WHERE original_transaction_id = ? ORDER BY id DESC LIMIT 1",
      [sale.transaction_id]
    );
    expect(Number(refund.shift_id)).toBe(Number(shiftId));
    expect(Number(refund.total)).toBe(20);
    expect(refund.payment_method).toBe("cash");
    const stockAfter = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(stockAfter).toBe(stockAfterSale + 2);
    expect(await saleSnapshot(sale.transaction_id)).toBe(before);
  });

  test("2. return on another cashier's open shift posts to the processing shift", async () => {
    const shiftA = await startShift(cashierToken, 100);
    const sale = await checkout(cashierToken, { qty: 2, price: 10 });
    const beforeA = await frozenShift(shiftA);
    const shiftB = await startShift(cashier2Token, 500);
    const created = await postRefund(cashier2Token, sale.transaction_id, refundLines(ctx.productId, 2));
    expect(created.status).toBe(201);
    await approve(created.body.data.request_id);

    const refund = await ctx.db.get(
      "SELECT shift_id, cashier_id, original_transaction_id FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const cashier2 = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier2'");
    expect(Number(refund.shift_id)).toBe(Number(shiftB));
    expect(Number(refund.cashier_id)).toBe(Number(cashier2.id));
    expect(Number(refund.original_transaction_id)).toBe(Number(sale.transaction_id));
    const saleRow = await ctx.db.get("SELECT shift_id FROM transactions WHERE id = ?", [sale.transaction_id]);
    expect(Number(saleRow.shift_id)).toBe(Number(shiftA));
    expect(await expectedCash(shiftA)).toBe(120);
    expect(await expectedCash(shiftB)).toBe(480);
    expect(await frozenShift(shiftA)).toEqual(beforeA);
  });

  test("3-6. return after the original shift is closed and counted leaves that count unchanged", async () => {
    const shiftA = await startShift(cashierToken, 100);
    const sale = await checkout(cashierToken, { qty: 2, price: 10 });
    const beforeSale = await saleSnapshot(sale.transaction_id);
    await finalizeShift(cashierToken, shiftA);
    const frozen = await frozenShift(shiftA);
    expect(frozen.status).toBe("closed");
    expect(Number(frozen.expected_cash)).toBe(120);

    const shiftB = await startShift(cashierToken, 500);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-02-02", shiftB]);
    const sold = await checkout(cashierToken, { qty: 30, price: 10 });
    expect(await expectedCash(shiftB)).toBe(800);

    const soldBefore = await saleSnapshot(sold.transaction_id);
    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 2));
    expect(created.status).toBe(201);
    await approve(created.body.data.request_id);

    expect(await expectedCash(shiftB)).toBe(780);
    const visa = await computeShiftVisa(ctx.db, shiftB);
    expect(visa.visa_refunds).toBe(0);
    expect(await frozenShift(shiftA)).toEqual(frozen);
    expect(await saleSnapshot(sale.transaction_id)).toBe(beforeSale);
    expect(await saleSnapshot(sold.transaction_id)).toBe(soldBefore);

    const refund = await ctx.db.get(
      "SELECT * FROM refunds WHERE original_transaction_id = ? ORDER BY id DESC LIMIT 1",
      [sale.transaction_id]
    );
    expect(Number(refund.shift_id)).toBe(Number(shiftB));
    expect(refund.business_day).toBe("2026-02-02");
    expect(Number(refund.original_transaction_id)).toBe(Number(sale.transaction_id));
    const movementA = await ctx.db.get(
      "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND refund_id = ?",
      [shiftA, refund.id]
    );
    expect(movementA).toBeFalsy();
    const movementB = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE shift_id = ? AND refund_id = ?",
      [shiftB, refund.id]
    );
    expect(Number(movementB.amount)).toBe(-20);
  });

  test("7. a visa refund reduces visa totals and not the cash drawer", async () => {
    const shiftId = await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, { qty: 1, price: 10, method: "visa" });
    expect(await expectedCash(shiftId)).toBe(500);
    const created = await postRefund(
      cashierToken,
      sale.transaction_id,
      refundLines(ctx.productId, 1),
      "visa"
    );
    expect(created.status).toBe(201);
    await approve(created.body.data.request_id);
    expect(await expectedCash(shiftId)).toBe(500);
    const visa = await computeShiftVisa(ctx.db, shiftId);
    expect(visa.visa_sales).toBe(10);
    expect(visa.visa_refunds).toBe(10);
    expect(visa.visa_net).toBe(0);
    const cashMove = await ctx.db.get(
      `SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'refund'`,
      [shiftId]
    );
    expect(cashMove).toBeFalsy();
  });

  test("8. a visa sale can be refunded in cash and both methods are stored", async () => {
    const shiftA = await startShift(cashierToken, 100);
    const sale = await checkout(cashierToken, { qty: 1, price: 10, method: "visa" });
    await finalizeShift(cashierToken, shiftA);
    const frozen = await frozenShift(shiftA);
    const shiftB = await startShift(cashier2Token, 500);
    const created = await postRefund(
      cashier2Token,
      sale.transaction_id,
      refundLines(ctx.productId, 1),
      "cash"
    );
    expect(created.status).toBe(201);
    await approve(created.body.data.request_id);

    const refund = await ctx.db.get(
      "SELECT payment_method, shift_id, total FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const originalPay = await ctx.db.get(
      "SELECT payment_method FROM sale_payments WHERE transaction_id = ?",
      [sale.transaction_id]
    );
    expect(originalPay.payment_method).toBe("visa");
    expect(refund.payment_method).toBe("cash");
    expect(Number(refund.total)).toBe(10);
    expect(Number(refund.shift_id)).toBe(Number(shiftB));
    expect(await expectedCash(shiftB)).toBe(490);
    const visaB = await computeShiftVisa(ctx.db, shiftB);
    expect(visaB.visa_refunds).toBe(0);
    expect(await frozenShift(shiftA)).toEqual(frozen);
    const txMethod = await ctx.db.get("SELECT payment_method FROM transactions WHERE id = ?", [
      sale.transaction_id,
    ]);
    expect(txMethod.payment_method).toBe("visa");
  });

  test("9-10. inventory increases on the return business day and the sale movement stays put", async () => {
    const shiftA = await startShift(cashierToken, 100);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-01-01", shiftA]);
    const sale = await checkout(cashierToken, { qty: 1, price: 10 });
    const saleMove = await ctx.db.get(
      `SELECT id, quantity_delta, business_day, movement_type, reference_type, reference_id, notes, created_at
         FROM inventory_ledger
        WHERE reference_type = 'transaction' AND reference_id = ?`,
      [sale.transaction_id]
    );
    expect(Number(saleMove.quantity_delta)).toBe(-1);
    expect(saleMove.business_day).toBe("2026-01-01");
    const saleMoveBefore = JSON.stringify(saleMove);
    await finalizeShift(cashierToken, shiftA);

    const shiftB = await startShift(cashierToken, 500);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-01-02", shiftB]);
    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    await approve(created.body.data.request_id);
    const refund = await ctx.db.get(
      "SELECT id, business_day, shift_id FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const refundMove = await ctx.db.get(
      `SELECT quantity_delta, business_day, movement_type, reference_type, reference_id, notes, user_id
         FROM inventory_ledger
        WHERE reference_type = 'refund' AND reference_id = ?`,
      [refund.id]
    );
    expect(Number(refundMove.quantity_delta)).toBe(1);
    expect(refundMove.business_day).toBe("2026-01-02");
    expect(refundMove.notes).toContain(String(sale.transaction_id));
    expect(refund.business_day).toBe("2026-01-02");
    expect(Number(refund.shift_id)).toBe(Number(shiftB));
    const saleMoveAfter = await ctx.db.get(
      `SELECT id, quantity_delta, business_day, movement_type, reference_type, reference_id, notes, created_at
         FROM inventory_ledger WHERE id = ?`,
      [saleMove.id]
    );
    expect(JSON.stringify(saleMoveAfter)).toBe(saleMoveBefore);
    const view = await lookup(cashierToken, sale.transaction_id);
    expect(view.business_day).toBe("2026-01-01");
    expect(Number(view.shift_id)).toBe(Number(shiftA));
  });

  test("11-14. partial returns, a second partial, over-return, and a fully returned line", async () => {
    const shiftId = await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, { qty: 5, price: 10 });
    const first = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 2));
    expect(first.status).toBe(201);
    await approve(first.body.data.request_id);
    let view = await lookup(cashierToken, sale.transaction_id);
    expect(view.lines[0].quantity_sold).toBe(5);
    expect(view.lines[0].quantity_already_refunded).toBe(2);
    expect(view.lines[0].quantity_returnable).toBe(3);
    expect(view.returns).toHaveLength(1);
    expect(view.returns[0].kind).toBe("refund");
    expect(Number(view.returns[0].shift_id)).toBe(Number(shiftId));

    const second = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(second.status).toBe(201);
    await approve(second.body.data.request_id);
    view = await lookup(cashierToken, sale.transaction_id);
    expect(view.lines[0].quantity_already_refunded).toBe(3);
    expect(view.lines[0].quantity_returnable).toBe(2);
    expect(view.returns).toHaveLength(2);

    const over = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 3));
    expect(over.status).toBe(400);
    const pending = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refund_requests WHERE transaction_id = ? AND status = 'pending'",
      [sale.transaction_id]
    );
    expect(Number(pending.n)).toBe(0);

    const rest = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 2));
    expect(rest.status).toBe(201);
    await approve(rest.body.data.request_id);
    view = await lookup(cashierToken, sale.transaction_id);
    expect(view.lines[0].quantity_returnable).toBe(0);
    const again = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(again.status).toBe(400);
  });

  test("15. one item can be returned from a multi-item invoice", async () => {
    await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, {
      qty: 2,
      price: 10,
      extraItems: [{ product_id: productB, quantity: 3, price: 8 }],
    });
    const before = await saleSnapshot(sale.transaction_id);
    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(created.status).toBe(201);
    const quote = await request(ctx.app)
      .post("/api/v1/refund-requests/preview")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.transaction_id,
        lines: refundLines(ctx.productId, 1),
        payment_method: "cash",
      });
    expect(quote.status).toBe(200);
    expect(Number(quote.body.data.total)).toBe(10);
    await approve(created.body.data.request_id);
    const view = await lookup(cashierToken, sale.transaction_id);
    const lineA = view.lines.find((line) => Number(line.product_id) === Number(ctx.productId));
    const lineB = view.lines.find((line) => Number(line.product_id) === Number(productB));
    expect(lineA.quantity_returnable).toBe(1);
    expect(lineB.quantity_sold).toBe(3);
    expect(lineB.quantity_already_refunded).toBe(0);
    expect(lineB.quantity_returnable).toBe(3);
    expect(await saleSnapshot(sale.transaction_id)).toBe(before);
    const refund = await ctx.db.get(
      "SELECT items_json, original_transaction_id FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const items = JSON.parse(refund.items_json);
    expect(items).toHaveLength(1);
    expect(Number(items[0].product_id)).toBe(Number(ctx.productId));
    expect(Number(items[0].transaction_item_id)).toBeGreaterThan(0);
    expect(Number(refund.original_transaction_id)).toBe(Number(sale.transaction_id));
  });

  test("16-17. refund uses the historical paid price, including a promotion discount", async () => {
    await startShift(cashierToken, 500);
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
       VALUES ('Half off return', 'percentage', ?, 50, 0, 0, 1)`,
      [ctx.productId]
    );
    invalidatePromotionsCache();
    const sale = await checkout(cashierToken, { qty: 1, price: 10 });
    expect(Number(sale.total)).toBe(5);
    expect(Number(sale.discount)).toBe(5);
    await ctx.db.run("UPDATE products SET price = 12 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 12 WHERE product_id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE promotions SET active = 0");
    invalidatePromotionsCache();

    const view = await lookup(cashierToken, sale.transaction_id);
    expect(Number(view.lines[0].price)).toBe(5);
    expect(Number(view.lines[0].list_price)).toBe(10);
    expect(Number(view.discount)).toBe(5);
    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(created.status).toBe(201);
    expect(Number(created.body.data.request.total_amount)).toBe(5);
    await approve(created.body.data.request_id);
    const refund = await ctx.db.get("SELECT total, items_json FROM refunds WHERE original_transaction_id = ?", [
      sale.transaction_id,
    ]);
    expect(Number(refund.total)).toBe(5);
    expect(Number(JSON.parse(refund.items_json)[0].price)).toBe(5);
  });

  test("18. a weighed quantity refunds the original per-kilo price", async () => {
    await startShift(cashierToken, 500);
    await ctx.db.run("UPDATE products SET is_weighed = 1, price = 10 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET unit_name = 'كغم', price = 10 WHERE product_id = ?",
      [ctx.productId]
    );
    const sale = await checkout(cashierToken, { qty: 1.25, price: 10 });
    expect(Number(sale.total)).toBe(12.5);
    const saleMove = await ctx.db.get(
      `SELECT id, quantity_delta, business_day FROM inventory_ledger
        WHERE reference_type = 'transaction' AND reference_id = ?`,
      [sale.transaction_id]
    );
    expect(Number(saleMove.quantity_delta)).toBeCloseTo(-1.25, 5);
    await ctx.db.run("UPDATE products SET price = 99 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 99 WHERE product_id = ?", [ctx.productId]);

    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 0.5));
    expect(created.status).toBe(201);
    expect(Number(created.body.data.request.total_amount)).toBe(5);
    await approve(created.body.data.request_id);
    const view = await lookup(cashierToken, sale.transaction_id);
    expect(view.lines[0].quantity_sold).toBe(1.25);
    expect(view.lines[0].quantity_already_refunded).toBe(0.5);
    expect(view.lines[0].quantity_returnable).toBeCloseTo(0.75, 5);
    const refund = await ctx.db.get(
      "SELECT id FROM refunds WHERE original_transaction_id = ? ORDER BY id DESC LIMIT 1",
      [sale.transaction_id]
    );
    const refundMove = await ctx.db.get(
      `SELECT quantity_delta, notes FROM inventory_ledger
        WHERE reference_type = 'refund' AND reference_id = ?`,
      [refund.id]
    );
    expect(Number(refundMove.quantity_delta)).toBeCloseTo(0.5, 5);
    expect(refundMove.notes).toContain(String(sale.transaction_id));
    const saleMoveAfter = await ctx.db.get(
      "SELECT quantity_delta, business_day FROM inventory_ledger WHERE id = ?",
      [saleMove.id]
    );
    expect(Number(saleMoveAfter.quantity_delta)).toBeCloseTo(-1.25, 5);
    expect(saleMoveAfter.business_day).toBe(saleMove.business_day);
  });

  test("19-23. another cashier can read the receipt, not edit it, and not see cost", async () => {
    const shiftA = await startShift(cashierToken, 100);
    const sale = await checkout(cashierToken, { qty: 1, price: 10 });
    const before = await saleSnapshot(sale.transaction_id);
    await startShift(cashier2Token, 200);

    const view = await lookup(cashier2Token, sale.receipt_number);
    expect(view.transaction_id).toBe(sale.transaction_id);
    expect(view.receipt_number).toBe(sale.receipt_number);
    expect(view.lines[0].name).toBeTruthy();
    expect(view.lines[0].quantity_sold).toBe(1);
    expect(Number(view.lines[0].price)).toBe(10);
    expect(view.payments[0].method).toBe("cash");
    expect(Number(view.shift_id)).toBe(Number(shiftA));
    expect(view.cashier_username).toBe("testcashier");
    assertNoSensitive(view);

    const search = await request(ctx.app)
      .get("/api/v1/refunds/search")
      .query({ receipt: sale.receipt_number })
      .set(authHeader(cashier2Token));
    expect(search.status).toBe(200);
    expect(search.body.data.sales).toHaveLength(1);
    expect(search.body.data.sales[0].transaction_id).toBe(sale.transaction_id);
    assertNoSensitive(search.body.data);

    const putTx = await request(ctx.app)
      .put(`/api/v1/transactions/${sale.transaction_id}`)
      .set(authHeader(cashier2Token))
      .send({ total: 1 });
    expect([403, 404, 405]).toContain(putTx.status);
    const delTx = await request(ctx.app)
      .delete(`/api/v1/transactions/${sale.transaction_id}`)
      .set(authHeader(cashier2Token));
    expect([403, 404, 405]).toContain(delTx.status);
    const putInvoice = await request(ctx.app)
      .put(`/api/v1/sales/invoices/${sale.transaction_id}`)
      .set(authHeader(cashier2Token))
      .send({ total: 1 });
    expect([401, 403, 404]).toContain(putInvoice.status);

    const created = await postRefund(cashier2Token, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(created.status).toBe(201);
    await approve(created.body.data.request_id);
    expect(await saleSnapshot(sale.transaction_id)).toBe(before);
    const after = await lookup(cashier2Token, sale.transaction_id);
    assertNoSensitive(after);
    expect(after.returns[0].refund_method).toBe("cash");
    expect(after.returns[0].cashier_username).toBe("testcashier2");
    const cashier2 = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier2'");
    const refund = await ctx.db.get(
      "SELECT cashier_id, shift_id, items_json, original_transaction_id FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    expect(Number(refund.cashier_id)).toBe(Number(cashier2.id));
    expect(Number(refund.shift_id)).not.toBe(Number(shiftA));
    const item = JSON.parse(refund.items_json)[0];
    const originalItem = await ctx.db.get(
      "SELECT id FROM transaction_items WHERE transaction_id = ?",
      [sale.transaction_id]
    );
    expect(Number(item.transaction_item_id)).toBe(Number(originalItem.id));
    expect(Number(refund.original_transaction_id)).toBe(Number(sale.transaction_id));
  });

  test("24. the return keeps the processing shift business day, not the sale day", async () => {
    const shiftA = await startShift(cashierToken, 100);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-03-01", shiftA]);
    const sale = await checkout(cashierToken, { qty: 1, price: 10 });
    await finalizeShift(cashierToken, shiftA);
    const shiftB = await startShift(cashier2Token, 400);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-03-02", shiftB]);
    const created = await postRefund(cashier2Token, sale.transaction_id, refundLines(ctx.productId, 1));
    await approve(created.body.data.request_id);
    const refund = await ctx.db.get(
      "SELECT business_day, shift_id FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const saleShift = await ctx.db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [shiftA]);
    expect(saleShift.business_day).toBe("2026-03-01");
    expect(refund.business_day).toBe("2026-03-02");
    expect(Number(refund.shift_id)).toBe(Number(shiftB));
    const view = await lookup(cashierToken, sale.transaction_id);
    expect(view.business_day).toBe("2026-03-01");
    expect(view.returns[0].business_day).toBe("2026-03-02");
  });

  test("25. repeating the same idempotency key does not create a second return", async () => {
    await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, { qty: 2, price: 10 });
    const key = "ret-idem-cross-shift-0001";
    const lines = refundLines(ctx.productId, 1);
    const first = await postRefund(cashierToken, sale.transaction_id, lines, "cash", {
      idempotency_key: key,
    });
    expect(first.status).toBe(201);
    const second = await postRefund(cashierToken, sale.transaction_id, lines, "cash", {
      idempotency_key: key,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.request_id).toBe(first.body.data.request_id);
    expect(second.body.data.replayed).toBe(true);
    const count = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refund_requests WHERE transaction_id = ? AND status = 'pending'",
      [sale.transaction_id]
    );
    expect(Number(count.n)).toBe(1);

    const reused = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 2), "cash", {
      idempotency_key: key,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSE");
    const still = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refund_requests WHERE transaction_id = ? AND status = 'pending'",
      [sale.transaction_id]
    );
    expect(Number(still.n)).toBe(1);
  });

  test("26. a failure while posting rolls the refund, stock, and drawer back together", async () => {
    const shiftId = await startShift(cashierToken, 500);
    const sale = await checkout(cashierToken, { qty: 1, price: 10 });
    const created = await postRefund(cashierToken, sale.transaction_id, refundLines(ctx.productId, 1));
    expect(created.status).toBe(201);
    const requestId = created.body.data.request_id;
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const ledgerBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n
    );
    const expectedBefore = await expectedCash(shiftId);
    const manager = { ...adminUser, failAfterPost: true };
    await expect(approveRefundRequest(ctx.db, requestId, manager, null, null, "admin")).rejects.toMatchObject({
      code: "FORCED_ROLLBACK",
    });
    const stockAfter = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const ledgerAfter = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n);
    const refunds = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refunds WHERE original_transaction_id = ?",
      [sale.transaction_id]
    );
    const pending = await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId]);
    expect(stockAfter).toBe(stockBefore);
    expect(ledgerAfter).toBe(ledgerBefore);
    expect(Number(refunds.n)).toBe(0);
    expect(pending.status).toBe("pending");
    expect(await expectedCash(shiftId)).toBe(expectedBefore);
  });
});
