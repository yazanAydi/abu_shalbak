import { invalidatePromotionsCache } from "../../utils/promotions.js";
import { insertPromotion } from "./factories.js";
import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  checkoutBody,
  unwrap,
  uniqueKey,
  envelopeCode,
} from "./harness.js";

describe("C4 limited promotions", () => {
  let h;
  let promo;

  beforeEach(async () => {
    h = await setupLoadContext();
    await h.db.run("UPDATE products SET stock = 500 WHERE id = ?", [h.productId]);
    promo = await insertPromotion(h.db, {
      name: "Limited 10",
      offer_type: "percentage",
      product_id: h.productId,
      discount_value: 10,
      limit_qty: 10,
      used_qty: 0,
    });
    invalidatePromotionsCache();
  });

  afterEach(async () => {
    invalidatePromotionsCache();
    await teardownLoadContext(h);
  });

  test("C4: 30 concurrent promo checkouts never increment used_qty past limit_qty", async () => {
    const baseline = await captureBaseline(h.db);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        checkout(
          h.app,
          h.cashierToken,
          checkoutBody({
            productId: h.productId,
            price: Number(h.product.price),
            extra: { idempotency_key: uniqueKey(`c4-${i}`) },
          })
        )
      )
    );

    const ok = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 409 && envelopeCode(r) === "PROMO_LIMIT");
    const other = results.filter((r) => r.status !== 201 && !(r.status === 409 && envelopeCode(r) === "PROMO_LIMIT"));

    expect(other).toHaveLength(0);
    expect(ok.length + limited.length).toBe(30);

    // Checkout auto-selects from getActivePromotions(); it does not take a requested
    // promotion id. Once used_qty hits the limit the promo drops out of the active
    // list and later carts are ordinary full-price sales (201, discount 0).
    // PROMO_LIMIT is only for the race where selection still saw the promo.
    const applied = ok.filter((r) => Number(unwrap(r).discount) > 0);
    const fullPrice = ok.filter((r) => Number(unwrap(r).discount) === 0);

    const row = await h.db.get("SELECT used_qty, limit_qty FROM promotions WHERE id = ?", [promo.id]);
    expect(Number(row.used_qty)).toBeLessThanOrEqual(Number(row.limit_qty));
    expect(Number(row.used_qty)).toBe(applied.length);
    expect(applied.length).toBeLessThanOrEqual(10);
    expect(applied.length + limited.length + fullPrice.length).toBe(30);

    const receipts = ok.map((r) => unwrap(r).receipt_number);
    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: receipts,
      successfulCheckouts: ok.length,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[C4] accepted=${ok.length} applied=${applied.length} full_price=${fullPrice.length} promo_limit=${limited.length} used_qty=${row.used_qty}`
    );
  }, 30000);

  test("exhausted promotion is skipped and checkout continues as a normal sale", async () => {
    await h.db.run("UPDATE promotions SET used_qty = limit_qty WHERE id = ?", [promo.id]);
    invalidatePromotionsCache();

    const res = await checkout(
      h.app,
      h.cashierToken,
      checkoutBody({
        productId: h.productId,
        price: Number(h.product.price),
      })
    );
    expect(res.status).toBe(201);
    expect(Number(unwrap(res).discount)).toBe(0);

    const row = await h.db.get("SELECT used_qty, limit_qty FROM promotions WHERE id = ?", [promo.id]);
    expect(Number(row.used_qty)).toBe(Number(row.limit_qty));
  });
});
