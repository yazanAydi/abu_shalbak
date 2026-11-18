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
} from "./harness.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("stock counting alongside the cashier POS", () => {
  let h;

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  async function openCount() {
    const response = await request(h.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(h.adminToken))
      .send({ department: "retail" });
    expect(response.status).toBe(201);
    return unwrap(response).id;
  }

  function saveCount(id, products) {
    return request(h.app)
      .post(`/api/v1/inventory/counts/${id}/lines/bulk`)
      .set(authHeader(h.adminToken))
      .send({ department: "retail", products });
  }

  function postCount(id) {
    return request(h.app)
      .post(`/api/v1/inventory/counts/${id}/post`)
      .set(authHeader(h.adminToken))
      .send({ department: "retail" });
  }

  test("152-product save and posting allow event-loop work before their atomic commit", async () => {
    h = await setupLoadContext({ extraProducts: 151 });
    const sessionId = await openCount();
    const products = [h.product, ...h.products].map((product) => ({
      product_id: product.id,
      sources: [{ counted_qty: 50 }],
    }));
    const originalRun = h.db.run;

    async function observeResponsiveness(operation, workPattern) {
      let transactionOpen = false;
      let scheduled = false;
      let timerRanBeforeCommit = false;
      h.db.run = async (sql, params) => {
        const result = await originalRun.call(h.db, sql, params);
        if (/^\s*BEGIN\b/i.test(sql)) transactionOpen = true;
        if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) transactionOpen = false;
        if (!scheduled && workPattern.test(sql)) {
          scheduled = true;
          setImmediate(() => { timerRanBeforeCommit = transactionOpen; });
        }
        return result;
      };
      try {
        const response = await operation();
        expect(response.status).toBe(200);
        await new Promise((resolve) => setImmediate(resolve));
        expect(scheduled).toBe(true);
        expect(timerRanBeforeCommit).toBe(true);
      } finally {
        h.db.run = originalRun;
      }
    }

    const started = Date.now();
    await observeResponsiveness(
      () => saveCount(sessionId, products),
      /INSERT INTO stock_count_lines/i
    );
    await observeResponsiveness(
      () => postCount(sessionId),
      /INSERT INTO inventory_ledger/i
    );
    expect((await h.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [sessionId])).status)
      .toBe("posted");
    const ids = products.map((product) => product.product_id);
    const stocks = await h.db.all(
      `SELECT stock FROM products WHERE id IN (${ids.map(() => "?").join(",")})`, ids
    );
    expect(stocks).toHaveLength(152);
    expect(stocks.every((product) => product.stock === 50)).toBe(true);
    console.log(`[stock-count] 152-product atomic save + post: ${Date.now() - started}ms on ${h.db.driver}`);
  }, 30000);

  test("POS reads remain available and a concurrent checkout follows the count without losing stock", async () => {
    h = await setupLoadContext();
    const sessionId = await openCount();
    const saved = await saveCount(sessionId, [{
      product_id: h.productId,
      sources: [{ counted_qty: 10 }],
    }]);
    expect(saved.status).toBe(200);
    const baseline = await captureBaseline(h.db);
    const writerPaused = deferred();
    const resumeWriter = deferred();
    const originalRun = h.db.run;
    let held = false;
    let saleFinished = false;
    let salePromise;
    h.db.run = async (sql, params = []) => {
      const result = await originalRun.call(h.db, sql, params);
      if (!held && /INSERT INTO inventory_ledger/i.test(sql)
        && params[1] === "stock_count_correction") {
        held = true;
        writerPaused.resolve();
        await resumeWriter.promise;
      }
      return result;
    };

    const posting = postCount(sessionId).then((response) => response);
    try {
      await Promise.race([
        writerPaused.promise,
        posting.then(() => { throw new Error("count did not reach the expected stock write"); }),
      ]);
      const product = await request(h.app)
        .get(`/api/v1/products/by-barcode/${h.product.barcode}`)
        .set(authHeader(h.cashierToken));
      expect(product.status).toBe(200);
      if (h.db.driver === "better-sqlite3") {
        // Its separate read connection sees the previous committed picture.
        expect(Number(unwrap(product).stock)).toBe(100);
      }
      const pictures = await request(h.app)
        .post("/api/v1/inventory/stock-sources/batch")
        .set(authHeader(h.adminToken))
        .send({ product_ids: [h.productId] });
      expect(pictures.status).toBe(200);
      if (h.db.driver === "better-sqlite3") {
        expect(unwrap(pictures).pictures[h.productId].product_stock).toBe(100);
      }

      salePromise = checkout(h.app, h.cashierToken, checkoutBody({
        productId: h.productId,
        price: Number(h.product.price),
      })).then((response) => { saleFinished = true; return response; });
      const health = await request(h.app).get("/api/v1/health");
      expect(health.status).toBe(200);
      expect(saleFinished).toBe(false);
      expect((await h.db.get("SELECT COUNT(*) AS n FROM transactions")).n).toBe(0);
    } finally {
      resumeWriter.resolve();
      await posting;
      if (salePromise) await salePromise;
      h.db.run = originalRun;
    }

    expect((await posting).status).toBe(200);
    const sale = await salePromise;
    expect(sale.status).toBe(201);
    expect((await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId])).stock).toBe(9);
    expect((await postCount(sessionId)).status).toBe(400);
    await runAndCheckInvariants(h.db, baseline, {
      successfulCheckouts: 1,
      receiptsFromResponses: [unwrap(sale).receipt_number],
    });
  }, 30000);
});
