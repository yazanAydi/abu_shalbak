import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  checkoutBody,
  unwrap,
  diagnoseHttp,
  uniqueKey,
} from "./harness.js";

describe("C1/C2/C12 concurrent checkouts", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test.each([5, 10, 20, 30, 50])(
    "C1: %s simultaneous checkouts persist stock, unique receipts, and matching txs",
    async (N) => {
      await h.db.run("UPDATE products SET stock = ? WHERE id = ?", [1000, h.productId]);
      const baseline = await captureBaseline(h.db);
      const price = Number(h.product.price);

      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          checkout(
            h.app,
            h.cashierToken,
            checkoutBody({
              productId: h.productId,
              price,
              extra: { idempotency_key: uniqueKey(`c1-${N}-${i}`) },
            })
          )
        )
      );
      const elapsed = Date.now() - started;

      const failed = results.filter((r) => r.status !== 201);
      expect(failed.map((r) => diagnoseHttp("checkout", r))).toEqual([]);

      const receipts = results.map((r) => unwrap(r).receipt_number).filter(Boolean);
      expect(receipts).toHaveLength(N);
      expect(new Set(receipts).size).toBe(N);

      const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
      expect(Number(stock.stock)).toBe(1000 - N);

      await runAndCheckInvariants(h.db, baseline, {
        receiptsFromResponses: receipts,
        successfulCheckouts: N,
      });

      // eslint-disable-next-line no-console
      console.log(`[C1] ${N} checkouts in ${elapsed}ms (${(elapsed / N).toFixed(1)}ms/sale)`);
    },
    60000
  );

  test("C2: limited stock of 5 with 20 concurrent sales records exact oversell", async () => {
    await h.db.run("UPDATE products SET stock = 5 WHERE id = ?", [h.productId]);
    const baseline = await captureBaseline(h.db);
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        checkout(
          h.app,
          h.cashierToken,
          checkoutBody({
            productId: h.productId,
            price: Number(h.product.price),
            extra: { idempotency_key: uniqueKey(`c2-${i}`) },
          })
        )
      )
    );

    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(N);
    const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
    expect(Number(stock.stock)).toBe(5 - ok.length);
    expect(Number(stock.stock)).toBe(-15);

    const receipts = ok.map((r) => unwrap(r).receipt_number);
    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: receipts,
      successfulCheckouts: ok.length,
    });

    // eslint-disable-next-line no-console
    console.log(`[C2] oversold_units=${ok.length - 5} final_stock=${stock.stock}`);
  }, 30000);

  test("C12: same idempotency_key sent 10x concurrently creates one sale", async () => {
    const baseline = await captureBaseline(h.db);
    const key = uniqueKey("c12-dup");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkout(
          h.app,
          h.cashierToken,
          checkoutBody({
            productId: h.productId,
            price: Number(h.product.price),
            extra: { idempotency_key: key },
          })
        )
      )
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 201)).toBe(true);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);

    const txIds = results.map((r) => unwrap(r).transaction_id);
    expect(new Set(txIds).size).toBe(1);
    expect(results.some((r) => unwrap(r).idempotent_replay === true || r.status === 200)).toBe(true);

    const n = await h.db.get("SELECT COUNT(*) AS c FROM transactions WHERE idempotency_key = ?", [key]);
    expect(Number(n.c)).toBe(1);
    const pays = await h.db.get(
      "SELECT COUNT(*) AS c FROM sale_payments WHERE transaction_id = ?",
      [txIds[0]]
    );
    expect(Number(pays.c)).toBe(1);

    await runAndCheckInvariants(h.db, baseline, { successfulCheckouts: 1 });
  }, 20000);
});
