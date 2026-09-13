/**
 * Shared HTTP + DB setup for Tier A concurrency tests.
 */
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "../helpers.js";
import { insertCashier, insertCustomer, insertProduct } from "./factories.js";
import { captureBaseline } from "./snapshot.js";
import { checkInvariants, assertInvariants, formatInvariantReport } from "./invariants.js";

export { captureBaseline, checkInvariants, assertInvariants, formatInvariantReport };

export function unwrap(res) {
  return res.body?.data ?? res.body;
}

export function envelopeCode(res) {
  return res.body?.code || res.body?.data?.code || null;
}

export function uniqueKey(prefix = "load") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export async function startShift(app, token) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  return res;
}

/**
 * @param {{ extraCashiers?: number, extraProducts?: number, customer?: object }} [opts]
 */
export async function setupLoadContext(opts = {}) {
  const ctx = await createTestContext();
  const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
  const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
  const cashierToken = cashierLogin.body.token;
  const adminToken = adminLogin.body.token;
  if (!cashierToken || !adminToken) {
    throw new Error(
      `login failed cashier=${cashierLogin.status} admin=${adminLogin.status} ${JSON.stringify(cashierLogin.body)}`
    );
  }

  const shiftRes = await startShift(ctx.app, cashierToken);
  if (![200, 201].includes(shiftRes.status)) {
    throw new Error(`shift start failed ${shiftRes.status} ${JSON.stringify(shiftRes.body)}`);
  }

  const cashiers = [
    {
      id: cashierLogin.body.user?.id,
      username: "testcashier",
      token: cashierToken,
      shiftId: unwrap(shiftRes).shift_id,
    },
  ];

  for (let i = 0; i < (opts.extraCashiers || 0); i += 1) {
    const user = await insertCashier(ctx.db, { index: i });
    const tok = (await login(ctx.app, user.username, user.password, "pos")).body.token;
    const sh = await startShift(ctx.app, tok);
    cashiers.push({
      id: user.id,
      username: user.username,
      token: tok,
      shiftId: unwrap(sh).shift_id,
    });
  }

  const products = [];
  for (let i = 0; i < (opts.extraProducts || 0); i += 1) {
    products.push(await insertProduct(ctx.db, { n: 2000 + i, stock: 500, price: 10 }));
  }

  let customer = null;
  if (opts.customer) {
    customer = await insertCustomer(ctx.db, opts.customer);
  }

  const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);

  return {
    ctx,
    app: ctx.app,
    db: ctx.db,
    productId: ctx.productId,
    product,
    cashierToken,
    adminToken,
    cashiers,
    products,
    customer,
  };
}

export async function teardownLoadContext(harness) {
  if (harness?.ctx) await destroyTestContext(harness.ctx);
}

export function checkoutBody({ productId, quantity = 1, price = 10, payment_method = "cash", extra = {} }) {
  return {
    items: [{ product_id: productId, quantity, price }],
    payment_method,
    idempotency_key: extra.idempotency_key || uniqueKey("chk"),
    ...extra,
  };
}

export function checkout(app, token, body) {
  return request(app).post("/api/v1/checkout").set(authHeader(token)).send(withCheckoutKey(body));
}

export async function checkoutCash(app, token, productId, price, quantity = 1, key) {
  return checkout(
    app,
    token,
    checkoutBody({
      productId,
      price,
      quantity,
      extra: key ? { idempotency_key: key } : {},
    })
  );
}

export async function runAndCheckInvariants(db, baseline, extras = {}) {
  const results = await checkInvariants(db, baseline, extras);
  assertInvariants(results);
  return results;
}

export function diagnoseHttp(label, res) {
  return `${label} status=${res.status} code=${envelopeCode(res)} body=${JSON.stringify(res.body).slice(0, 400)}`;
}
