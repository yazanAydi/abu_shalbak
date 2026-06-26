import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

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
      .send({
        items: [
          { product_id: ctx.productId, quantity: 2, price: 10 },
          { product_id: extraProductId, quantity: 1, price: 5 },
        ],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      });

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
      .send({
        items: [
          { product_id: ctx.productId, quantity: 2, price: 10 },
          { product_id: extraProductId, quantity: 1, price: 5 },
        ],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      });

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
      .send({
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
        suspended_sale_id: suspendedId,
      });

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
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
      });

    expect(res.status).toBe(409);
    expect(res.body.data?.code || res.body.code).toBe("PRICE_MISMATCH");
  });
});
