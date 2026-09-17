import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { listStockBatches } from "../services/stockBatchService.js";
import { withTransaction } from "../utils/dbTx.js";

function unwrapData(body) {
  return body?.data ?? body;
}

describe("stock batches across purchase, sales invoice, POS, refund", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let customerId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد دفعات', 'S-B', 0, 0)`
    );
    supplierId = sup.lastID;
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('عميل دفعات', 'C-B', 0, 0)`
    );
    customerId = cust.lastID;
    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 50 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function postPurchase(items) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: "2026-09-01",
        items,
      });
    expect(created.status).toBe(201);
    const id = unwrapData(created.body).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    return unwrapData(posted.body);
  }

  test("same product with two expiry dates stays as separate lots", async () => {
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    await postPurchase([
      { product_id: ctx.productId, quantity: 4, total_cost: 40, expiry_date: "2026-01-15" },
      { product_id: ctx.productId, quantity: 6, total_cost: 60, expiry_date: "2026-08-20" },
    ]);
    const listed = await listStockBatches(ctx.db, ctx.productId);
    const jan = listed.rows.find((r) => r.expiry_date === "2026-01-15");
    const aug = listed.rows.find((r) => r.expiry_date === "2026-08-20");
    expect(jan.quantity).toBe(4);
    expect(aug.quantity).toBe(6);
    const stockAfter = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(stockAfter).toBe(stockBefore + 10);
    expect(listed.product_stock).toBe(stockAfter);
    expect(listed.dated_sum + listed.unknown_quantity).toBeCloseTo(stockAfter, 6);
  });

  test("sales invoice FEFO allocates earliest lot first and keeps both dates", async () => {
    const listedBefore = await listStockBatches(ctx.db, ctx.productId);
    const janBefore = listedBefore.rows.find((r) => r.expiry_date === "2026-01-15")?.quantity || 0;
    const draft = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        invoice_date: "2026-09-02",
        items: [{ product_id: ctx.productId, quantity: 5, total_price: 50 }],
      });
    expect(draft.status).toBe(201);
    const invId = unwrapData(draft.body).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${invId}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(posted.status).toBe(200);

    const listed = await listStockBatches(ctx.db, ctx.productId);
    const jan = listed.rows.find((r) => r.expiry_date === "2026-01-15");
    const aug = listed.rows.find((r) => r.expiry_date === "2026-08-20");
    expect(jan?.quantity || 0).toBe(Math.max(0, janBefore - 5));
    expect(aug.quantity).toBe(5);
    const detail = await request(ctx.app)
      .get(`/api/v1/sales/invoices/${invId}`)
      .set(authHeader(adminToken));
    const item = unwrapData(detail.body).items[0];
    const alloc = JSON.parse(item.batch_allocations_json);
    expect(alloc.length).toBeGreaterThanOrEqual(2);
    expect(alloc.some((a) => a.expiry_date === "2026-01-15")).toBe(true);
    expect(alloc.some((a) => a.expiry_date === "2026-08-20")).toBe(true);
  });

  test("POS checkout uses the same FEFO lots and duplicate idempotency does not restock", async () => {
    const key = `batch-dup-${Date.now()}`;
    const before = await listStockBatches(ctx.db, ctx.productId);
    const body = withCheckoutKey(
      {
        items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
        payment_method: "cash",
      },
      key
    );
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(body);
    expect(first.status).toBe(201);
    const txId = first.body.data.transaction_id;
    const second = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.transaction_id).toBe(txId);

    const after = await listStockBatches(ctx.db, ctx.productId);
    expect(after.product_stock).toBe(before.product_stock - 2);
    const allocCount = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM stock_batch_allocations
        WHERE reference_type = 'transaction' AND reference_id = ?`,
      [txId]
    );
    expect(Number(allocCount.n)).toBeGreaterThan(0);
  });

  test("unknown-expiry stock remains unlabeled and negative overflow is unknown", async () => {
    const extra = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990002', 'Unknown Lot Product', 8, 3, 'Test', 4)`
    );
    const pid = extra.lastID;
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990002', 8, 3, 1, 1)`,
      [pid]
    );
    const listed0 = await listStockBatches(ctx.db, pid);
    const unknown0 = listed0.rows.find((r) => r.virtual);
    expect(unknown0.quantity).toBe(4);
    expect(unknown0.status_label).toBe("غير محدد");
    expect(unknown0.expiry_date).toBeNull();

    const sell = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: pid, quantity: 6, price: 8 }],
        payment_method: "cash",
      }));
    expect(sell.status).toBe(201);
    const listed = await listStockBatches(ctx.db, pid);
    expect(listed.product_stock).toBe(-2);
    const unknown = listed.rows.find((r) => r.virtual);
    expect(unknown.quantity).toBe(-2);
    expect(unknown.expiry_date).toBeNull();
  });

  test("refund restores dated lots instead of inventing a new expiry", async () => {
    const pidIns = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990003', 'Refund Lot Product', 9, 4, 'Test', 0)`
    );
    const pid = pidIns.lastID;
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990003', 9, 4, 1, 1)`,
      [pid]
    );
    await postPurchase([
      { product_id: pid, quantity: 8, total_cost: 32, expiry_date: "2027-01-01" },
    ]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: pid, quantity: 3, price: 9 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    const txId = sale.body.data.transaction_id;
    const afterSale = await listStockBatches(ctx.db, pid);
    expect(afterSale.rows.find((r) => r.expiry_date === "2027-01-01").quantity).toBe(5);

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
    await withTransaction(ctx.db, async () => {
      const refundIns = await ctx.db.run(
        `INSERT INTO refunds (original_transaction_id, items_json, subtotal, tax, total, payment_method, cashier_id, status)
         VALUES (?, ?, 27, 0, 27, 'cash', ?, 'approved')`,
        [txId, JSON.stringify([{ product_id: pid, quantity: 3, conversion_to_base: 1 }]), cashier.id]
      );
      const { applyApprovedRefundEffects } = await import("../services/refundRequestService.js");
      await applyApprovedRefundEffects(ctx.db, {
        id: refundIns.lastID,
        original_transaction_id: txId,
        items_json: JSON.stringify([{ product_id: pid, quantity: 3, conversion_to_base: 1 }]),
        payment_method: "cash",
        total: 27,
        approved_by_id: 1,
      });
    });

    const afterRefund = await listStockBatches(ctx.db, pid);
    expect(afterRefund.rows.find((r) => r.expiry_date === "2027-01-01").quantity).toBe(8);
    expect(afterRefund.product_stock).toBe(8);
  });

  test("posting a purchase invoice twice does not duplicate stock", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: "2026-09-03",
        items: [{ product_id: ctx.productId, quantity: 1, total_cost: 10, expiry_date: "2026-11-01" }],
      });
    const id = unwrapData(created.body).id;
    const first = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(first.status).toBe(200);
    const stockAfterFirst = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const second = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(second.status).toBe(400);
    const stockAfterSecond = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(stockAfterSecond).toBe(stockAfterFirst);
  });
});
