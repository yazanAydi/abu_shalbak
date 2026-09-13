import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

function formatSku(n) {
  return String(n);
}

/**
 * Multi-user safety: parallel checkouts and product edits must not lose
 * stock updates or mint duplicate receipt numbers.
 */
describe("Concurrency performance / correctness", () => {
  let ctx;
  let cashierToken;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 200 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("N parallel checkouts persist every stock delta and unique receipts", async () => {
    const N = 12;
    await ctx.db.run("UPDATE products SET stock = 100 WHERE id = ?", [ctx.productId]);

    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(ctx.app)
          .post("/api/v1/checkout")
          .set(authHeader(cashierToken))
          .send({
            items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
            payment_method: "cash",
            idempotency_key: `conc-sale-${Date.now()}-${i}`,
          })
      )
    );
    const elapsed = Date.now() - started;

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);

    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
    expect(product.stock).toBe(100 - N);

    const receipts = results.map((r) => r.body?.data?.receipt_number).filter(Boolean);
    expect(new Set(receipts).size).toBe(receipts.length);

    const txs = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    expect(Number(txs.n)).toBeGreaterThanOrEqual(N);

    // eslint-disable-next-line no-console
    console.log(`[concurrency] ${N} checkouts in ${elapsed}ms (${(elapsed / N).toFixed(1)}ms/sale)`);
  });

  test("parallel product edits do not clobber each other", async () => {
    const extras = [];
    const stamp = Date.now();
    for (let i = 0; i < 6; i += 1) {
      const ins = await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, sku)
         VALUES (?, ?, 5, 2, 'Test', 20, ?)`,
        [`88${String(stamp).slice(-8)}${i}`, `Edit ${i}`, formatSku(900000 + i)]
      );
      extras.push(ins.lastID);
    }

    const results = await Promise.all(
      extras.map((id, i) =>
        request(ctx.app)
          .put(`/api/v1/products/${id}`)
          .set(authHeader(adminToken))
          .send({
            barcode: `89${String(stamp).slice(-8)}${i}`,
            name: `Edited ${i}`,
            price: 7 + i,
            cost: 2,
            stock: 20,
            category: "Test",
          })
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const rows = await ctx.db.all(
      `SELECT id, name, price FROM products WHERE id IN (${extras.map(() => "?").join(",")})`,
      extras
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(String(row.name)).toMatch(/^Edited /);
    }
  }, 20000);
});
