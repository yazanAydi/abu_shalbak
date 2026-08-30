/**
 * HTTP benchmark against a seeded perf database.
 *
 * Usage:
 *   node scripts/bench.mjs
 *   node scripts/bench.mjs --db backend/data/perf.db --label baseline --out docs/perf/baseline.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { createApp } from "../app.js";
import { getQueryCount, runWithQueryStats } from "../utils/queryStats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const dbPath = path.resolve(arg("db", process.env.PERF_DB_PATH || path.join(__dirname, "..", "data", "perf.db")));
const label = String(arg("label", "run"));
const outPath = path.resolve(arg("out", path.join(__dirname, "..", "..", "docs", "perf", `${label}.json`)));
const iterations = Math.max(3, Number(arg("iters", 7)));
const warmup = Math.max(1, Number(arg("warmup", 2)));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const queries = samples.map((s) => s.queries);
  const avgQ = queries.reduce((a, b) => a + b, 0) / (queries.length || 1);
  return {
    n: samples.length,
    p50: Number(percentile(times, 50).toFixed(1)),
    p95: Number(percentile(times, 95).toFixed(1)),
    p99: Number(percentile(times, 99).toFixed(1)),
    min: Number((times[0] ?? 0).toFixed(1)),
    max: Number((times[times.length - 1] ?? 0).toFixed(1)),
    queries_avg: Number(avgQ.toFixed(1)),
    queries_max: Math.max(0, ...queries),
  };
}

async function timed(fn) {
  return runWithQueryStats(async () => {
    const t0 = process.hrtime.bigint();
    const res = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const headerCount = Number(res.headers?.["x-query-count"]);
    return {
      ms,
      queries: Number.isFinite(headerCount) ? headerCount : getQueryCount(),
      status: res.status,
      bytes: JSON.stringify(res.body ?? "").length,
    };
  });
}

async function login(app, username, password, appPortal) {
  const res = await request(app).post("/api/v1/auth/login").send({ username, password, app: appPortal });
  const token = res.body?.data?.token || res.body?.token;
  if (!token) {
    throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

async function runScenario(name, fn) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = await fn();
    samples.push(sample);
  }
  const stats = summarize(samples);
  console.log(
    `${name.padEnd(28)} p50=${String(stats.p50).padStart(7)}  p95=${String(stats.p95).padStart(7)}  p99=${String(stats.p99).padStart(7)}  q=${stats.queries_avg}`
  );
  return { name, ...stats, last_status: samples.at(-1)?.status, last_bytes: samples.at(-1)?.bytes };
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[bench] missing ${dbPath} — run: node scripts/seed-perf-db.mjs`);
    process.exit(1);
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "development";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "perf-bench-secret-not-for-production";
  process.env.DISABLE_AUTO_BACKUP = "1";

  const db = await initDatabase(dbPath);
  const app = createApp(db, dbPath);
  const adminToken = await login(app, "admin", "admin123", "office");
  const auth = { Authorization: `Bearer ${adminToken}` };
  // Admin can run POS routes but cannot log in through the cashier portal.
  const posAuth = auth;

  const first = await db.get("SELECT id, barcode, name, price, stock, sku FROM products ORDER BY id ASC LIMIT 1");
  const mid = await db.get(
    "SELECT id, barcode, name, price, stock FROM products WHERE id = (SELECT MIN(id)+CAST((MAX(id)-MIN(id))/2 AS INTEGER) FROM products)"
  );
  const product = first;
  if (!product) throw new Error("perf.db has no products");

  const shiftRes = await request(app).post("/api/v1/shifts/start").set(posAuth).send({ opening_cash: 200 });
  if (![200, 201].includes(shiftRes.status) && shiftRes.status !== 409) {
    console.warn(`[bench] shift start ${shiftRes.status}`, shiftRes.body);
  }

  const csv = Array.from({ length: 200 }, (_, i) => {
    const n = 900000 + i;
    return `${n},Import Bench ${i},5,2,مستورد`;
  }).join("\n");
  const csvBody = `barcode,name,price,cost,category\n${csv}`;

  const scenarios = [];

  scenarios.push(
    await runScenario("product_list_page1", () =>
      timed(() => request(app).get("/api/v1/products").query({ scope: "retail", limit: 200, offset: 0 }).set(auth))
    )
  );
  scenarios.push(
    await runScenario("product_search_name", () =>
      timed(() => request(app).get("/api/v1/products").query({ search: "أداء", limit: 50, scope: "retail" }).set(auth))
    )
  );
  scenarios.push(
    await runScenario("product_search_barcode", () =>
      timed(() =>
        request(app).get("/api/v1/products").query({ search: product.barcode, limit: 20, scope: "retail" }).set(auth)
      )
    )
  );
  scenarios.push(
    await runScenario("next_sku", () => timed(() => request(app).get("/api/v1/products/next-sku").set(auth)))
  );
  scenarios.push(
    await runScenario("product_create", async () => {
      const n = Date.now() % 1e9;
      return timed(() =>
        request(app)
          .post("/api/v1/products")
          .set(auth)
          .send({
            barcode: `9${String(n).padStart(12, "0")}`,
            name: `Bench create ${n}`,
            price: 3.5,
            cost: 2,
            stock: 10,
            category: "تصنيف 001",
            unit: "حبة",
          })
      );
    })
  );
  scenarios.push(
    await runScenario("product_update", () =>
      timed(() =>
        request(app)
          .put(`/api/v1/products/${product.id}`)
          .set(auth)
          .send({
            barcode: product.barcode,
            name: product.name,
            price: Number(product.price),
            cost: 2,
            stock: Number(product.stock),
            category: "تصنيف 001",
          })
      )
    )
  );
  scenarios.push(
    await runScenario("pos_barcode_lookup", () =>
      timed(() => request(app).get(`/api/v1/products/by-barcode/${product.barcode}`).set(posAuth))
    )
  );
  scenarios.push(
    await runScenario("pos_search", () =>
      timed(() => request(app).get("/api/v1/pos/search").query({ q: "أداء" }).set(posAuth))
    )
  );
  scenarios.push(
    await runScenario("checkout_3_items", () =>
      timed(() =>
        request(app)
          .post("/api/v1/checkout")
          .set(posAuth)
          .send({
            items: [
              { product_id: product.id, quantity: 1, price: Number(product.price) },
              { product_id: mid?.id || product.id, quantity: 1, price: Number(mid?.price || product.price) },
              { product_id: product.id, quantity: 2, price: Number(product.price) },
            ],
            payment_method: "cash",
            idempotency_key: `bench-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          })
      )
    )
  );
  scenarios.push(
    await runScenario("daily_report", () =>
      timed(() => request(app).get("/api/v1/reports/daily").set(auth))
    )
  );
  scenarios.push(
    await runScenario("import_200_rows", () =>
      timed(() =>
        request(app)
          .post("/api/v1/admin/products/upload")
          .set(auth)
          .attach("file", Buffer.from(csvBody, "utf8"), "bench.csv")
      )
    )
  );

  const report = {
    label,
    generated_at: new Date().toISOString(),
    db: dbPath,
    iterations,
    warmup,
    scenarios,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[bench] wrote ${outPath}`);

  await new Promise((resolve) => {
    try {
      db.raw.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

main().catch((err) => {
  console.error("[bench] failed:", err);
  process.exit(1);
});
