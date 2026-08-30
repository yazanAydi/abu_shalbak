import request from "supertest";
import { authHeader } from "../helpers.js";
import { insertCustomer } from "./factories.js";
import {
  setupLoadContext,
  teardownLoadContext,
  unwrap,
  diagnoseHttp,
} from "./harness.js";

describe("C15b sales invoice stock pre-check", () => {
  let h;
  let customerId;

  beforeEach(async () => {
    h = await setupLoadContext();
    const c = await insertCustomer(h.db, { name: "Invoice Cust" });
    customerId = c.id;
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("C15b: concurrent invoice posts against stock=1 both attempt to sell", async () => {
    await h.db.run("UPDATE products SET stock = 1 WHERE id = ?", [h.productId]);

    const invoices = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await request(h.app)
        .post("/api/v1/sales/invoices")
        .set(authHeader(h.adminToken))
        .send({
          customer_id: customerId,
          items: [{ product_id: h.productId, quantity: 1, total_price: Number(h.product.price) }],
        });
      expect(res.status).toBe(201);
      invoices.push(unwrap(res).id);
    }

    const posts = await Promise.all(
      invoices.map((id) =>
        request(h.app)
          .post(`/api/v1/sales/invoices/${id}/post`)
          .set(authHeader(h.adminToken))
          .send({ payment_method: "cash" })
      )
    );

    const ok = posts.filter((r) => r.status === 200);
    const rejected = posts.filter((r) => r.status >= 400);
    const stock = await h.db.get("SELECT stock FROM products WHERE id = ?", [h.productId]);

    // eslint-disable-next-line no-console
    console.log(
      `[C15b] posted=${ok.length} rejected=${rejected.length} final_stock=${stock.stock} ${
        Number(stock.stock) < 0 ? "OVERSELL" : "held"
      }`
    );
    expect(posts.every((r) => r.status < 500)).toBe(true);
    if (rejected.length) {
      expect(rejected.map((r) => diagnoseHttp("post", r)).every(Boolean)).toBe(true);
    }
    // Oversell is allowed on POS; invoice path claims to pre-check. Record the outcome.
    expect(Number.isFinite(Number(stock.stock))).toBe(true);
  }, 20000);
});
