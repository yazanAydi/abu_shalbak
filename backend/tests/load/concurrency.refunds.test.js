import request from "supertest";
import { authHeader } from "../helpers.js";
import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  checkoutBody,
  unwrap,
  uniqueKey,
  diagnoseHttp,
  envelopeCode,
} from "./harness.js";

describe("C8 refunds during concurrent activity", () => {
  let h;
  let saleId;

  beforeEach(async () => {
    h = await setupLoadContext({
      extraCashiers: 1,
      customer: { name: "Refund Cust", credit_limit: 0, opening_balance: 0, balance: 0 },
    });
    await h.db.run("UPDATE products SET stock = 400 WHERE id = ?", [h.productId]);
    const sale = await checkout(
      h.app,
      h.cashierToken,
      checkoutBody({
        productId: h.productId,
        quantity: 10,
        price: Number(h.product.price),
        extra: { idempotency_key: uniqueKey("c8-seed") },
      })
    );
    expect(sale.status).toBe(201);
    saleId = unwrap(sale).transaction_id;
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("C8: approve refund while others sell the same product; re-approve is NOT_PENDING", async () => {
    const createRes = await request(h.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(h.cashierToken))
      .send({
        original_transaction_id: saleId,
        lines: [{ product_id: h.productId, quantity: 2 }],
        payment_method: "cash",
        reason: "C8 concurrent refund",
      });
    expect(createRes.status).toBe(201);
    const requestId = unwrap(createRes).request_id;

    const baseline = await captureBaseline(h.db);
    const otherToken = h.cashiers[1].token;

    const [approveRes, ...sales] = await Promise.all([
      request(h.app)
        .put(`/api/v1/refund-requests/${requestId}`)
        .set(authHeader(h.adminToken))
        .send({ status: "approved" }),
      ...Array.from({ length: 8 }, (_, i) =>
        checkout(
          h.app,
          otherToken,
          checkoutBody({
            productId: h.productId,
            price: Number(h.product.price),
            extra: { idempotency_key: uniqueKey(`c8-sale-${i}`) },
          })
        )
      ),
    ]);

    expect(approveRes.status).toBe(200);
    expect(sales.filter((r) => r.status !== 201).map((r) => diagnoseHttp("sale", r))).toEqual([]);

    const replay = await request(h.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(h.adminToken))
      .send({ status: "approved" });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(["NOT_PENDING", "VALIDATION_ERROR"].includes(envelopeCode(replay)) || replay.status === 400).toBe(
      true
    );

    const reqRow = await h.db.get("SELECT status, refund_id FROM refund_requests WHERE id = ?", [
      requestId,
    ]);
    expect(reqRow.status).toBe("approved");

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: sales.map((r) => unwrap(r).receipt_number),
      successfulCheckouts: sales.length,
    });
  }, 30000);
});
