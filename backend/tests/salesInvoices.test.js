import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function unwrapData(body) {
  return body?.data ?? body;
}

describe("sales invoices", () => {
  let ctx;
  let adminToken;
  let customerId;
  let invoiceId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;

    const custIns = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('Test Buyer', 'C100', 0, 0)`
    );
    customerId = custIns.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("creates draft sales invoice", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        invoice_date: "2026-07-01",
        items: [{ product_id: ctx.productId, quantity: 2, total_price: 20 }],
      });

    expect(res.status).toBe(201);
    const row = unwrapData(res.body);
    expect(row.status).toBe("draft");
    expect(Number(row.total)).toBeGreaterThan(0);
    invoiceId = row.id;
  });

  test("rejects post without payment", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});

    expect(res.status).toBe(400);
  });

  test("posts with cash payment and decreases stock", async () => {
    const beforeStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );

    const res = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });

    expect(res.status).toBe(200);
    const row = unwrapData(res.body);
    expect(row.status).toBe("posted");
    expect(row.transaction_id).toBeTruthy();

    const afterStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(afterStock).toBe(beforeStock - 2);

    const payments = await ctx.db.all(
      "SELECT * FROM sales_invoice_payments WHERE invoice_id = ?",
      [invoiceId]
    );
    expect(payments.length).toBe(1);
    expect(payments[0].payment_method).toBe("cash");
  });

  test("cannot post or edit posted invoice", async () => {
    const postAgain = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(postAgain.status).toBe(400);

    const edit = await request(ctx.app)
      .put(`/api/v1/sales/invoices/${invoiceId}`)
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        items: [{ product_id: ctx.productId, quantity: 1, total_price: 10 }],
      });
    expect(edit.status).toBe(400);
  });

  test("mixed payment updates customer balance for on_account portion", async () => {
    const invRes = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        items: [{ product_id: ctx.productId, quantity: 1, total_price: 10 }],
      });
    const inv = unwrapData(invRes.body);
    const total = Number(inv.total);

    const beforeBal = Number(
      (await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance
    );

    const postRes = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${inv.id}/post`)
      .set(authHeader(adminToken))
      .send({
        payments: [
          { method: "cash", amount: total / 2 },
          { method: "on_account", amount: total / 2 },
        ],
      });

    expect(postRes.status).toBe(200);
    const afterBal = Number(
      (await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance
    );
    expect(afterBal).toBeCloseTo(beforeBal + total / 2, 2);

    const detail = await request(ctx.app)
      .get(`/api/v1/sales/invoices/${inv.id}`)
      .set(authHeader(adminToken));
    expect(detail.status).toBe(200);
    const row = unwrapData(detail.body);
    expect(row.party_balance.before).toBeCloseTo(beforeBal, 2);
    expect(row.party_balance.after).toBeCloseTo(afterBal, 2);
  });

  test("check payment requires bank name", async () => {
    const invRes = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        items: [{ product_id: ctx.productId, quantity: 1, total_price: 5 }],
      });
    const inv = unwrapData(invRes.body);

    const bad = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${inv.id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "check" });
    expect(bad.status).toBe(400);

    const ok = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${inv.id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "check", bank_name: "بنك فلسطين", check_no: "123" });
    expect(ok.status).toBe(200);
  });
});

describe("sales invoices post-all", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let customerId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const custIns = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('Bulk Buyer', 'C-PA', 0, 0)`
    );
    customerId = custIns.lastID;
    await ctx.db.run("UPDATE products SET stock = 50 WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createDraft(quantity, totalPrice) {
    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: customerId,
        invoice_date: "2026-09-07",
        items: [{ product_id: ctx.productId, quantity, total_price: totalPrice }],
      });
    expect(res.status).toBe(201);
    return unwrapData(res.body);
  }

  test("rejects without payment method", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test("rejects cashier", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(cashierToken))
      .send({ payment_method: "cash" });
    expect(res.status).toBe(403);
  });

  test("returns posted_count 0 when there is nothing to post", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(0);
    expect(body.ids).toEqual([]);
  });

  test("posts multiple drafts with cash and decreases stock", async () => {
    const a = await createDraft(2, 20);
    const b = await createDraft(3, 30);
    const beforeStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );

    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(2);
    expect(body.ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(body.errors).toEqual([]);

    const afterStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(afterStock).toBe(beforeStock - 5);

    const postedA = await ctx.db.get("SELECT status FROM sales_invoices WHERE id = ?", [a.id]);
    const postedB = await ctx.db.get("SELECT status FROM sales_invoices WHERE id = ?", [b.id]);
    expect(postedA.status).toBe("posted");
    expect(postedB.status).toBe("posted");
  });

  test("skips already-posted invoices", async () => {
    const extra = await createDraft(1, 10);
    const already = await createDraft(1, 10);
    const postOne = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${already.id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(postOne.status).toBe(200);

    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(1);
    expect(body.ids).toEqual([extra.id]);
  });

  test("posts what it can when one invoice lacks stock", async () => {
    await ctx.db.run("UPDATE products SET stock = 1 WHERE id = ?", [ctx.productId]);
    const okInv = await createDraft(1, 10);
    const failInv = await createDraft(5, 50);

    const res = await request(ctx.app)
      .post("/api/v1/sales/invoices/post-all")
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(1);
    expect(body.ids).toEqual([okInv.id]);
    expect(body.errors).toEqual([
      expect.objectContaining({ id: failInv.id }),
    ]);

    const failRow = await ctx.db.get("SELECT status FROM sales_invoices WHERE id = ?", [failInv.id]);
    expect(failRow.status).toBe("draft");
  });
});
