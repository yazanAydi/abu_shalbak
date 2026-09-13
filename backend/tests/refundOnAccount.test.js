import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

describe("On-account refunds", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let customerId;
  let productPrice;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;

    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});

    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('Refund Credit Cust', 'RC1', 0, 0, 10000)`
    );
    customerId = cust.lastID;
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    productPrice = Number(product.price);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function completeOnAccountSale({ quantity = 1, extraPayments = null } = {}) {
    const body = extraPayments
      ? {
          items: [{ product_id: ctx.productId, quantity, price: productPrice }],
          customer_id: customerId,
          payments: extraPayments,
        }
      : {
          items: [{ product_id: ctx.productId, quantity, price: productPrice }],
          payment_method: "on_account",
          customer_id: customerId,
        };
    const checkoutRes = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(checkoutRes.status).toBe(202);
    const requestId = checkoutRes.body.data.request_id;
    const approveRes = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);
    const data = approveRes.body.data || approveRes.body;
    const txId = data.request?.transaction_id ?? data.checkout?.transaction_id ?? data.transaction_id;
    expect(txId).toBeTruthy();
    return txId;
  }

  test("on-account sale refund decrements customer balance and does not touch the drawer", async () => {
    const txId = await completeOnAccountSale({ quantity: 2 });
    const before = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(before.balance)).toBeCloseTo(productPrice * 2, 2);

    const cashMovementsBefore = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'refund'`
    );

    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "on-account refund",
        payment_method: "on_account",
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;

    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);

    const after = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(after.balance)).toBeCloseTo(productPrice, 2);

    const cashMovementsAfter = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM shift_cash_movements WHERE movement_type = 'refund'`
    );
    expect(Number(cashMovementsAfter.n)).toBe(Number(cashMovementsBefore.n));
  });

  test("cash refund of an on-account sale is rejected", async () => {
    const txId = await completeOnAccountSale({ quantity: 1 });
    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "wrong method",
        payment_method: "cash",
      });
    expect(createRes.status).toBe(400);
    expect(createRes.body.code || createRes.body.data?.code).toBe("REFUND_METHOD_MISMATCH");
  });

  test("mixed sale with on_account must refund to the customer account", async () => {
    const cashPart = Number((productPrice / 2).toFixed(2));
    const onAccountPart = Number((productPrice - cashPart).toFixed(2));
    const txId = await completeOnAccountSale({
      quantity: 1,
      extraPayments: [
        { method: "cash", amount: cashPart },
        { method: "on_account", amount: onAccountPart },
      ],
    });

    const lookup = await request(ctx.app)
      .get(`/api/v1/refunds/lookup/${txId}`)
      .set(authHeader(cashierToken));
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.has_on_account).toBe(true);

    const rejectCash = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "visa",
      });
    expect(rejectCash.status).toBe(400);

    const before = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    const createRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "on_account",
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.data.request_id;
    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);
    const after = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
    expect(Number(after.balance)).toBeCloseTo(Number(before.balance) - onAccountPart, 2);
  });
});
