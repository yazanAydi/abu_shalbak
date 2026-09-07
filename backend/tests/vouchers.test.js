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

describe("vouchers post-all", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let customerId;
  let supplierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;

    const custIns = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('زبون سندات', 'C-V1', 100, 100)`
    );
    customerId = custIns.lastID;

    const supIns = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد سندات', 'S-V1', 200, 200)`
    );
    supplierId = supIns.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createVoucher({ type, amount, customer_id = null, supplier_id = null }) {
    const res = await request(ctx.app)
      .post("/api/v1/vouchers")
      .set(authHeader(adminToken))
      .send({
        voucher_type: type,
        voucher_date: "2026-09-07",
        lines: [
          {
            line_type: "cash",
            amount,
            currency: "NIS",
            customer_id,
            supplier_id,
          },
        ],
      });
    expect(res.status).toBe(201);
    return unwrapData(res.body);
  }

  test("posts multiple drafts of one type and updates balances", async () => {
    const pay1 = await createVoucher({ type: "payment", amount: 50, supplier_id: supplierId });
    const pay2 = await createVoucher({ type: "payment", amount: 20, supplier_id: supplierId });
    const receipt = await createVoucher({ type: "receipt", amount: 30, customer_id: customerId });

    const res = await request(ctx.app)
      .post("/api/v1/vouchers/post-all")
      .set(authHeader(adminToken))
      .send({ type: "payment" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(2);
    expect(body.ids).toEqual(expect.arrayContaining([pay1.id, pay2.id]));
    expect(body.ids).not.toContain(receipt.id);

    const posted1 = await ctx.db.get("SELECT status FROM vouchers WHERE id = ?", [pay1.id]);
    const posted2 = await ctx.db.get("SELECT status FROM vouchers WHERE id = ?", [pay2.id]);
    const stillDraft = await ctx.db.get("SELECT status FROM vouchers WHERE id = ?", [receipt.id]);
    expect(posted1.status).toBe("posted");
    expect(posted2.status).toBe("posted");
    expect(stillDraft.status).toBe("draft");

    const supplier = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(supplier.balance)).toBe(130);

    const customerBefore = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(customerBefore.balance)).toBe(100);

    const receiptRes = await request(ctx.app)
      .post("/api/v1/vouchers/post-all")
      .set(authHeader(adminToken))
      .send({ type: "receipt" });
    expect(receiptRes.status).toBe(200);
    expect(unwrapData(receiptRes.body).posted_count).toBe(1);

    const customer = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(customer.balance)).toBe(70);
  });

  test("skips already-posted vouchers", async () => {
    const extra = await createVoucher({ type: "payment", amount: 10, supplier_id: supplierId });
    const already = await createVoucher({ type: "payment", amount: 5, supplier_id: supplierId });
    const postOne = await request(ctx.app)
      .post(`/api/v1/vouchers/${already.id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(postOne.status).toBe(200);

    const before = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );

    const res = await request(ctx.app)
      .post("/api/v1/vouchers/post-all")
      .set(authHeader(adminToken))
      .send({ type: "payment" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(1);
    expect(body.ids).toEqual([extra.id]);

    const after = Number(
      (await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId])).balance
    );
    expect(after).toBe(before - 10);
  });

  test("rejects cashier", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/vouchers/post-all")
      .set(authHeader(cashierToken))
      .send({ type: "payment" });
    expect(res.status).toBe(403);
  });

  test("returns posted_count 0 when there is nothing to post", async () => {
    const leftover = await ctx.db.all("SELECT id FROM vouchers WHERE status = 'draft'");
    for (const row of leftover) {
      const post = await request(ctx.app)
        .post(`/api/v1/vouchers/${row.id}/post`)
        .set(authHeader(adminToken))
        .send({});
      expect(post.status).toBe(200);
    }

    const res = await request(ctx.app)
      .post("/api/v1/vouchers/post-all")
      .set(authHeader(adminToken))
      .send({ type: "payment" });

    expect(res.status).toBe(200);
    const body = unwrapData(res.body);
    expect(body.posted_count).toBe(0);
    expect(body.ids).toEqual([]);
  });

  test("receipt voucher for a supplier returns party_balance", async () => {
    const created = await createVoucher({ type: "receipt", amount: 25, supplier_id: supplierId });
    const post = await request(ctx.app)
      .post(`/api/v1/vouchers/${created.id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);

    const res = await request(ctx.app)
      .get(`/api/v1/vouchers/${created.id}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const row = unwrapData(res.body);
    expect(row.party_balance).toBeTruthy();
    expect(row.party_balance.before).toBeDefined();
    expect(row.party_balance.after).toBeDefined();
    expect(Number(row.party_balance.after) - Number(row.party_balance.before)).toBeCloseTo(25, 2);
  });
});
