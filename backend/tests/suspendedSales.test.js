import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { executeCheckoutSale } from "../services/checkoutSaleService.js";

describe("Suspended sales (hold cart)", () => {
  let ctx;
  let cashierToken;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;

    const shiftRes = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    shiftId = shiftRes.body.data.shift_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function suspendItem(quantity = 2, price = 10, note = "زبون رجع") {
    return request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({
        note,
        items: [
          {
            product_id: ctx.productId,
            quantity,
            price,
          },
        ],
      });
  }

  test("suspend does not create transaction or deduct stock", async () => {
    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = product.stock;

    const txBefore = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE shift_id = ?",
      [shiftId]
    );

    const res = await suspendItem(3, 10, "اختبار تعليق");
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.total).toBeGreaterThan(0);

    const stockAfter = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(stockAfter.stock).toBe(stockBefore);

    const txAfter = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE shift_id = ?",
      [shiftId]
    );
    expect(Number(txAfter.c)).toBe(Number(txBefore.c));
  });

  test("list shows suspended sale with snapshot data", async () => {
    const suspendRes = await suspendItem(2, 10);
    const suspendedId = suspendRes.body.data.id;

    const listRes = await request(ctx.app)
      .get("/api/v1/suspended-sales")
      .set(authHeader(cashierToken));

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.count).toBeGreaterThan(0);
    const row = listRes.body.data.sales.find((s) => s.id === suspendedId);
    expect(row).toBeTruthy();
    expect(row.item_count).toBe(2);
    expect(row.total).toBe(20);
  });

  test("detail returns snapshot prices", async () => {
    const suspendRes = await suspendItem(1, 10);
    const id = suspendRes.body.data.id;

    const detailRes = await request(ctx.app)
      .get(`/api/v1/suspended-sales/${id}`)
      .set(authHeader(cashierToken));

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.items[0].unit_price_snapshot).toBe(10);
    expect(detailRes.body.data.items[0].product_name_snapshot).toBeTruthy();
  });

  test("delete soft-deletes suspended sale", async () => {
    const suspendRes = await suspendItem(1, 10);
    const id = suspendRes.body.data.id;

    const delRes = await request(ctx.app)
      .delete(`/api/v1/suspended-sales/${id}`)
      .set(authHeader(cashierToken));
    expect(delRes.status).toBe(200);

    const row = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [id]);
    expect(row.status).toBe("deleted");

    const listRes = await request(ctx.app)
      .get("/api/v1/suspended-sales")
      .set(authHeader(cashierToken));
    expect(listRes.body.data.sales.some((s) => s.id === id)).toBe(false);
  });

  test("update suspended sale replaces items for modified cart", async () => {
    const suspendRes = await suspendItem(2, 10);
    const suspendedId = suspendRes.body.data.id;

    const extraIns = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990003', 'Added Product', 5, 2, 'Test', 50)`
    );
    const extraProductId = extraIns.lastID;
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990003', 5, 2, 1, 1)`,
      [extraProductId]
    );

    const updateRes = await request(ctx.app)
      .put(`/api/v1/suspended-sales/${suspendedId}`)
      .set(authHeader(cashierToken))
      .send({
        items: [
          { product_id: ctx.productId, quantity: 2, price: 10 },
          { product_id: extraProductId, quantity: 1, price: 5 },
        ],
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.total).toBe(25);

    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [
          { product_id: ctx.productId, quantity: 2, price: 10 },
          { product_id: extraProductId, quantity: 1, price: 5 },
        ],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      }));

    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.data.total).toBe(25);
  });

  test("checkout with suspended_sale_id allows adding extra items", async () => {
    const suspendRes = await suspendItem(2, 10);
    const suspendedId = suspendRes.body.data.id;

    const extraIns = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990002', 'Extra Product', 5, 2, 'Test', 50)`
    );
    const extraProductId = extraIns.lastID;
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990002', 5, 2, 1, 1)`,
      [extraProductId]
    );

    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [
          { product_id: ctx.productId, quantity: 2, price: 10 },
          { product_id: extraProductId, quantity: 1, price: 5 },
        ],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      }));

    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.data.total).toBe(25);

    const suspended = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [
      suspendedId,
    ]);
    expect(suspended.status).toBe("completed");
  });

  test("checkout with suspended_sale_id uses snapshot price after live price change", async () => {
    const suspendRes = await suspendItem(2, 10);
    const suspendedId = suspendRes.body.data.id;
    const stockBefore = (
      await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])
    ).stock;

    await ctx.db.run("UPDATE products SET price = 15 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET price = 15 WHERE product_id = ? AND is_default = 1",
      [ctx.productId]
    );

    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      }));

    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.data.total).toBe(20);

    const suspended = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [
      suspendedId,
    ]);
    expect(suspended.status).toBe("completed");

    const stockAfter = (
      await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])
    ).stock;
    expect(stockAfter).toBe(stockBefore - 2);
  });

  test("shift current includes suspended summary without counting as transactions", async () => {
    await suspendItem(1, 10);

    const currentRes = await request(ctx.app)
      .get("/api/v1/shifts/current")
      .set(authHeader(cashierToken));

    expect(currentRes.status).toBe(200);
    expect(currentRes.body.data.suspended_sales_count).toBeGreaterThan(0);
    expect(currentRes.body.data.suspended_sales_total).toBeGreaterThan(0);

    const txCount = Number(currentRes.body.data.transactions_count);
    const completedOnly = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE shift_id = ?",
      [shiftId]
    );
    expect(txCount).toBe(Number(completedOnly.c));
  });

  test("normal checkout without suspended_sale_id rejects stale price", async () => {
    await ctx.db.run("UPDATE products SET price = 15 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET price = 15 WHERE product_id = ? AND is_default = 1",
      [ctx.productId]
    );

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
      }));

    expect(res.status).toBe(409);
    expect(res.body.data?.code || res.body.code).toBe("PRICE_MISMATCH");
  });

  async function restoreShelfPrice(price = 10) {
    await ctx.db.run("UPDATE products SET price = ? WHERE id = ?", [price, ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET price = ? WHERE product_id = ? AND is_default = 1",
      [price, ctx.productId]
    );
  }

  test("second checkout of the same hold with a new key does not create another sale", async () => {
    await restoreShelfPrice(10);
    const suspendRes = await suspendItem(1, 10);
    const suspendedId = suspendRes.body.data.id;
    const stockBefore = (
      await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])
    ).stock;
    const txBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const payBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments");
    const ledgerBefore = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );

    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
        idempotency_key: "hold-first-key-aaaaaa",
      });
    expect(first.status).toBe(201);
    const firstTx = first.body.data.transaction_id;

    const second = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
        idempotency_key: "hold-second-key-bbbbbb",
      });
    expect(second.status).toBe(409);
    expect(second.body.data?.code || second.body.code).toBe("SUSPENDED_ALREADY_COMPLETED");

    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
        idempotency_key: "hold-first-key-aaaaaa",
      });
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotent_replay).toBe(true);
    expect(replay.body.data.transaction_id).toBe(firstTx);

    const txAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const payAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments");
    const ledgerAfter = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ctx.productId]
    );
    const stockAfter = (
      await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])
    ).stock;
    expect(Number(txAfter.c)).toBe(Number(txBefore.c) + 1);
    expect(Number(payAfter.c)).toBe(Number(payBefore.c) + 1);
    expect(Number(ledgerAfter.c)).toBe(Number(ledgerBefore.c) + 1);
    expect(stockAfter).toBe(stockBefore - 1);
  });

  test("concurrent checkouts of the same hold with different keys create one sale", async () => {
    await restoreShelfPrice(10);
    const suspendRes = await suspendItem(1, 10);
    const suspendedId = suspendRes.body.data.id;
    const txBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");

    const [a, b] = await Promise.all([
      request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
          suspended_sale_id: suspendedId,
          idempotency_key: "hold-conc-key-aaaaaaa1",
        }),
      request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
          suspended_sale_id: suspendedId,
          idempotency_key: "hold-conc-key-bbbbbbb2",
        }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(loser.body.data?.code || loser.body.code).toBe("SUSPENDED_ALREADY_COMPLETED");

    const txAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    expect(Number(txAfter.c)).toBe(Number(txBefore.c) + 1);
    const hold = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [suspendedId]);
    expect(hold.status).toBe("completed");
    expect(winner.body.data.transaction_id).toBeTruthy();
  });

  test("failed checkout after claiming a hold rolls the hold back to suspended", async () => {
    await restoreShelfPrice(10);
    const suspendRes = await suspendItem(1, 10);
    const suspendedId = suspendRes.body.data.id;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    const promo = await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
       VALUES ('Hold rollback cap', 'percentage', ?, 10, 1, 1, 1)`,
      [ctx.productId]
    );
    const txBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");

    await expect(
      executeCheckoutSale(ctx.db, {
        cashierId: cashier.id,
        shiftId,
        custId: null,
        itemsForJson: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        normalized: [
          {
            product_id: ctx.productId,
            barcode: "9990001",
            name: "Test Product",
            quantity: 1,
            price: 10,
            cost: 5,
            taxRate: 0,
            stock_delta: 1,
            scanned_barcode: null,
            product_barcode_id: null,
            product_unit_id: null,
            unit_name: "حبة",
            conversion_to_base: 1,
          },
        ],
        detailed: [{ lineNet: 10, lineTax: 0, lineGross: 10 }],
        subtotal: 10,
        tax: 0,
        total: 10,
        discount: 0,
        paymentLines: [{ method: "cash", amount: 10, nis_equivalent: 10, original_amount: 10 }],
        summaryMethod: "cash",
        onAccountTotal: 0,
        cashTotal: 10,
        changeNis: 0,
        changeCurrencyId: null,
        changeOriginalAmount: 0,
        idempotencyKey: "hold-rollback-key-xxxxxx",
        suspendedSaleId: suspendedId,
        promoBreakdown: [{ promotion_id: promo.lastID, units_used: 1 }],
      })
    ).rejects.toMatchObject({ code: "PROMO_LIMIT", status: 409 });

    const hold = await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [suspendedId]);
    expect(hold.status).toBe("suspended");
    const txAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    expect(Number(txAfter.c)).toBe(Number(txBefore.c));
  });
});

describe("Negative stock is allowed at POS checkout", () => {
  let ctx;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 50 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("selling 5 units with stock 2 succeeds and leaves stock at -3", async () => {
    await ctx.db.run("UPDATE products SET stock = 2, price = 10 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET price = 10 WHERE product_id = ? AND is_default = 1",
      [ctx.productId]
    );

    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 5, price: 10 }],
        payment_method: "cash",
        idempotency_key: "neg-stock-sale-5-vs-2",
      });

    expect(res.status).toBe(201);
    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(-3);
    const ledger = await ctx.db.all(
      `SELECT quantity_delta, qty_after FROM inventory_ledger
       WHERE product_id = ? AND movement_type = 'sale'
       ORDER BY id`,
      [ctx.productId]
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].quantity_delta).toBe(-5);
    expect(ledger[0].qty_after).toBe(-3);
  });
});
