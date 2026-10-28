import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";

function bodyOf(res) {
  return res.body.data ?? res.body;
}

/**
 * Independently totaled fixture. Amounts are whole tenths of a shekel so
 * round2 order cannot move the result.
 *
 * Daily and range reports are shop-wide: they do not filter store_id.
 * The store 2 sale is included on purpose. This is not a store-isolation test.
 */
const D1 = {
  total_sales: 220,
  rounding_adjustment: 0.5,
  item_revenue: 220,
  total_transactions: 7,
  cash_total: 167,
  card_total: 45,
  on_account_total: 8,
  items_sold: 11,
  refunds_total: 10,
  refund_count: 1,
  net_sales: 210,
  change_total: 5,
  net_cash_total: 152,
  cost: 46,
  profit: 164,
  cost_unknown: false,
};

const D2 = {
  total_sales: 19,
  rounding_adjustment: 0,
  item_revenue: 19,
  total_transactions: 2,
  cash_total: 19,
  card_total: 0,
  on_account_total: 0,
  items_sold: 2,
  refunds_total: 15,
  refund_count: 1,
  net_sales: 4,
  cost: null,
  profit: null,
  cost_unknown: true,
};

describe("sales report aggregation", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    await ctx.db.run(
      `INSERT INTO stores (id, name, name_ar, branch_code) VALUES (2, 'Other', 'فرع آخر', 'OTHER')`
    );
    const p1 = (
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('910001', 'A', 10, 99, 'T', 50)`
      )
    ).lastID;
    const p2 = (
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('910002', 'B', 14, 99, 'T', 50)`
      )
    ).lastID;
    const p3 = (
      await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('910003', 'C', 5, 99, 'T', 50)`
      )
    ).lastID;
    const shift1 = (
      await ctx.db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, opening_cash, status, start_time, end_time, business_day, variance, store_id)
         VALUES (?, 100, 'closed', '2026-10-01T06:00:00.000Z', '2026-10-01T18:00:00.000Z', '2026-10-01', 12.5, 1)`,
        [cashierId]
      )
    ).lastID;
    const shift2 = (
      await ctx.db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, opening_cash, status, start_time, end_time, business_day, variance, store_id)
         VALUES (?, 100, 'closed', '2026-10-02T06:00:00.000Z', '2026-10-02T18:00:00.000Z', '2026-10-02', NULL, 1)`,
        [cashierId]
      )
    ).lastID;
    const shiftOther = (
      await ctx.db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, opening_cash, status, start_time, end_time, business_day, variance, store_id)
         VALUES (?, 50, 'closed', '2026-10-01T07:00:00.000Z', '2026-10-01T15:00:00.000Z', '2026-10-01', 1, 2)`,
        [cashierId]
      )
    ).lastID;

    async function sale(row) {
      const ins = await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, discount, change_amount, rounding_adjustment, payment_method, shift_id, status, created_at, business_day, store_id)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
        [
          cashierId,
          row.itemsJson,
          row.total,
          row.total,
          row.discount || 0,
          row.change || 0,
          row.rounding || 0,
          row.method,
          row.shiftId,
          row.createdAt,
          row.businessDay,
          row.storeId || 1,
        ]
      );
      for (const item of row.items || []) {
        await ctx.db.run(
          `INSERT INTO transaction_items
             (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate, unit_cost_at_sale)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
          [ins.lastID, item.productId, item.name, item.qty, item.unitPrice, item.lineNet, item.lineGross, item.cost]
        );
      }
      for (const pay of row.payments) {
        await ctx.db.run(
          `INSERT INTO sale_payments
             (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
           VALUES (?, ?, ?, ?, 1, ?)`,
          [ins.lastID, pay.method, pay.amount, pay.amount, pay.nis]
        );
      }
      return ins.lastID;
    }

    const saleA = await sale({
      itemsJson: "[]",
      total: 30,
      discount: 4,
      change: 5,
      method: "cash",
      shiftId: shift1,
      createdAt: "2026-10-01T09:00:00.000Z",
      businessDay: "2026-10-01",
      items: [
        { productId: p1, name: "A", qty: 2, unitPrice: 10, lineNet: 16, lineGross: 20, cost: 4 },
        { productId: p2, name: "B", qty: 1, unitPrice: 14, lineNet: 14, lineGross: 14, cost: 0 },
      ],
      payments: [{ method: "cash", amount: 30, nis: 30 }],
    });
    await sale({
      itemsJson: "[]",
      total: 50,
      rounding: 0.5,
      method: "mixed",
      shiftId: shift1,
      createdAt: "2026-10-01T10:00:00.000Z",
      businessDay: "2026-10-01",
      items: [{ productId: p1, name: "A", qty: 1, unitPrice: 50, lineNet: 50, lineGross: 50, cost: 20 }],
      payments: [
        { method: "cash", amount: 20, nis: 20 },
        { method: "visa", amount: 10, nis: 30 },
      ],
    });
    const saleC = await sale({
      itemsJson: "[]",
      total: 15,
      method: "visa",
      shiftId: shift1,
      createdAt: "2026-10-01T11:00:00.000Z",
      businessDay: "2026-10-01",
      items: [{ productId: p3, name: "C", qty: 3, unitPrice: 5, lineNet: 15, lineGross: 15, cost: 2 }],
      payments: [{ method: "visa", amount: 15, nis: 15 }],
    });
    await sale({
      itemsJson: "[]",
      total: 8,
      method: "on_account",
      shiftId: shift1,
      createdAt: "2026-10-01T12:00:00.000Z",
      businessDay: "2026-10-01",
      items: [{ productId: p2, name: "B", qty: 1, unitPrice: 8, lineNet: 8, lineGross: 8, cost: 3 }],
      payments: [{ method: "on_account", amount: 8, nis: 8 }],
    });
    await sale({
      itemsJson: "[]",
      total: 11,
      method: "cash",
      shiftId: shift1,
      createdAt: "2026-10-02T01:00:00.000Z",
      businessDay: null,
      items: [{ productId: p1, name: "A", qty: 1, unitPrice: 11, lineNet: 11, lineGross: 11, cost: 1 }],
      payments: [{ method: "cash", amount: 11, nis: 11 }],
    });
    await sale({
      itemsJson: "[]",
      total: 6,
      method: "cash",
      shiftId: null,
      createdAt: "2026-10-01T13:00:00.000Z",
      businessDay: "2026-10-01",
      items: [{ productId: p2, name: "Office", qty: 1, unitPrice: 6, lineNet: 6, lineGross: 6, cost: 2 }],
      payments: [{ method: "cash", amount: 6, nis: 6 }],
    });
    await sale({
      itemsJson: "[]",
      total: 100,
      method: "cash",
      shiftId: shiftOther,
      createdAt: "2026-10-01T14:00:00.000Z",
      businessDay: "2026-10-01",
      storeId: 2,
      items: [{ productId: p1, name: "OtherStore", qty: 1, unitPrice: 100, lineNet: 100, lineGross: 100, cost: 10 }],
      payments: [{ method: "cash", amount: 100, nis: 100 }],
    });
    await sale({
      itemsJson: JSON.stringify([{ product_id: p1, name: "LegacyJson", quantity: 1, price: 12 }]),
      total: 12,
      method: "cash",
      shiftId: shift2,
      createdAt: "2026-10-02T10:00:00.000Z",
      businessDay: "2026-10-02",
      items: [],
      payments: [{ method: "cash", amount: 12, nis: 12 }],
    });
    await sale({
      itemsJson: "[]",
      total: 7,
      method: "cash",
      shiftId: null,
      createdAt: "2026-10-02T09:00:00.000Z",
      businessDay: null,
      items: [{ productId: p3, name: "LegacyDay", qty: 1, unitPrice: 7, lineNet: 7, lineGross: 7, cost: 3 }],
      payments: [{ method: "cash", amount: 7, nis: 7 }],
    });

    await ctx.db.run(
      `INSERT INTO refunds
         (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, shift_id, status, created_at, business_day)
       VALUES (?, ?, 10, 0, 10, 'cash', ?, ?, 'approved', '2026-10-01T16:00:00.000Z', '2026-10-01')`,
      [saleA, JSON.stringify([{ product_id: p1, quantity: 1, price: 10 }]), cashierId, shift1]
    );
    await ctx.db.run(
      `INSERT INTO refunds
         (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, shift_id, status, created_at, business_day)
       VALUES (?, ?, 15, 0, 15, 'visa', ?, ?, 'approved', '2026-10-02T15:00:00.000Z', '2026-10-02')`,
      [saleC, JSON.stringify([{ product_id: p3, quantity: 3, price: 5 }]), cashierId, shift2]
    );
    await ctx.db.run(
      `INSERT INTO refunds
         (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, shift_id, status, created_at, business_day)
       VALUES (?, ?, 99, 0, 99, 'cash', ?, ?, 'pending', '2026-10-01T17:00:00.000Z', '2026-10-01')`,
      [saleA, JSON.stringify([{ product_id: p1, quantity: 1, price: 10 }]), cashierId, shift1]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function expectMoney(actual, expected) {
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toBe(value);
    }
  }

  function rangeDay(expected) {
    const { total_transactions, change_total, net_cash_total, ...rest } = expected;
    return { ...rest, transactions: total_transactions };
  }

  test("shop-wide daily totals include the other store and match the fixture", async () => {
    const d1 = bodyOf(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-01" }).set(authHeader(adminToken))
    );
    const d2 = bodyOf(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-02" }).set(authHeader(adminToken))
    );
    const d3 = bodyOf(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-03" }).set(authHeader(adminToken))
    );
    expectMoney(d1, D1);
    expectMoney(d2, D2);
    expect(d2.net_card_total).toBe(-15);
    expect(d2.visa_refunds).toBe(15);
    expectMoney(d3, {
      total_sales: 0,
      net_sales: 0,
      items_sold: 0,
      refund_count: 0,
      cash_total: 0,
      card_total: 0,
      on_account_total: 0,
      cost: 0,
      profit: 0,
      cost_unknown: false,
    });
    expect(d1.top_products.find((row) => row.name === "A").quantity).toBe(4);
    expect(d1.top_products.find((row) => row.name === "A").revenue).toBe(77);
  });

  test("range days match daily and do not multiply tenders by item or payment rows", async () => {
    const range = bodyOf(
      await request(ctx.app)
        .get("/api/v1/reports/range")
        .query({ from: "2026-10-01", to: "2026-10-03" })
        .set(authHeader(adminToken))
    );
    expect(range.by_day).toHaveLength(3);
    expectMoney(range.by_day[0], rangeDay(D1));
    expectMoney(range.by_day[1], rangeDay(D2));
    expectMoney(range.by_day[2], {
      total_sales: 0,
      net_sales: 0,
      items_sold: 0,
      refunds_total: 0,
      cash_total: 0,
      card_total: 0,
      on_account_total: 0,
      cost: 0,
      profit: 0,
      cost_unknown: false,
    });
    expect(range.total_sales).toBe(239);
    expect(range.rounding_adjustment).toBe(0.5);
    expect(range.item_revenue).toBe(239);
    expect(range.total_transactions).toBe(9);
    expect(range.items_sold).toBe(13);
    expect(range.net_sales).toBe(214);
    expect(range.refunds_total).toBe(25);
    expect(range.refund_count).toBe(2);
    expect(range.cash_total).toBe(186);
    expect(range.card_total).toBe(45);
    expect(range.on_account_total).toBe(8);
    expect(range.cost).toBeNull();
    expect(range.profit).toBeNull();
    expect(range.cost_unknown).toBe(true);
  });

  test("an empty span stays zero and query count does not grow with the number of days", async () => {
    const warm = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2020-01-01", to: "2020-01-02" })
      .set(authHeader(adminToken));
    const short = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2020-02-01", to: "2020-02-02" })
      .set(authHeader(adminToken));
    const long = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2020-03-01", to: "2020-03-30" })
      .set(authHeader(adminToken));
    expect(warm.status).toBe(200);
    const empty = bodyOf(short);
    expect(empty.total_sales).toBe(0);
    expect(empty.net_sales).toBe(0);
    expect(empty.by_day).toHaveLength(2);
    expect(empty.by_day.every((day) => day.cost === 0 && day.profit === 0 && day.cost_unknown === false)).toBe(
      true
    );
    expect(bodyOf(long).by_day).toHaveLength(30);
    expect(Number(long.headers["x-query-count"])).toBe(Number(short.headers["x-query-count"]));

    const populated = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2026-10-01", to: "2026-10-30" })
      .set(authHeader(adminToken));
    const daily = await request(ctx.app)
      .get("/api/v1/reports/daily")
      .query({ date: "2026-10-01" })
      .set(authHeader(adminToken));
    expect(Number(populated.headers["x-query-count"])).toBeLessThan(20);
    expect(Number(daily.headers["x-query-count"])).toBeLessThan(18);
    expect(Number(populated.headers["x-query-count"])).toBeLessThan(
      Number(daily.headers["x-query-count"]) * 3
    );
  });

  test("historical cost ignores a later product cost edit, and a null snapshot stays unknown", async () => {
    await ctx.db.run("UPDATE products SET cost = 1 WHERE barcode = '910001'");
    const d1 = bodyOf(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-01" }).set(authHeader(adminToken))
    );
    expect(d1.cost).toBe(46);
    expect(d1.profit).toBe(164);
    expect(d1.cost_unknown).toBe(false);
    const d2 = bodyOf(
      await request(ctx.app).get("/api/v1/reports/daily").query({ date: "2026-10-02" }).set(authHeader(adminToken))
    );
    expect(d2.cost_unknown).toBe(true);
    expect(d2.cost).toBeNull();
  });

  test("chart series stays on the profit contract", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/reports/daily-series")
      .query({ from: "2026-10-03", to: "2026-10-03" })
      .set(authHeader(adminToken));
    const day = bodyOf(res).days[0];
    expect(Object.keys(day).sort()).toEqual(
      [
        "cost",
        "cost_unknown",
        "date",
        "items_sold",
        "net_sales",
        "profit",
        "refund_count",
        "refunds_total",
        "revenue",
        "total_sales",
        "total_transactions",
      ].sort()
    );
    expect(day.cash_total).toBeUndefined();
    expect(day.item_revenue).toBeUndefined();
  });

  test("cashier cannot read daily or range, and range requires sales reports", async () => {
    const dailyDenied = await request(ctx.app)
      .get("/api/v1/reports/daily")
      .query({ date: "2026-10-01" })
      .set(authHeader(cashierToken));
    const rangeDenied = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2026-10-01", to: "2026-10-03" })
      .set(authHeader(cashierToken));
    expect(dailyDenied.status).toBe(403);
    expect(rangeDenied.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "dashonly",
      permissions: { dashboard: true },
    });
    const dash = (await login(ctx.app, "dashonly", "acctpass123", "office")).body.token;
    const dailyOk = await request(ctx.app)
      .get("/api/v1/reports/daily")
      .query({ date: "2026-10-01" })
      .set(authHeader(dash));
    const rangeNo = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: "2026-10-01", to: "2026-10-01" })
      .set(authHeader(dash));
    expect(dailyOk.status).toBe(200);
    expect(rangeNo.status).toBe(403);
  });
});
