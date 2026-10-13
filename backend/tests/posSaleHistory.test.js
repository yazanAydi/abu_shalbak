import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createAccountantUser,
} from "./helpers.js";
import { formatShopWall, SHOP_TZ } from "../utils/shopTime.js";

describe("POS previous sale history", () => {
  let ctx;
  let cashierToken;
  let otherToken;
  let adminToken;
  let accountantToken;
  let cashierId;
  let otherId;
  let shiftA;
  let currentSale;
  let previousSale;

  beforeAll(async () => {
    ctx = await createTestContext();
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["historycashier2", hash]
    );
    const accountant = await createAccountantUser(ctx.db);
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    otherToken = (await login(ctx.app, "historycashier2", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    accountantToken = (await login(ctx.app, accountant.username, accountant.password, "office")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    otherId = (await ctx.db.get("SELECT id FROM users WHERE username = 'historycashier2'")).id;

    const openA = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftA = openA.body.data.shift_id;
    previousSale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ items: [{ product_id: ctx.productId, quantity: 1, price: 10 }], payment_method: "cash" }));
    expect(previousSale.status).toBe(201);

    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed', business_day = ? WHERE id = ?", [
      "2026-01-15",
      shiftA,
    ]);
    await ctx.db.run("UPDATE transactions SET created_at = ? WHERE id = ?", [
      "2026-01-15 10:00:00",
      previousSale.body.data.transaction_id,
    ]);

    const openB = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 80 });
    expect(openB.status).toBe(201);
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", ["2026-04-02", openB.body.data.shift_id]);
    currentSale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
          payment_method: "visa",
        })
      );
    expect(currentSale.status).toBe(201);
    await ctx.db.run("UPDATE transactions SET created_at = ? WHERE id = ?", [
      "2026-04-02 09:30:00",
      currentSale.body.data.transaction_id,
    ]);

    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(otherToken)).send({ opening_cash: 40 });
    const otherSale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(otherToken))
      .send(withCheckoutKey({ items: [{ product_id: ctx.productId, quantity: 1, price: 10 }], payment_method: "cash" }));
    expect(otherSale.status).toBe(201);
    ctx.otherSaleId = otherSale.body.data.transaction_id;
    ctx.otherReceipt = otherSale.body.data.receipt_number;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function list(token, query = "") {
    return request(ctx.app).get(`/api/v1/pos/my-sales${query}`).set(authHeader(token));
  }

  test("cashier sees own current and previous shift sales, newest first, without reopening the old shift", async () => {
    const closed = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftA]);
    expect(closed.status).toBe("closed");
    const res = await list(cashierToken, "?limit=20&page=1");
    expect(res.status).toBe(200);
    const ids = res.body.data.sales.map((row) => row.transaction_id);
    expect(ids).toContain(previousSale.body.data.transaction_id);
    expect(ids).toContain(currentSale.body.data.transaction_id);
    expect(ids).not.toContain(ctx.otherSaleId);
    expect(ids[0]).toBe(currentSale.body.data.transaction_id);
    const stillClosed = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftA]);
    expect(stillClosed.status).toBe("closed");
  });

  test("another cashier cannot list or open the sale, including a direct detail request", async () => {
    const listed = await list(otherToken);
    expect(listed.status).toBe(200);
    expect(listed.body.data.sales.some((row) => row.transaction_id === previousSale.body.data.transaction_id)).toBe(
      false
    );
    const byNumber = await list(otherToken, `?q=${encodeURIComponent(previousSale.body.data.receipt_number)}`);
    expect(byNumber.body.data.sales).toHaveLength(0);
    const detail = await request(ctx.app)
      .get(`/api/v1/pos/my-sales/${previousSale.body.data.transaction_id}`)
      .set(authHeader(otherToken));
    expect(detail.status).toBe(403);
    expect(detail.body.code).toBe("FORBIDDEN");
    const spoof = await list(otherToken, `?cashier_id=${cashierId}`);
    expect(spoof.status).toBe(403);
  });

  test("search, pagination, and business-day filtering use the shift day", async () => {
    const receipt = currentSale.body.data.receipt_number;
    const found = await list(cashierToken, `?q=${encodeURIComponent(receipt.slice(-6))}`);
    expect(found.body.data.sales.map((row) => row.transaction_id)).toEqual([currentSale.body.data.transaction_id]);

    const page = await list(cashierToken, "?page=1&limit=1");
    expect(page.body.data.sales).toHaveLength(1);
    expect(page.body.data.total).toBeGreaterThanOrEqual(2);
    expect(page.body.data.page_count).toBeGreaterThanOrEqual(2);
    expect(page.body.data.sales[0].transaction_id).toBe(currentSale.body.data.transaction_id);
    const page2 = await list(cashierToken, "?page=2&limit=1");
    expect(page2.body.data.sales[0].transaction_id).toBe(previousSale.body.data.transaction_id);

    const january = await list(cashierToken, "?from=2026-01-15&to=2026-01-15");
    expect(january.body.data.sales.map((row) => row.transaction_id)).toEqual([
      previousSale.body.data.transaction_id,
    ]);
    expect(january.body.data.sales[0].business_day).toBe("2026-01-15");
    const october = await list(cashierToken, "?from=2026-10-13&to=2026-10-13");
    expect(october.body.data.sales).toHaveLength(0);
  });

  test("shop-local timestamp uses Asia/Hebron and saved discounts, rounding, and mixed payments stay stored", async () => {
    expect(SHOP_TZ).toBe("Asia/Hebron");
    const detail = await request(ctx.app)
      .get(`/api/v1/pos/my-sales/${previousSale.body.data.transaction_id}`)
      .set(authHeader(cashierToken));
    expect(detail.status).toBe(200);
    const wall = formatShopWall("2026-01-15 10:00:00");
    expect(detail.body.data.local_created_at.dateTime).toBe(wall.dateTime);
    expect(detail.body.data.local_created_at.time_zone).toBe("Asia/Hebron");
    expect(detail.body.data.local_created_at.time.startsWith("12:")).toBe(true);

    await ctx.db.run("UPDATE products SET name = 'Live Name', price = 99 WHERE id = ?", [ctx.productId]);
    const txId = await ctx.db.run(
      `INSERT INTO transactions (
         cashier_id, shift_id, items_json, subtotal, tax, discount, total,
         amount_before_rounding, rounding_adjustment, payment_method, status, store_id,
         receipt_number, created_at
       ) VALUES (?, (SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'), ?, 11.25, 0, 1.25, 10,
         10.02, -0.02, 'mixed', 'completed', 1, 'INV-2026-888888', '2026-04-02 11:00:00')`,
      [
        cashierId,
        cashierId,
        JSON.stringify([{ product_id: ctx.productId, name: "اسم محفوظ", quantity: 2, price: 5.625 }]),
      ]
    );
    await ctx.db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, unit_name, quantity, unit_price, line_net, line_gross, line_tax, discount_at_sale)
       VALUES (?, ?, 'اسم محفوظ', 'حبة', 2, 5.63, 10, 11.25, 0, 1.25)`,
      [txId.lastID, ctx.productId]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, nis_equivalent)
       VALUES (?, 'cash', 6, 6, 6), (?, 'visa', 4, 4, 4)`,
      [txId.lastID, txId.lastID]
    );
    await ctx.db.run(
      `INSERT INTO refunds (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, status)
       VALUES (?, ?, 5, 0, 5, 'cash', ?, 'approved')`,
      [txId.lastID, JSON.stringify([{ product_id: ctx.productId, name: "اسم محفوظ", quantity: 1, price: 5 }]), cashierId]
    );

    const saved = await request(ctx.app).get(`/api/v1/pos/my-sales/${txId.lastID}`).set(authHeader(cashierToken));
    expect(saved.status).toBe(200);
    expect(saved.body.data.lines[0].name).toBe("اسم محفوظ");
    expect(saved.body.data.lines[0].unit_price).toBe(5.63);
    expect(saved.body.data.lines[0].discount).toBe(1.25);
    expect(saved.body.data.lines[0].line_total).toBe(10);
    expect(saved.body.data.discount).toBe(1.25);
    expect(saved.body.data.rounding_adjustment).toBe(-0.02);
    expect(saved.body.data.amount_before_rounding).toBe(10.02);
    expect(saved.body.data.total).toBe(10);
    expect(saved.body.data.payment_method).toBe("mixed");
    expect(saved.body.data.payments.map((p) => [p.method, p.amount])).toEqual([
      ["cash", 6],
      ["visa", 4],
    ]);
    expect(saved.body.data.sale_state).toBe("partial_return");
    expect(saved.body.data.sale_state_label).toBe("مرتجعة جزئياً");
    expect(saved.body.data.returns[0].total).toBe(5);
    expect(saved.body.data.returns[0].lines[0].name).toBe("اسم محفوظ");

    const listed = await list(cashierToken, "?q=INV-2026-888888");
    expect(listed.body.data.sales[0].sale_state_label).toBe("مرتجعة جزئياً");
    expect(listed.body.data.sales[0].payment_method).toBe("mixed");

    const voidId = await ctx.db.run(
      `INSERT INTO transactions (
         cashier_id, shift_id, items_json, subtotal, tax, total, payment_method, status, store_id,
         receipt_number, created_at
       ) VALUES (?, (SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'), '[]', 3, 0, 3,
         'cash', 'voided', 1, 'INV-2026-888889', '2026-04-02 12:00:00')`,
      [cashierId, cashierId]
    );
    const voided = await request(ctx.app).get(`/api/v1/pos/my-sales/${voidId.lastID}`).set(authHeader(cashierToken));
    expect(voided.body.data.sale_state).toBe("cancelled");
    expect(voided.body.data.sale_state_label).toBe("ملغاة");
  });

  test("reading history does not write inventory, payments, or shifts", async () => {
    async function counts() {
      const [tx, pay, ledger, shifts, holds] = await Promise.all([
        ctx.db.get("SELECT COUNT(*) AS c FROM transactions"),
        ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments"),
        ctx.db.get("SELECT COUNT(*) AS c FROM inventory_ledger"),
        ctx.db.get("SELECT COUNT(*) AS c, COALESCE(SUM(opening_cash), 0) AS cash FROM cashier_shifts"),
        ctx.db.get("SELECT COUNT(*) AS c FROM suspended_sales"),
      ]);
      return [tx.c, pay.c, ledger.c, shifts.c, shifts.cash, holds.c].join(":");
    }
    const before = await counts();
    const res = await list(cashierToken);
    const detail = await request(ctx.app)
      .get(`/api/v1/pos/my-sales/${currentSale.body.data.transaction_id}`)
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(await counts()).toBe(before);
  });

  test("managers keep read access and accountants stay off the POS history route", async () => {
    const adminDetail = await request(ctx.app)
      .get(`/api/v1/pos/my-sales/${previousSale.body.data.transaction_id}`)
      .set(authHeader(adminToken));
    expect(adminDetail.status).toBe(200);
    const adminOwn = await list(adminToken);
    expect(adminOwn.status).toBe(200);
    expect(adminOwn.body.data.sales.some((row) => row.transaction_id === previousSale.body.data.transaction_id)).toBe(
      false
    );
    const adminFiltered = await list(adminToken, `?cashier_id=${cashierId}`);
    expect(adminFiltered.status).toBe(200);
    expect(adminFiltered.body.data.sales.some((row) => row.transaction_id === previousSale.body.data.transaction_id)).toBe(
      true
    );
    const accountant = await list(accountantToken);
    expect(accountant.status).toBe(403);
    expect(otherId).toBeGreaterThan(0);
  });
});
