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
