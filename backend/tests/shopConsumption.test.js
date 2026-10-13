import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";
import { computeExpectedCash } from "../utils/salePayments.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function approveConsumption(app, adminToken, created) {
  const pending = unwrap(created.body);
  expect(pending.pending_approval).toBe(true);
  expect(pending.operating_expense_id).toBeNull();
  const approved = await request(app)
    .post(`/api/v1/shop-consumption-requests/${pending.request_id}/approve`)
    .set(authHeader(adminToken));
  expect(approved.status).toBe(200);
  return unwrap(approved.body);
}

async function startShift(app, token, db, opening = 100) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  const shift = await db.get(
    "SELECT * FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
  );
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shift.id]);
  return { ...shift, opening_cash: opening };
}

async function insertProduct(db, { barcode, name, price, cost, costKnown, stock }) {
  const ins = await db.run(
    `INSERT INTO products (barcode, name, price, cost, cost_known, category, stock)
     VALUES (?, ?, ?, ?, ?, 'Test', ?)`,
    [barcode, name, price, cost, costKnown, stock]
  );
  await db.run(
    `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
     VALUES (?, 'حبة', ?, ?, ?, 1, 1)`,
    [ins.lastID, barcode, price, cost]
  );
  return ins.lastID;
}

describe("POS shop consumption expense", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let accountantToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const accountant = await createAccountantUser(ctx.db);
    accountantToken = (await login(ctx.app, accountant.username, accountant.password)).body.token;
    await ctx.db.run("UPDATE products SET price = 15, cost = 10, cost_known = 1, stock = 20 WHERE id = ?", [
      ctx.productId,
    ]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("posts the selling price as a noncash shop expense and leaves sales and drawer cash unchanged", async () => {
    const shift = await startShift(ctx.app, cashierToken, ctx.db, 100);
    const before = {
      tx: (await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n,
      movements: (await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n,
      customers: (await ctx.db.get("SELECT COALESCE(SUM(balance),0) AS n FROM customers")).n,
      suppliers: (await ctx.db.get("SELECT COALESCE(SUM(balance),0) AS n FROM suppliers")).n,
    };

    const res = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "مواد تنظيف",
        idempotency_key: "shop-use-cleaner-0001",
      });
    expect(res.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(20);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(0);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'shop_consumption'")).n).toBe(0);
    const body = await approveConsumption(ctx.app, adminToken, res);
    expect(body.replayed).toBe(false);
    expect(body.total_cost).toBe(15);
    expect(body.payment_method).toBe("other");
    expect(body.business_day).toBe(shift.business_day);
    expect(body.created_at).toBeTruthy();
    expect(body.lines[0].unit_price).toBe(15);
    expect(body.lines[0].line_amount).toBe(15);
    expect(body.lines[0].unit_cost).toBe(10);
    expect(body.lines[0].line_cost).toBe(10);

    const product = await ctx.db.get("SELECT stock, price FROM products WHERE id = ?", [ctx.productId]);
    expect(Number(product.stock)).toBe(19);
    expect(Number(product.price)).toBe(15);

    const expense = await ctx.db.get("SELECT * FROM operating_expenses WHERE id = ?", [
      body.operating_expense_id,
    ]);
    expect(expense.source).toBe("shop_consumption");
    expect(Number(expense.source_id)).toBe(body.id);
    expect(Number(expense.amount)).toBe(15);
    expect(expense.payment_method).toBe("other");
    expect(expense.paid_on).toBe(shift.business_day);
    expect(expense.category).toBe("shop_consumption");

    const ledger = await ctx.db.get(
      "SELECT movement_type, quantity_delta, reference_type FROM inventory_ledger WHERE reference_id = ? AND reference_type = 'shop_consumption'",
      [body.id]
    );
    expect(ledger.movement_type).toBe("manual_adjustment");
    expect(Number(ledger.quantity_delta)).toBe(-1);

    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n).toBe(before.tx);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements")).n).toBe(before.movements);
    expect((await ctx.db.get("SELECT COALESCE(SUM(balance),0) AS n FROM customers")).n).toBe(before.customers);
    expect((await ctx.db.get("SELECT COALESCE(SUM(balance),0) AS n FROM suppliers")).n).toBe(before.suppliers);
    expect(await computeExpectedCash(ctx.db, shift.id, 100)).toBe(100);

    const list = await request(ctx.app).get("/api/v1/expenses").set(authHeader(adminToken));
    expect(list.status).toBe(200);
    const rows = unwrap(list.body);
    const listed = rows.find((row) => row.id === body.operating_expense_id);
    expect(listed).toBeTruthy();
    expect(listed.category_name_ar).toBe("مصاريف محل");

    const replay = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "مواد تنظيف",
        idempotency_key: "shop-use-cleaner-0001",
      });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).replayed).toBe(true);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(19);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'shop_consumption'")).n).toBe(1);

    const removed = await request(ctx.app)
      .delete(`/api/v1/expenses/${body.operating_expense_id}`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(409);
  });

  test("prices unknown and known-zero cost at the selling price, and rejects short stock without writing", async () => {
    const unknownId = await insertProduct(ctx.db, {
      barcode: "9991001",
      name: "منظف بلا تكلفة",
      price: 15,
      cost: 0,
      costKnown: null,
      stock: 5,
    });
    const freeId = await insertProduct(ctx.db, {
      barcode: "9991002",
      name: "عينة مجانية",
      price: 8,
      cost: 0,
      costKnown: 1,
      stock: 4,
    });
    const shortId = await insertProduct(ctx.db, {
      barcode: "9991003",
      name: "قليل المخزون",
      price: 20,
      cost: 3,
      costKnown: 1,
      stock: 1,
    });

    const unknown = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption/preview")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: unknownId, quantity: 1 }] });
    expect(unknown.status).toBe(200);
    expect(unwrap(unknown.body).total_cost).toBe(15);
    expect(unwrap(unknown.body).lines[0].unit_price).toBe(15);
    expect(unwrap(unknown.body).lines[0].unit_cost).toBeNull();
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [unknownId])).stock)).toBe(5);

    const free = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: freeId, quantity: 2 }],
        idempotency_key: "shop-use-free-0000001",
      });
    expect(free.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [freeId])).stock)).toBe(4);
    const freeBody = await approveConsumption(ctx.app, adminToken, free);
    expect(freeBody.total_cost).toBe(16);
    expect(freeBody.lines[0].unit_price).toBe(8);
    expect(freeBody.lines[0].line_amount).toBe(16);
    expect(freeBody.lines[0].unit_cost).toBe(0);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [freeId])).stock)).toBe(2);

    const short = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: shortId, quantity: 2 }],
        idempotency_key: "shop-use-short-000001",
      });
    expect(short.status).toBe(409);
    expect(short.body.error).toContain("قليل المخزون");
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [shortId])).stock)).toBe(1);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM shop_consumptions WHERE idempotency_key = ?", [
      "shop-use-short-000001",
    ])).n).toBe(0);
  });

  test("values every line at the selling price, snapshots it, and rejects the whole cart", async () => {
    const beforeExpenses = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n);
    const beforeConsumptions = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shop_consumptions")).n);
    const uncosted = await insertProduct(ctx.db, {
      barcode: "9991101",
      name: "صنف بلا تكلفة",
      price: 10,
      cost: 0,
      costKnown: null,
      stock: 6,
    });
    const costed = await insertProduct(ctx.db, {
      barcode: "9991102",
      name: "صنف بتكلفة",
      price: 10,
      cost: 4,
      costKnown: 1,
      stock: 6,
    });
    const short = await insertProduct(ctx.db, {
      barcode: "9991103",
      name: "صنف ناقص",
      price: 10,
      cost: 1,
      costKnown: 1,
      stock: 1,
    });

    const mixed = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [
          { product_id: uncosted, quantity: 2, price: 10, total: 1 },
          { product_id: costed, quantity: 2, price: 10 },
        ],
        idempotency_key: "shop-sell-mixed-0001",
      });
    expect(mixed.status).toBe(201);
    expect(unwrap(mixed.body).total_cost).toBe(40);
    expect(unwrap(mixed.body).lines.map((line) => line.line_amount)).toEqual([20, 20]);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [uncosted])).stock)).toBe(6);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [costed])).stock)).toBe(6);

    await ctx.db.run("UPDATE products SET price = 99 WHERE id = ?", [uncosted]);
    await ctx.db.run("UPDATE product_units SET price = 99 WHERE product_id = ?", [uncosted]);
    const replay = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [
          { product_id: uncosted, quantity: 2, price: 10, total: 1 },
          { product_id: costed, quantity: 2, price: 10 },
        ],
        idempotency_key: "shop-sell-mixed-0001",
      });
    expect(replay.status).toBe(200);
    expect(unwrap(replay.body).replayed).toBe(true);
    expect(unwrap(replay.body).total_cost).toBe(40);
    const changedQty = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: uncosted, quantity: 1 }],
        idempotency_key: "shop-sell-mixed-0001",
      });
    expect(changedQty.status).toBe(409);
    expect(changedQty.body.code).toBe("IDEMPOTENCY_KEY_REUSE");

    const approved = await approveConsumption(ctx.app, adminToken, mixed);
    expect(approved.total_cost).toBe(40);
    expect(approved.lines.find((line) => line.product_id === uncosted).unit_price).toBe(10);
    expect(approved.lines.find((line) => line.product_id === costed).line_amount).toBe(20);
    const savedCost = await ctx.db.get(
      "SELECT unit_cost, line_cost, unit_price, line_amount FROM shop_consumption_items WHERE consumption_id = ? AND product_id = ?",
      [approved.id, costed]
    );
    expect(savedCost.unit_price).toBe(10);
    expect(savedCost.line_amount).toBe(20);
    expect(savedCost.unit_cost).toBe(4);
    expect(savedCost.line_cost).toBe(8);
    const savedUnknown = await ctx.db.get(
      "SELECT unit_cost, line_cost, unit_price FROM shop_consumption_items WHERE consumption_id = ? AND product_id = ?",
      [approved.id, uncosted]
    );
    expect(savedUnknown.unit_cost).toBeNull();
    expect(savedUnknown.line_cost).toBeNull();
    expect(savedUnknown.unit_price).toBe(10);

    const uncostedRow = await ctx.db.get("SELECT price, cost, cost_known, stock FROM products WHERE id = ?", [uncosted]);
    const costedRow = await ctx.db.get("SELECT price, cost, cost_known, stock FROM products WHERE id = ?", [costed]);
    expect(uncostedRow.price).toBe(99);
    expect(uncostedRow.cost).toBe(0);
    expect(uncostedRow.cost_known).toBeNull();
    expect(uncostedRow.stock).toBe(4);
    expect(costedRow.cost).toBe(4);
    expect(costedRow.cost_known).toBe(1);
    expect(costedRow.stock).toBe(4);
    const expense = await ctx.db.get("SELECT amount, payment_method FROM operating_expenses WHERE id = ?", [
      approved.operating_expense_id,
    ]);
    expect(expense.amount).toBe(40);
    expect(expense.payment_method).toBe("other");

    const allocs = await ctx.db.all(
      `SELECT product_id, source_lot_id, quantity FROM stock_batch_allocations
        WHERE reference_type = 'shop_consumption' AND reference_id = ?`,
      [approved.id]
    );
    expect(allocs.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(4);
    for (const row of allocs) {
      const lot = await ctx.db.get("SELECT product_id FROM stock_source_lots WHERE id = ?", [row.source_lot_id]);
      expect(Number(lot.product_id)).toBe(Number(row.product_id));
    }
    const allocCount = allocs.length;
    const again = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${unwrap(mixed.body).request_id}/approve`)
      .set(authHeader(adminToken));
    expect(again.status).toBe(409);
    expect(
      (await ctx.db.all(
        "SELECT id FROM stock_batch_allocations WHERE reference_type = 'shop_consumption' AND reference_id = ?",
        [approved.id]
      )).length
    ).toBe(allocCount);
    expect(uncostedRow.stock).toBe(4);

    const mismatch = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: costed, quantity: 1, price: 3 }],
        idempotency_key: "shop-sell-mismatch-01",
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("PRICE_MISMATCH");

    const invalid = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [
          { product_id: costed, quantity: 1, price: 10 },
          { product_id: short, quantity: 2, price: 10 },
        ],
        idempotency_key: "shop-sell-invalid-001",
      });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe("INSUFFICIENT_STOCK");
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [costed])).stock)).toBe(4);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [short])).stock)).toBe(1);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM shop_consumptions WHERE idempotency_key = ?", [
      "consumption-approval-not-created",
    ])).n).toBe(0);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)).toBe(beforeExpenses + 1);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM shop_consumptions")).n)).toBe(beforeConsumptions + 1);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM shop_consumption_requests WHERE idempotency_key = ?", [
      "shop-sell-invalid-001",
    ])).n).toBe(0);

    const zeroId = await insertProduct(ctx.db, {
      barcode: "9991104",
      name: "سعر صفر",
      price: 0,
      cost: 3,
      costKnown: 1,
      stock: 2,
    });
    const zero = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption/preview")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: zeroId, quantity: 1, price: 0 }] });
    expect(zero.status).toBe(200);
    expect(unwrap(zero.body).total_cost).toBe(0);

    await ctx.db.run(
      `INSERT INTO promotions (name, offer_type, product_id, discount_value, active)
       VALUES ('مصروف 10', 'percentage', ?, 10, 1)`,
      [costed]
    );
    invalidatePromotionsCache();
    const discounted = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption/preview")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: costed, quantity: 2, price: 10 }] });
    expect(discounted.status).toBe(200);
    expect(unwrap(discounted.body).discount).toBe(2);
    expect(unwrap(discounted.body).total_cost).toBe(18);
    expect(Number((await ctx.db.get("SELECT used_qty FROM promotions WHERE name = 'مصروف 10'")).used_qty)).toBe(0);
    await ctx.db.run("DELETE FROM promotions WHERE name = 'مصروف 10'");
    invalidatePromotionsCache();

    await ctx.db.run("UPDATE products SET price = 10.24 WHERE id = ?", [costed]);
    await ctx.db.run("UPDATE product_units SET price = 10.24 WHERE product_id = ?", [costed]);
    const rounded = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption/preview")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: costed, quantity: 1, price: 10.24 }] });
    expect(rounded.status).toBe(200);
    expect(unwrap(rounded.body).amount_before_rounding).toBe(10.24);
    expect(unwrap(rounded.body).rounding_adjustment).toBe(-0.24);
    expect(unwrap(rounded.body).total_cost).toBe(10);
    expect(unwrap(rounded.body).tax).toBe(0);
  });

  test("cashiers need an open shift and office accountants cannot post", async () => {
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE status = 'open'");
    const denied = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(accountantToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1 }],
        idempotency_key: "shop-use-acct-000001",
      });
    expect(denied.status).toBe(403);

    const noShift = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1 }],
        idempotency_key: "shop-use-noshift-0001",
      });
    expect(noShift.status).toBe(409);
    expect(noShift.body.error).toContain("وردية");
  });
});
