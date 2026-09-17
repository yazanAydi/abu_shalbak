import bcrypt from "bcrypt";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { fingerprintCheckoutPayload } from "../utils/checkoutIdempotency.js";

describe("Checkout idempotency", () => {
  let ctx;
  let cashierToken;
  let cashier2Token;
  let adminToken;
  let customerId;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["testcashier2", hash]
    );
    cashier2Token = (await login(ctx.app, "testcashier2", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashier2Token))
      .send({ opening_cash: 100 });
    await ctx.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [ctx.productId]);
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('Idem Cust', 'IDM1', 0, 0, 100000)`
    );
    customerId = cust.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function sale(token, key, extra = {}) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(token))
      .send(
        withCheckoutKey(
          {
            items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
            payment_method: "cash",
            ...extra,
          },
          key
        )
      );
  }

  async function txCountForKey(key) {
    const row = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE idempotency_key = ?",
      [key]
    );
    return row.c;
  }

  test("fingerprint is stable for the same normalized payload", () => {
    const a = fingerprintCheckoutPayload({
      items: [{ product_id: 1, unit_id: 2, quantity: 1, price: 10 }],
      payment_method: "cash",
      customer_id: null,
    });
    const b = fingerprintCheckoutPayload({
      items: [{ product_id: "1", product_unit_id: 2, quantity: 1.0, price: 10.0 }],
      payment_method: "cash",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test("employee_id changes fingerprint only when set", () => {
    const base = {
      items: [{ product_id: 1, unit_id: 2, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: null,
    };
    expect(fingerprintCheckoutPayload(base)).toBe(
      fingerprintCheckoutPayload({ ...base, employee_id: null })
    );
    expect(fingerprintCheckoutPayload({ ...base, employee_id: 5 })).not.toBe(
      fingerprintCheckoutPayload(base)
    );
    expect(fingerprintCheckoutPayload({ ...base, employee_id: 5 })).not.toBe(
      fingerprintCheckoutPayload({ ...base, employee_id: 6 })
    );
  });

  test("on-account notes change fingerprint only when non-empty", () => {
    const base = {
      items: [{ product_id: 1, unit_id: 2, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: 3,
    };
    expect(fingerprintCheckoutPayload(base)).toBe(
      fingerprintCheckoutPayload({ ...base, notes: null })
    );
    expect(fingerprintCheckoutPayload({ ...base, notes: "سلّم بعد الظهر" })).not.toBe(
      fingerprintCheckoutPayload(base)
    );
  });

  test("requests without a key are rejected", async () => {
    const r = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VALIDATION_ERROR");
  });

  test("duplicate sequential requests create exactly one sale and replay the original", async () => {
    const key = "seq-key-0000000001";
    const first = await sale(cashierToken, key);
    expect(first.status).toBe(201);
    const firstTxId = first.body.data.transaction_id;

    const second = await sale(cashierToken, key);
    expect(second.status).toBe(200);
    expect(second.body.data.idempotent_replay).toBe(true);
    expect(second.body.data.transaction_id).toBe(firstTxId);

    expect(await txCountForKey(key)).toBe(1);
  });

  test("duplicate concurrent requests create exactly one sale", async () => {
    const key = "conc-key-000000002";
    const [a, b] = await Promise.all([sale(cashierToken, key), sale(cashierToken, key)]);

    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    expect(a.body.data.transaction_id).toBe(b.body.data.transaction_id);

    expect(await txCountForKey(key)).toBe(1);
  });

  test("two different keys create two distinct sales", async () => {
    const r1 = await sale(cashierToken, "diff-key-aaaaaaaa1");
    const r2 = await sale(cashierToken, "diff-key-bbbbbbbb2");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.transaction_id).not.toBe(r2.body.data.transaction_id);
  });

  test("same key different fingerprint is IDEMPOTENCY_KEY_REUSE", async () => {
    const key = "reuse-key-00000003";
    const first = await sale(cashierToken, key);
    expect(first.status).toBe(201);
    const second = await sale(cashierToken, key, {
      items: [{ product_id: ctx.productId, quantity: 2, price: 10 }],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(await txCountForKey(key)).toBe(1);
  });

  test("another cashier cannot replay or reuse the key", async () => {
    const key = "owner-key-00000004";
    const first = await sale(cashierToken, key);
    expect(first.status).toBe(201);
    const replay = await sale(cashier2Token, key);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe("IDEMPOTENCY_OWNER_MISMATCH");
    expect(await txCountForKey(key)).toBe(1);
  });

  test("legacy sale with null fingerprint still checks ownership", async () => {
    const key = "legacy-fp-00000005";
    const first = await sale(cashierToken, key);
    expect(first.status).toBe(201);
    await ctx.db.run("UPDATE transactions SET payload_fingerprint = NULL WHERE idempotency_key = ?", [
      key,
    ]);
    const other = await sale(cashier2Token, key);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("IDEMPOTENCY_OWNER_MISMATCH");
    const replay = await sale(cashierToken, key, {
      items: [{ product_id: ctx.productId, quantity: 3, price: 10 }],
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.transaction_id).toBe(first.body.data.transaction_id);
  });

  test("pending on-account replay is 202 and does not create a cash sale", async () => {
    const key = "oa-pend-key-000006";
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key,
    };
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(first.status).toBe(202);
    const requestId = first.body.data.request_id;

    const cashAttempt = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
        payment_method: "cash",
        idempotency_key: key,
      });
    expect(cashAttempt.status).toBe(409);
    expect(cashAttempt.body.code).toBe("IDEMPOTENCY_KEY_REUSE");

    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(replay.status).toBe(202);
    expect(replay.body.data.request_id).toBe(requestId);
    expect(replay.body.data.idempotent_replay).toBe(true);

    const oaCount = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM on_account_requests WHERE idempotency_key = ?",
      [key]
    );
    expect(oaCount.c).toBe(1);
    expect(await txCountForKey(key)).toBe(0);
  });

  test("approved on-account replays the completed sale", async () => {
    const key = "oa-appr-key-000007";
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key,
    };
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(first.status).toBe(202);
    const approve = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${first.body.data.request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);
    const txId =
      approve.body.data.request?.transaction_id ?? approve.body.data.checkout?.transaction_id;
    expect(txId).toBeTruthy();

    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(replay.status).toBe(200);
    expect(replay.body.data.transaction_id).toBe(txId);
    expect(await txCountForKey(key)).toBe(1);
  });

  test("concurrent pending on-account requests create one row", async () => {
    const key = "oa-conc-key-000009";
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key,
    };
    const [a, b] = await Promise.all([
      request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body),
      request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 202]);
    expect(a.body.data.request_id).toBe(b.body.data.request_id);
    const oaCount = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM on_account_requests WHERE idempotency_key = ?",
      [key]
    );
    expect(oaCount.c).toBe(1);
    expect(await txCountForKey(key)).toBe(0);
  });

  test("same-key retry during on-account approval yields one sale", async () => {
    const key = "oa-apr-race-000010";
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key,
    };
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(body);
    expect(first.status).toBe(202);
    const requestId = first.body.data.request_id;

    const [approve, retry] = await Promise.all([
      request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
      request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body),
    ]);

    expect([200, 202]).toContain(retry.status);
    expect(approve.status).toBe(200);
    expect(await txCountForKey(key)).toBe(1);
    const oa = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM on_account_requests WHERE idempotency_key = ?",
      [key]
    );
    expect(oa.c).toBe(1);
    const approved = await ctx.db.get(
      "SELECT status, transaction_id FROM on_account_requests WHERE id = ?",
      [requestId]
    );
    expect(approved.status).toBe("approved");
    expect(approved.transaction_id).toBeTruthy();
  });

  test("rejected on-account cannot be reused", async () => {
    const key = "oa-rej-key-0000008";
    const body = {
      items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key,
    };
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(first.status).toBe(202);
    const reject = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${first.body.data.request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(reject.status).toBe(200);

    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body));
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("IDEMPOTENCY_REQUEST_REJECTED");
    expect(await txCountForKey(key)).toBe(0);
  });
});
