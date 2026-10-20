import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { sellableQuantity } from "../services/warehouseBatchStock.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("POS shortage replenishment stays consistent", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let mainId;
  let returnsId;

  beforeAll(async () => {
    ctx = await createTestContext();
    if (!/abo-shalbak-test-/.test(ctx.dbPath)) throw new Error("refusing non-temporary database");
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    supplierId = (await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد التغطية', 'S-COVER', 0, 0)"
    )).lastID;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const warehouses = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))).body);
    mainId = warehouses.find((row) => row.type === "main").id;
    returnsId = warehouses.find((row) => row.type === "returns").id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, cost = 4) {
    const barcode = `77${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 9)}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
       VALUES (?, ?, 10, ?, 'Test', 0, 1)`,
      [barcode, name, cost]
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', ?, 10, ?, 1, 1)`,
      [ins.lastID, barcode, cost]
    );
    return ins.lastID;
  }

  async function sell(productId, quantity, key) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: 10 }],
        payment_method: "cash",
      }, key));
    expect(res.status).toBe(201);
    return unwrap(res.body).transaction_id;
  }

  async function receive(productId, quantity, expiry = null) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: shopTodayYmd(),
        items: [{ product_id: productId, quantity, total_cost: quantity * 4, expiry_date: expiry }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    return unwrap(created.body);
  }

  async function picture(productId) {
    const stock = Number((await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [productId])).stock);
    const cost = Number((await ctx.db.get("SELECT cost FROM products WHERE id = ?", [productId])).cost);
    const places = await ctx.db.all(
      `SELECT w.type, s.expiry_date, s.quantity
         FROM warehouse_batch_stock s JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.product_id = ? ORDER BY w.type, s.expiry_date`,
      [productId]
    );
    const positive = Number((await ctx.db.get(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_source_lots WHERE product_id = ? AND quantity > 0",
      [productId]
    )).qty);
    const shortage = Number((await ctx.db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_source_lots
        WHERE product_id = ? AND quantity < 0 AND supplier_id IS NULL`,
      [productId]
    )).qty);
    const attributed = Number((await ctx.db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_source_lots
        WHERE product_id = ? AND supplier_id IS NOT NULL AND quantity > 0`,
      [productId]
    )).qty);
    const warehouse = Number((await ctx.db.get(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM warehouse_batch_stock WHERE product_id = ?",
      [productId]
    )).qty);
    return {
      stock,
      cost,
      positive,
      shortage,
      attributed,
      warehouse,
      places: places.map((row) => [row.type, row.expiry_date || null, Number(row.quantity)]),
      sellable: await sellableQuantity(ctx.db, productId),
    };
  }

  test("selling 2 then receiving 5 leaves 3 available everywhere", async () => {
    const productId = await makeProduct("تغطية 5");
    const txId = await sell(productId, 2, "cover-sell-2");
    const sold = await picture(productId);
    expect(sold.stock).toBe(-2);
    expect(sold.warehouse).toBe(-2);
    expect(sold.shortage).toBe(-2);
    expect(sold.positive).toBe(0);
    expect(sold.sellable).toBe(0);

    const invoice = await receive(productId, 5);
    expect(Number(invoice.total)).toBe(20);
    const after = await picture(productId);
    expect(after.stock).toBe(3);
    expect(after.warehouse).toBe(3);
    expect(after.positive).toBe(3);
    expect(after.shortage).toBe(0);
    expect(after.attributed).toBe(3);
    expect(after.sellable).toBe(3);
    expect(after.places).toEqual([["main", null, 3]]);
    const snapshot = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(snapshot.unit_cost_at_sale)).toBe(4);
    await ctx.db.run("UPDATE products SET cost = 9 WHERE id = ?", [productId]);
    const still = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(Number(still.unit_cost_at_sale)).toBe(4);

    const tooMuch = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: mainId,
        to_warehouse_id: returnsId,
        items: [{ product_id: productId, quantity: 4, batch_source: "undated" }],
      });
    expect(tooMuch.status).toBe(201);
    const refused = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(tooMuch.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(refused.status).toBe(400);
    expect((await picture(productId)).stock).toBe(3);

    const moved = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: mainId,
        to_warehouse_id: returnsId,
        items: [{ product_id: productId, quantity: 3, batch_source: "undated" }],
      });
    expect(moved.status).toBe(201);
    expect((await request(ctx.app).post(`/api/v1/warehouses/transfers/${unwrap(moved.body).id}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const parked = await picture(productId);
    expect(parked.stock).toBe(3);
    expect(parked.sellable).toBe(0);
    expect(parked.places).toEqual([["returns", null, 3]]);

    const listed = unwrap((await request(ctx.app)
      .get("/api/v1/warehouses/returns-stock")
      .query({ supplier_id: supplierId, limit: 50 })
      .set(authHeader(adminToken))).body);
    const row = (listed.rows || []).find((item) => item.product_id === productId);
    expect(Number(row.quantity)).toBe(3);
    const overReturn = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: shopTodayYmd(),
        items: [{
          product_id: productId,
          quantity: 4,
          total_cost: 16,
          batch_source: "undated",
          source_lot_id: row.source_lot_id,
        }],
      });
    expect(overReturn.status).toBe(201);
    const overPost = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(overReturn.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(overPost.status).toBe(400);
    expect((await picture(productId)).stock).toBe(3);
    const accepted = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: shopTodayYmd(),
        items: [{
          product_id: productId,
          quantity: 3,
          total_cost: 12,
          batch_source: "undated",
          source_lot_id: row.source_lot_id,
        }],
      });
    expect(accepted.status).toBe(201);
    expect((await request(ctx.app).post(`/api/v1/purchases/returns/${unwrap(accepted.body).id}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    expect((await picture(productId)).stock).toBe(0);
  });

  test("partial, exact, and larger replenishment settle the shortage", async () => {
    const partialId = await makeProduct("تغطية جزئية");
    await sell(partialId, 5, "partial-sell");
    await receive(partialId, 2);
    const partial = await picture(partialId);
    expect(partial.stock).toBe(-3);
    expect(partial.positive).toBe(0);
    expect(partial.shortage).toBe(-3);
    expect(partial.sellable).toBe(0);
    expect(partial.warehouse).toBe(-3);

    const exactId = await makeProduct("تغطية تامة");
    await sell(exactId, 2, "exact-sell");
    await receive(exactId, 2);
    const exact = await picture(exactId);
    expect(exact.stock).toBe(0);
    expect(exact.positive).toBe(0);
    expect(exact.shortage).toBe(0);
    expect(exact.sellable).toBe(0);
    expect(exact.warehouse).toBe(0);

    const overId = await makeProduct("تغطية زائدة");
    const txId = await sell(overId, 2, "over-sell");
    await receive(overId, 6);
    expect((await picture(overId)).sellable).toBe(4);
    const refund = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: overId, quantity: 1 }],
        payment_method: "cash",
        reason: "after replenishment",
      });
    expect(refund.status).toBe(201);
    expect((await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refund.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" })).status).toBe(200);
    const restored = await picture(overId);
    expect(restored.stock).toBe(5);
    expect(restored.warehouse).toBe(5);
    expect(restored.positive).toBe(5);
    expect(restored.sellable).toBe(5);
    expect(Number((await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ?",
      [txId]
    )).unit_cost_at_sale)).toBe(4);
  });

  test("a count can replace a shortage with a newly dated quantity", async () => {
    const productId = await makeProduct("جرد بعد نقص");
    await sell(productId, 2, "count-sell");
    expect((await picture(productId)).stock).toBe(-2);
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const saved = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: productId,
        sources: [
          { batch_source: "dated", expiry_date: "2027-06-01", counted_qty: 4 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(saved.status).toBe(200);
    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    const after = await picture(productId);
    expect(after.stock).toBe(4);
    expect(after.sellable).toBe(4);
    expect(after.shortage).toBe(0);
    expect(after.warehouse).toBe(4);
  });

  test("expired and returns quantities stay put when a shortage is created", async () => {
    const productId = await makeProduct("منتهي ومرتجعات");
    await receive(productId, 4, "2020-01-15");
    const parked = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: mainId,
        to_warehouse_id: returnsId,
        items: [{ product_id: productId, quantity: 1, expiry_date: "2020-01-15", batch_source: "dated" }],
      });
    expect(parked.status).toBe(201);
    expect((await request(ctx.app).post(`/api/v1/warehouses/transfers/${unwrap(parked.body).id}/post`).set(authHeader(adminToken)).send({})).status).toBe(200);
    const before = await picture(productId);
    await sell(productId, 2, "expired-short");
    const after = await picture(productId);
    expect(after.stock).toBe(before.stock - 2);
    const expired = await ctx.db.get(
      "SELECT quantity FROM product_batches WHERE product_id = ? AND expiry_date = '2020-01-15'",
      [productId]
    );
    expect(Number(expired.quantity)).toBe(4);
    const returnsQty = await ctx.db.get(
      `SELECT s.quantity FROM warehouse_batch_stock s
        WHERE s.product_id = ? AND s.warehouse_id = ? AND s.expiry_date = '2020-01-15'`,
      [productId, returnsId]
    );
    expect(Number(returnsQty.quantity)).toBe(1);
    expect(after.sellable).toBe(0);
  });
});
