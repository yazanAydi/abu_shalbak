import request from "supertest";
import { authHeader } from "../helpers.js";
import { mulberry32, insertCustomer, insertSupplier } from "./factories.js";
import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  checkoutBody,
  unwrap,
  uniqueKey,
} from "./harness.js";

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

async function runPosVu(h, token, product, rng, ops) {
  const samples = [];
  for (let i = 0; i < ops; i += 1) {
    const roll = rng();
    const t0 = Date.now();
    let res;
    let op;
    if (roll < 0.3) {
      op = "pos_search";
      res = await request(h.app).get("/api/v1/pos/search").query({ q: "Test" }).set(authHeader(token));
    } else if (roll < 0.55) {
      op = "barcode";
      res = await request(h.app)
        .get(`/api/v1/products/by-barcode/${product.barcode}`)
        .set(authHeader(token));
    } else if (roll < 0.8) {
      op = "checkout_cash";
      const live = await h.db.get("SELECT price FROM products WHERE id = ?", [product.id]);
      res = await checkout(
        h.app,
        token,
        checkoutBody({
          productId: product.id,
          price: Number(live.price),
          extra: { idempotency_key: uniqueKey("mix-pos") },
        })
      );
    } else if (roll < 0.9) {
      op = "shift_current";
      res = await request(h.app).get("/api/v1/shifts/current").set(authHeader(token));
    } else {
      op = "suspend";
      const live = await h.db.get("SELECT price FROM products WHERE id = ?", [product.id]);
      res = await request(h.app)
        .post("/api/v1/suspended-sales")
        .set(authHeader(token))
        .send({
          note: "mix",
          items: [{ product_id: product.id, quantity: 1, price: Number(live.price) }],
        });
    }
    samples.push({ op, status: res.status, ms: Date.now() - t0, code: res.body?.code });
  }
  return samples;
}

async function runOfficeVu(h, token, product, rng, ops) {
  const samples = [];
  for (let i = 0; i < ops; i += 1) {
    const roll = rng();
    const t0 = Date.now();
    let res;
    let op;
    if (roll < 0.3) {
      op = "product_search";
      res = await request(h.app)
        .get("/api/v1/products")
        .query({ q: "Test", limit: 20 })
        .set(authHeader(token));
    } else if (roll < 0.45) {
      op = "product_list";
      res = await request(h.app)
        .get("/api/v1/products")
        .query({ limit: 50, offset: 0 })
        .set(authHeader(token));
    } else if (roll < 0.6) {
      op = "product_put";
      const row = await h.db.get("SELECT * FROM products WHERE id = ?", [product.id]);
      res = await request(h.app)
        .put(`/api/v1/products/${product.id}`)
        .set(authHeader(token))
        .send({
          barcode: row.barcode,
          name: row.name,
          price: Number(row.price),
          cost: Number(row.cost) || 5,
          stock: Number(row.stock),
          category: row.category || "Test",
        });
    } else if (roll < 0.7) {
      op = "adjust";
      res = await request(h.app)
        .post("/api/v1/inventory/adjustments")
        .set(authHeader(token))
        .send({
          adjustment_type: "in",
          items: [{ product_id: product.id, quantity: 1 }],
          post: true,
        });
    } else if (roll < 0.85) {
      op = "customer";
      res = await request(h.app)
        .post("/api/v1/customers")
        .set(authHeader(token))
        .send({ name: `Mix Cust ${uniqueKey("c")}` });
    } else {
      op = "report_today";
      res = await request(h.app).get("/api/v1/reports/today").set(authHeader(token));
    }
    samples.push({ op, status: res.status, ms: Date.now() - t0, code: res.body?.code });
  }
  return samples;
}

async function runAdminVu(h, token, rng, ops) {
  const samples = [];
  for (let i = 0; i < ops; i += 1) {
    const roll = rng();
    const t0 = Date.now();
    let res;
    let op;
    if (roll < 0.4) {
      op = "users";
      res = await request(h.app).get("/api/v1/admin/users").set(authHeader(token));
    } else if (roll < 0.7) {
      op = "settings";
      res = await request(h.app).get("/api/v1/settings").set(authHeader(token));
    } else {
      op = "low_stock";
      res = await request(h.app).get("/api/v1/reports/low-stock").set(authHeader(token));
    }
    samples.push({ op, status: res.status, ms: Date.now() - t0, code: res.body?.code });
  }
  return samples;
}

describe("mixed concurrent workloads", () => {
  afterEach(async () => {
    if (globalThis.__mixHarness) {
      await teardownLoadContext(globalThis.__mixHarness);
      globalThis.__mixHarness = null;
    }
  });

  test.each([
    { vus: 5, cashiers: 2, posOps: 4, officeOps: 3, adminOps: 3 },
    { vus: 10, cashiers: 5, posOps: 4, officeOps: 3, adminOps: 3 },
  ])("mixed profile at $vus virtual users", async ({ vus, cashiers, posOps, officeOps, adminOps }) => {
    const h = await setupLoadContext({ extraCashiers: cashiers, extraProducts: 4 });
    globalThis.__mixHarness = h;
    await insertCustomer(h.db, { name: "Mix base customer" });
    await insertSupplier(h.db, { name: "Mix base supplier" });
    await h.db.run("UPDATE products SET stock = 800");

    const baseline = await captureBaseline(h.db);
    const rng = mulberry32(vus * 1000 + 7);
    const product = h.product;

    const tasks = [];
    const posCount = Math.ceil(vus * 0.6);
    const officeCount = Math.max(1, Math.round(vus * 0.3));
    const adminCount = Math.max(1, vus - posCount - officeCount);

    for (let i = 0; i < posCount; i += 1) {
      const token = h.cashiers[i % h.cashiers.length].token;
      tasks.push(runPosVu(h, token, pick(rng, [product, ...h.products]), rng, posOps));
    }
    for (let i = 0; i < officeCount; i += 1) {
      tasks.push(runOfficeVu(h, h.adminToken, pick(rng, [product, ...h.products]), rng, officeOps));
    }
    for (let i = 0; i < adminCount; i += 1) {
      tasks.push(runAdminVu(h, h.adminToken, rng, adminOps));
    }

    const groups = await Promise.all(tasks);
    const samples = groups.flat();
    const serverErr = samples.filter((s) => s.status >= 500);
    expect(serverErr).toEqual([]);

    const rateLimited = samples.filter((s) => s.status === 429);
    const okish = samples.filter((s) => s.status < 400 || [409, 400].includes(s.status));
    expect(okish.length + rateLimited.length).toBe(samples.length);

    const successSales = samples.filter((s) => s.op === "checkout_cash" && s.status === 201).length;
    await runAndCheckInvariants(h.db, baseline, { successfulCheckouts: successSales });

    const byOp = {};
    for (const s of samples) {
      byOp[s.op] = byOp[s.op] || { n: 0, ms: [] };
      byOp[s.op].n += 1;
      byOp[s.op].ms.push(s.ms);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[mixed ${vus}vu] requests=${samples.length} 429=${rateLimited.length} ops=${JSON.stringify(
        Object.fromEntries(
          Object.entries(byOp).map(([k, v]) => [
            k,
            { n: v.n, p50: [...v.ms].sort((a, b) => a - b)[Math.floor(v.ms.length / 2)] },
          ])
        )
      )}`
    );
  }, 60000);
});
