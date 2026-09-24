import request from "supertest";
import { authHeader } from "../helpers.js";
import { insertCustomer } from "./factories.js";
import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  unwrap,
  diagnoseHttp,
  uniqueKey,
  envelopeCode,
} from "./harness.js";

/**
 * CODEBASE vs PLAN:
 * POS on-account checkout still queues an on_account_request (HTTP 202) without
 * applying credit or stock. Credit is enforced when a request is approved.
 */
describe("C3 concurrent customer credit", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext({
      customer: { name: "Credit Race", credit_limit: 1000, opening_balance: 900, balance: 900 },
    });
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  async function queueOnAccount({ customerId, quantity = 1, price, key }) {
    const res = await checkout(h.app, h.cashierToken, {
      items: [{ product_id: h.productId, quantity, price: price ?? Number(h.product.price) }],
      payment_method: "on_account",
      customer_id: customerId,
      idempotency_key: key || uniqueKey("oa"),
    });
    expect(res.status).toBe(202);
    return unwrap(res).request_id;
  }

  function approve(id) {
    return request(h.app)
      .put(`/api/v1/on-account-requests/${id}`)
      .set(authHeader(h.adminToken))
      .send({ status: "approved" });
  }

  function isCreditLimitRejection(res) {
    return res.status === 400 && envelopeCode(res) === "CREDIT_LIMIT_EXCEEDED";
  }

  test("C3a: 20 concurrent on-account checkouts queue approvals and do not change balance", async () => {
    const baseline = await captureBaseline(h.db);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        checkout(h.app, h.cashierToken, {
          items: [{ product_id: h.productId, quantity: 1, price: Number(h.product.price) }],
          payment_method: "on_account",
          customer_id: h.customer.id,
          idempotency_key: uniqueKey(`c3a-${i}`),
        })
      )
    );

    const unexpected = results.filter((r) => r.status !== 202);
    expect(unexpected.map((r) => diagnoseHttp("credit-checkout", r))).toEqual([]);

    const bal = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(bal.balance)).toBe(900);

    const pending = await h.db.get(
      "SELECT COUNT(*) AS n FROM on_account_requests WHERE customer_id = ? AND status = 'pending'",
      [h.customer.id]
    );
    expect(Number(pending.n)).toBe(20);

    const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
    expect(Number(stock.stock)).toBe(Number(h.product.stock));

    await runAndCheckInvariants(h.db, baseline, { successfulCheckouts: 0 });
  }, 30000);

  test(
    "C3b: approving many on-account requests does not exceed credit_limit",
    async () => {
      const created = [];
      for (let i = 0; i < 20; i += 1) {
        const res = await checkout(h.app, h.cashierToken, {
          items: [{ product_id: h.productId, quantity: 1, price: Number(h.product.price) }],
          payment_method: "on_account",
          customer_id: h.customer.id,
          idempotency_key: uniqueKey(`c3b-${i}`),
        });
        expect(res.status).toBe(202);
        created.push(unwrap(res).request_id);
      }

      const approvals = await Promise.all(
        created.map((id) =>
          request(h.app)
            .put(`/api/v1/on-account-requests/${id}`)
            .set(authHeader(h.adminToken))
            .send({ status: "approved" })
        )
      );
      const failed = approvals.filter((r) => r.status !== 200 && !isCreditLimitRejection(r));
      expect(failed.map((r) => diagnoseHttp("approve", r))).toEqual([]);

      const after = await h.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [
        h.customer.id,
      ]);
      // 900 + 20*10 = 1100 > 1000 if approvals skip the credit check.
      expect(Number(after.balance)).toBeLessThanOrEqual(Number(after.credit_limit));
    },
    60000
  );

  test("two concurrent approvals that together exceed the limit: one succeeds, one is rejected", async () => {
    const cust = await insertCustomer(h.db, {
      name: "Pair Race",
      credit_limit: 1000,
      opening_balance: 700,
      balance: 700,
    });
    const a = await queueOnAccount({ customerId: cust.id, quantity: 20, key: uniqueKey("pair-a") });
    const b = await queueOnAccount({ customerId: cust.id, quantity: 20, key: uniqueKey("pair-b") });

    const [ra, rb] = await Promise.all([approve(a), approve(b)]);
    const statuses = [ra.status, rb.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 400]);
    expect([ra, rb].filter(isCreditLimitRejection)).toHaveLength(1);

    const after = await h.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [cust.id]);
    expect(Number(after.balance)).toBe(900);
    expect(Number(after.balance)).toBeLessThanOrEqual(Number(after.credit_limit));

    const rows = await h.db.all(
      "SELECT id, status, transaction_id FROM on_account_requests WHERE id IN (?, ?)",
      [a, b]
    );
    const approved = rows.filter((r) => r.status === "approved");
    const pending = rows.filter((r) => r.status === "pending");
    expect(approved).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(approved[0].transaction_id).toBeTruthy();
    expect(pending[0].transaction_id).toBeNull();

    const txs = await h.db.all("SELECT id FROM transactions WHERE customer_id = ?", [cust.id]);
    expect(txs).toHaveLength(1);
    const payments = await h.db.all(
      `SELECT sp.id FROM sale_payments sp
       JOIN transactions t ON t.id = sp.transaction_id
       WHERE t.customer_id = ? AND sp.payment_method = 'on_account'`,
      [cust.id]
    );
    expect(payments).toHaveLength(1);
  }, 30000);

  test("approval that exactly consumes remaining credit succeeds; the next is rejected", async () => {
    const id = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 10,
      key: uniqueKey("exact"),
    });
    const ok = await approve(id);
    expect(ok.status).toBe(200);

    const afterExact = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(afterExact.balance)).toBe(1000);

    const overId = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 1,
      key: uniqueKey("over"),
    });
    const over = await approve(overId);
    expect(isCreditLimitRejection(over)).toBe(true);
    expect(over.body.error).toBe("البيع يتجاوز حد الائتمان. أكّد الاستثناء صراحة للموافقة فوق الحد.");

    const after = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(after.balance)).toBe(1000);
    const leftover = await h.db.get("SELECT status, transaction_id FROM on_account_requests WHERE id = ?", [
      overId,
    ]);
    expect(leftover.status).toBe("pending");
    expect(leftover.transaction_id).toBeNull();
    const txs = await h.db.all("SELECT id FROM transactions WHERE customer_id = ?", [h.customer.id]);
    expect(txs).toHaveLength(1);
  }, 30000);

  test("customer receipt payment reduces outstanding so a later approval can fit", async () => {
    const overId = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 15,
      key: uniqueKey("pay-over"),
    });
    const blocked = await approve(overId);
    expect(isCreditLimitRejection(blocked)).toBe(true);

    const created = await request(h.app)
      .post("/api/v1/vouchers")
      .set(authHeader(h.adminToken))
      .send({
        voucher_type: "receipt",
        lines: [{ line_type: "cash", amount: 50, customer_id: h.customer.id }],
      });
    expect(created.status).toBe(201);
    const voucherId = unwrap(created).id;
    const posted = await request(h.app)
      .post(`/api/v1/vouchers/${voucherId}/post`)
      .set(authHeader(h.adminToken));
    expect(posted.status).toBe(200);

    const afterPay = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(afterPay.balance)).toBe(850);

    const ok = await approve(overId);
    expect(ok.status).toBe(200);
    const after = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(after.balance)).toBe(1000);
  }, 30000);

  test("rejected credit-limit approval creates no sale, ledger, or payment rows", async () => {
    const baselineTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const baselinePay = await h.db.get("SELECT COUNT(*) AS n FROM sale_payments");
    const baselineLed = await h.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [h.productId]
    );
    const stockBefore = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);

    const id = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 20,
      key: uniqueKey("orphan"),
    });
    const res = await approve(id);
    expect(isCreditLimitRejection(res)).toBe(true);

    const afterTx = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const afterPay = await h.db.get("SELECT COUNT(*) AS n FROM sale_payments");
    const afterLed = await h.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [h.productId]
    );
    const stockAfter = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
    const req = await h.db.get("SELECT status, transaction_id FROM on_account_requests WHERE id = ?", [id]);
    const bal = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);

    expect(Number(afterTx.n)).toBe(Number(baselineTx.n));
    expect(Number(afterPay.n)).toBe(Number(baselinePay.n));
    expect(Number(afterLed.n)).toBe(Number(baselineLed.n));
    expect(Number(stockAfter.stock)).toBe(Number(stockBefore.stock));
    expect(req.status).toBe("pending");
    expect(req.transaction_id).toBeNull();
    expect(Number(bal.balance)).toBe(900);
  }, 30000);

  test("different customers can be approved concurrently without sharing a credit cap", async () => {
    const a = await insertCustomer(h.db, {
      name: "Cust A",
      credit_limit: 1000,
      opening_balance: 900,
      balance: 900,
    });
    const b = await insertCustomer(h.db, {
      name: "Cust B",
      credit_limit: 1000,
      opening_balance: 900,
      balance: 900,
    });
    const idsA = [
      await queueOnAccount({ customerId: a.id, quantity: 8, key: uniqueKey("ca1") }),
      await queueOnAccount({ customerId: a.id, quantity: 8, key: uniqueKey("ca2") }),
    ];
    const idsB = [
      await queueOnAccount({ customerId: b.id, quantity: 8, key: uniqueKey("cb1") }),
      await queueOnAccount({ customerId: b.id, quantity: 8, key: uniqueKey("cb2") }),
    ];

    const results = await Promise.all([...idsA, ...idsB].map((id) => approve(id)));
    const unexpected = results.filter((r) => r.status !== 200 && !isCreditLimitRejection(r));
    expect(unexpected.map((r) => diagnoseHttp("multi-cust", r))).toEqual([]);

    const afterA = await h.db.get("SELECT balance FROM customers WHERE id = ?", [a.id]);
    const afterB = await h.db.get("SELECT balance FROM customers WHERE id = ?", [b.id]);
    expect(Number(afterA.balance)).toBe(980);
    expect(Number(afterB.balance)).toBe(980);

    const approvedA = await h.db.get(
      "SELECT COUNT(*) AS n FROM on_account_requests WHERE customer_id = ? AND status = 'approved'",
      [a.id]
    );
    const approvedB = await h.db.get(
      "SELECT COUNT(*) AS n FROM on_account_requests WHERE customer_id = ? AND status = 'approved'",
      [b.id]
    );
    expect(Number(approvedA.n)).toBe(1);
    expect(Number(approvedB.n)).toBe(1);
  }, 30000);

  test("normal single approval still posts the sale and updates balance", async () => {
    const baseline = await captureBaseline(h.db);
    const id = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 1,
      key: uniqueKey("single"),
    });
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(unwrap(res).request.status).toBe("approved");
    expect(unwrap(res).request.transaction_id).toBeTruthy();

    const after = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(after.balance)).toBe(910);

    const tx = await h.db.get("SELECT * FROM transactions WHERE id = ?", [
      unwrap(res).request.transaction_id,
    ]);
    expect(tx).toBeTruthy();
    expect(Number(tx.customer_id)).toBe(h.customer.id);

    await runAndCheckInvariants(h.db, baseline, { successfulCheckouts: 1 });
  }, 30000);

  test("repeated approval of the same request does not duplicate the sale", async () => {
    const id = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 1,
      key: uniqueKey("replay"),
    });
    const first = await approve(id);
    expect(first.status).toBe(200);
    const txId = unwrap(first).request.transaction_id;

    const second = await approve(id);
    expect(second.status).toBe(400);
    expect(envelopeCode(second)).toBe("NOT_PENDING");

    const reqs = await h.db.all("SELECT id, status, transaction_id FROM on_account_requests WHERE id = ?", [
      id,
    ]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("approved");
    expect(reqs[0].transaction_id).toBe(txId);

    const txs = await h.db.all("SELECT id FROM transactions WHERE customer_id = ?", [h.customer.id]);
    expect(txs).toHaveLength(1);
    const bal = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(bal.balance)).toBe(910);
  }, 30000);

  test("concurrent re-approval of one request creates a single sale", async () => {
    const id = await queueOnAccount({
      customerId: h.customer.id,
      quantity: 1,
      key: uniqueKey("same-race"),
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => approve(id)));
    const ok = results.filter((r) => r.status === 200);
    const notPending = results.filter((r) => r.status === 400 && envelopeCode(r) === "NOT_PENDING");
    expect(ok).toHaveLength(1);
    expect(notPending).toHaveLength(7);
    expect(results.every((r) => r.status < 500)).toBe(true);

    const txs = await h.db.all("SELECT id FROM transactions WHERE customer_id = ?", [h.customer.id]);
    expect(txs).toHaveLength(1);
    const bal = await h.db.get("SELECT balance FROM customers WHERE id = ?", [h.customer.id]);
    expect(Number(bal.balance)).toBe(910);
  }, 30000);
});
