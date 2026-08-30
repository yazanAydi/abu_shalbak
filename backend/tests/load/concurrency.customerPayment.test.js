import request from "supertest";
import { authHeader } from "../helpers.js";
import {
  setupLoadContext,
  teardownLoadContext,
  unwrap,
  diagnoseHttp,
} from "./harness.js";

function pay(app, token, customerId, amount) {
  return request(app)
    .post(`/api/v1/customers/${customerId}/payment`)
    .set(authHeader(token))
    .send({ amount });
}

async function createCustomer(app, token, fields) {
  const res = await request(app).post("/api/v1/customers").set(authHeader(token)).send(fields);
  expect(res.status).toBe(201);
  return unwrap(res);
}

describe("concurrent customer payments", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("two simultaneous payments both apply (no lost update)", async () => {
    const cust = await createCustomer(h.app, h.adminToken, {
      name: "Pay Two",
      credit_limit: 1000,
      opening_balance: 500,
    });
    const beforeTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const beforeV = await h.db.get("SELECT COUNT(*) AS n FROM vouchers");
    const beforeVl = await h.db.get("SELECT COUNT(*) AS n FROM voucher_lines");

    const results = await Promise.all([
      pay(h.app, h.adminToken, cust.id, 100),
      pay(h.app, h.adminToken, cust.id, 200),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const after = await h.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [cust.id]);
    expect(Number(after.balance)).toBe(200);
    expect(Number(after.credit_limit)).toBe(1000);

    const afterTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const afterV = await h.db.get("SELECT COUNT(*) AS n FROM vouchers");
    const afterVl = await h.db.get("SELECT COUNT(*) AS n FROM voucher_lines");
    expect(Number(afterTx.n)).toBe(Number(beforeTx.n));
    expect(Number(afterV.n)).toBe(Number(beforeV.n));
    expect(Number(afterVl.n)).toBe(Number(beforeVl.n));
  }, 20000);

  test("10 concurrent payments: final balance equals initial minus the sum", async () => {
    const initial = 1000;
    const amounts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const cust = await createCustomer(h.app, h.adminToken, {
      name: "Pay Ten",
      credit_limit: 2000,
      opening_balance: initial,
    });
    const beforeTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const beforeV = await h.db.get("SELECT COUNT(*) AS n FROM vouchers");
    const beforeSp = await h.db.get("SELECT COUNT(*) AS n FROM sale_payments");

    const results = await Promise.all(amounts.map((amt) => pay(h.app, h.adminToken, cust.id, amt)));
    const unexpected = results.filter((r) => r.status !== 200);
    expect(unexpected.map((r) => diagnoseHttp("pay", r))).toEqual([]);

    const sum = amounts.reduce((s, a) => s + a, 0);
    const after = await h.db.get("SELECT balance, credit_limit, no_credit FROM customers WHERE id = ?", [
      cust.id,
    ]);
    expect(Number(after.balance)).toBe(initial - sum);
    expect(Number(after.credit_limit)).toBe(2000);
    expect(Number(after.no_credit)).toBe(0);

    const balances = results.map((r) => Number(unwrap(r).new_balance));
    expect(balances.every((b) => Number.isFinite(b))).toBe(true);
    expect(new Set(balances).size).toBe(10);

    const afterTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const afterV = await h.db.get("SELECT COUNT(*) AS n FROM vouchers");
    const afterSp = await h.db.get("SELECT COUNT(*) AS n FROM sale_payments");
    expect(Number(afterTx.n)).toBe(Number(beforeTx.n));
    expect(Number(afterV.n)).toBe(Number(beforeV.n));
    expect(Number(afterSp.n)).toBe(Number(beforeSp.n));
  }, 20000);

  test("different customers can be paid concurrently without sharing a balance", async () => {
    const a = await createCustomer(h.app, h.adminToken, {
      name: "Pay A",
      credit_limit: 500,
      opening_balance: 300,
    });
    const b = await createCustomer(h.app, h.adminToken, {
      name: "Pay B",
      credit_limit: 800,
      opening_balance: 400,
    });

    const results = await Promise.all([
      pay(h.app, h.adminToken, a.id, 50),
      pay(h.app, h.adminToken, a.id, 70),
      pay(h.app, h.adminToken, b.id, 80),
      pay(h.app, h.adminToken, b.id, 90),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const afterA = await h.db.get("SELECT balance FROM customers WHERE id = ?", [a.id]);
    const afterB = await h.db.get("SELECT balance FROM customers WHERE id = ?", [b.id]);
    expect(Number(afterA.balance)).toBe(180);
    expect(Number(afterB.balance)).toBe(230);
  }, 20000);

  test("invalid payment does not change balance or create records", async () => {
    const cust = await createCustomer(h.app, h.adminToken, {
      name: "Pay Fail",
      opening_balance: 250,
    });
    const before = await h.db.get(
      `SELECT
         (SELECT balance FROM customers WHERE id = ?) AS balance,
         (SELECT COUNT(*) FROM vouchers) AS vouchers,
         (SELECT COUNT(*) FROM transactions) AS txs`,
      [cust.id]
    );

    const bad = await pay(h.app, h.adminToken, cust.id, 0);
    expect(bad.status).toBe(400);
    expect(bad.body.code || unwrap(bad).code).toBe("VALIDATION_ERROR");

    const missing = await pay(h.app, h.adminToken, 999999, 10);
    expect(missing.status).toBe(404);

    const after = await h.db.get(
      `SELECT
         (SELECT balance FROM customers WHERE id = ?) AS balance,
         (SELECT COUNT(*) FROM vouchers) AS vouchers,
         (SELECT COUNT(*) FROM transactions) AS txs`,
      [cust.id]
    );
    expect(Number(after.balance)).toBe(250);
    expect(Number(after.vouchers)).toBe(Number(before.vouchers));
    expect(Number(after.txs)).toBe(Number(before.txs));
  }, 20000);

  test("single payment still returns the new balance", async () => {
    const cust = await createCustomer(h.app, h.adminToken, {
      name: "Pay One",
      credit_limit: 100,
      opening_balance: 80,
    });
    const res = await pay(h.app, h.adminToken, cust.id, 15);
    expect(res.status).toBe(200);
    expect(Number(unwrap(res).new_balance)).toBe(65);

    const row = await h.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [cust.id]);
    expect(Number(row.balance)).toBe(65);
    expect(Number(row.credit_limit)).toBe(100);
  }, 20000);
});
