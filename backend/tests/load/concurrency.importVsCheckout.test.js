import request from "supertest";
import { authHeader } from "../helpers.js";
import { buildProductCsv, importedProductRows } from "./factories.js";
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
import { shopTodayYmd } from "../../utils/shopTime.js";

function attachCsv(req, csv, filename) {
  return req.attach("file", Buffer.from(csv, "utf8"), filename);
}

describe("C9/C10/C11 import, reports, concurrent imports", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
    await h.db.run("UPDATE products SET stock = 500 WHERE id = ?", [h.productId]);
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("C9: CSV import during checkouts does not lose stock deltas", async () => {
    const baseline = await captureBaseline(h.db);
    const csv = buildProductCsv(importedProductRows(200, 910000));
    const price = Number(h.product.price);

    const t0 = Date.now();
    const importStarted = Date.now();
    const importP = attachCsv(
      request(h.app).post("/api/v1/admin/products/upload").set(authHeader(h.adminToken)),
      csv,
      "c9.csv"
    );

    const saleTimes = [];
    const saleP = Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const start = Date.now();
        const res = await checkout(
          h.app,
          h.cashierToken,
          checkoutBody({
            productId: h.productId,
            price,
            extra: { idempotency_key: uniqueKey(`c9-${i}`) },
          })
        );
        saleTimes.push({ i, ms: Date.now() - start, duringImport: Date.now() < importStarted + 30_000 });
        return res;
      })
    );

    const [imp, sales] = await Promise.all([importP, saleP]);
    const elapsed = Date.now() - t0;

    expect(imp.status).toBe(200);
    expect(sales.filter((r) => r.status !== 201).map((r) => diagnoseHttp("sale", r))).toEqual([]);

    const created = Number(unwrap(imp).products_created || unwrap(imp).inserted || 0);
    expect(created).toBeGreaterThanOrEqual(190);

    const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);
    expect(Number(stock.stock)).toBe(500 - 12);

    const p95 = [...saleTimes].sort((a, b) => a.ms - b.ms)[Math.ceil(saleTimes.length * 0.95) - 1];
    // eslint-disable-next-line no-console
    console.log(
      `[C9] import+12 checkouts ${elapsed}ms checkout_max=${Math.max(...saleTimes.map((s) => s.ms))}ms checkout_p95=${p95.ms}ms imported=${created}`
    );

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: sales.map((r) => unwrap(r).receipt_number),
      successfulCheckouts: 12,
    });
  }, 60000);

  test("C10: reports during sales stay consistent with committed txs", async () => {
    const today = shopTodayYmd();
    const baseline = await captureBaseline(h.db);
    const price = Number(h.product.price);

    const salesP = Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        checkout(
          h.app,
          h.cashierToken,
          checkoutBody({
            productId: h.productId,
            price,
            extra: { idempotency_key: uniqueKey(`c10-${i}`) },
          })
        )
      )
    );
    const reportsP = Promise.all([
      request(h.app).get("/api/v1/reports/today").set(authHeader(h.adminToken)),
      request(h.app).get("/api/v1/reports/daily").query({ date: today }).set(authHeader(h.adminToken)),
      request(h.app)
        .get("/api/v1/reports/range")
        .query({ from: today, to: today })
        .set(authHeader(h.adminToken)),
    ]);

    const [sales, reports] = await Promise.all([salesP, reportsP]);
    expect(sales.filter((r) => r.status !== 201).map((r) => diagnoseHttp("sale", r))).toEqual([]);
    expect(reports.every((r) => r.status === 200)).toBe(true);
    expect(reports.every((r) => r.status < 500)).toBe(true);

    const txCount = await h.db.get("SELECT COUNT(*) AS n FROM transactions");
    const todayBody = unwrap(reports[0]);
    expect(Number(todayBody.transaction_count ?? todayBody.total_transactions ?? 0)).toBeLessThanOrEqual(
      Number(txCount.n)
    );

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: sales.map((r) => unwrap(r).receipt_number),
      successfulCheckouts: 10,
    });
  }, 30000);

  test("C11: three concurrent imports do not create duplicate barcodes", async () => {
    const baseline = await captureBaseline(h.db);
    const files = [0, 1, 2].map((n) =>
      buildProductCsv(importedProductRows(80, 920000 + n * 1000))
    );

    const t0 = Date.now();
    const imports = await Promise.all(
      files.map((csv, i) =>
        attachCsv(
          request(h.app).post("/api/v1/admin/products/upload").set(authHeader(h.adminToken)),
          csv,
          `c11-${i}.csv`
        )
      )
    );
    const elapsed = Date.now() - t0;
    expect(imports.every((r) => r.status === 200)).toBe(true);

    const dup = await h.db.get(`
      SELECT barcode, COUNT(*) AS n FROM products
      WHERE barcode IS NOT NULL GROUP BY barcode HAVING n > 1 LIMIT 1
    `);
    expect(dup).toBeFalsy();

    const created = imports.reduce(
      (s, r) => s + Number(unwrap(r).products_created || unwrap(r).inserted || 0),
      0
    );
    expect(created).toBeGreaterThanOrEqual(200);

    // eslint-disable-next-line no-console
    console.log(`[C11] 3 imports wall=${elapsed}ms created=${created}`);

    await runAndCheckInvariants(h.db, baseline, { successfulCheckouts: 0 });
  }, 60000);
});
