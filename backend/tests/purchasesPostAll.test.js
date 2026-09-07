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

describe("purchases post-all", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد ترحيل الكل', 'S-PA', 0, 0)`
    );
    supplierId = sup.lastID;
    await ctx.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')"
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createInvoice(quantity, totalCost) {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: "2026-09-07",
        items: [{ product_id: ctx.productId, quantity, total_cost: totalCost }],
      });
    expect(res.status).toBe(201);
    return unwrapData(res.body);
  }

  async function createReturn(quantity, totalCost) {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: "2026-09-07",
        items: [{ product_id: ctx.productId, quantity, total_cost: totalCost }],
      });
    expect(res.status).toBe(201);
    return unwrapData(res.body);
  }

  test("rejects cashier", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices/post-all")
      .set(authHeader(cashierToken))
      .send({});
    expect(res.status).toBe(403);
  });

  test("returns posted_count 0 when there is nothing to post", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices/post-all")
      .set(authHeader(adminToken))
      .send({});
    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(0);
    expect(body.ids).toEqual([]);
  });

  test("posts multiple invoice drafts and updates stock and supplier balance", async () => {
    const a = await createInvoice(2, 20);
    const b = await createInvoice(3, 30);
    const beforeStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const beforeBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );

    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices/post-all")
      .set(authHeader(adminToken))
      .send({});

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(2);
    expect(body.ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(body.errors).toEqual([]);

    const afterStock = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    expect(afterStock).toBe(beforeStock + 5);

    const afterBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );
    expect(afterBal).toBeCloseTo(beforeBal + Number(a.total) + Number(b.total), 2);

    const postedA = await ctx.db.get("SELECT status FROM purchase_invoices WHERE id = ?", [a.id]);
    const postedB = await ctx.db.get("SELECT status FROM purchase_invoices WHERE id = ?", [b.id]);
    expect(postedA.status).toBe("posted");
    expect(postedB.status).toBe("posted");
  });

  test("skips already-posted invoices", async () => {
    const extra = await createInvoice(1, 10);
    const already = await createInvoice(1, 10);
    const postOne = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${already.id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(postOne.status).toBe(200);

    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices/post-all")
      .set(authHeader(adminToken))
      .send({});

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(1);
    expect(body.ids).toEqual([extra.id]);
  });

  test("does not post return drafts when posting invoices", async () => {
    const ret = await createReturn(1, 5);
    const res = await request(ctx.app)
      .post("/api/v1/purchases/invoices/post-all")
      .set(authHeader(adminToken))
      .send({});
    expect(res.status).toBe(200);
    expect(unwrapData(res.body).ids).not.toContain(ret.id);
    const row = await ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [ret.id]);
    expect(row.status).toBe("draft");
  });

  test("posts return drafts and reduces supplier balance", async () => {
    const leftover = await ctx.db.all("SELECT id FROM purchase_returns WHERE status = 'draft'");
    expect(leftover.length).toBeGreaterThan(0);
    const beforeBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );

    const res = await request(ctx.app)
      .post("/api/v1/purchases/returns/post-all")
      .set(authHeader(adminToken))
      .send({});

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(leftover.length);
    expect(body.errors).toEqual([]);

    const afterBal = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );
    expect(afterBal).toBeLessThan(beforeBal);

    for (const row of leftover) {
      const posted = await ctx.db.get("SELECT status FROM purchase_returns WHERE id = ?", [row.id]);
      expect(posted.status).toBe("posted");
    }
  });
});
