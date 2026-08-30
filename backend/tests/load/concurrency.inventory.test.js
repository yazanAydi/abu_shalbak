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
} from "./harness.js";

describe("C7 inventory adjustment during checkout", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
    await h.db.run("UPDATE products SET stock = 200 WHERE id = ?", [h.productId]);
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("C7: posted adjustments and checkouts keep ledger chaining and stock cache", async () => {
    const baseline = await captureBaseline(h.db);
    const price = Number(h.product.price);

    const sales = Array.from({ length: 15 }, (_, i) =>
      checkout(
        h.app,
        h.cashierToken,
        checkoutBody({
          productId: h.productId,
          price,
          extra: { idempotency_key: uniqueKey(`c7-sale-${i}`) },
        })
      )
    );
    const adjustments = Array.from({ length: 8 }, (_, i) =>
      request(h.app)
        .post("/api/v1/inventory/adjustments")
        .set(authHeader(h.adminToken))
        .send({
          adjustment_type: i % 2 === 0 ? "in" : "out",
          items: [{ product_id: h.productId, quantity: 3 }],
          post: true,
        })
    );

    const results = await Promise.all([...sales, ...adjustments]);
    const saleRes = results.slice(0, 15);
    const adjRes = results.slice(15);

    expect(saleRes.filter((r) => r.status !== 201).map((r) => diagnoseHttp("sale", r))).toEqual([]);
    expect(adjRes.filter((r) => r.status !== 201).map((r) => diagnoseHttp("adj", r))).toEqual([]);

    const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
    const expected = 200 - 15 + 4 * 3 - 4 * 3;
    expect(Number(stock.stock)).toBe(expected);

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: saleRes.map((r) => unwrap(r).receipt_number),
      successfulCheckouts: 15,
    });
  }, 30000);
});
