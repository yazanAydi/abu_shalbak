import jwt from "jsonwebtoken";
import { JWT_OPTIONS } from "../../middleware/auth.js";
import { pickWeighted, thinkMs, POS_OPS, OFFICE_OPS, ADMIN_OPS } from "./profiles.mjs";
import { nowMs } from "./metrics.mjs";
import { shopTodayYmd } from "../../utils/shopTime.js";
import { buildProductCsv, importedProductRows } from "../../tests/load/factories.js";

const LONG_OPS = new Set(["import_csv", "report_range", "account_statement", "backup", "expiry_alert"]);

export async function api(baseUrl, method, path, { token, body, timeoutMs = 30000 } = {}) {
  const t0 = nowMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body != null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: res.status,
      json,
      ms: nowMs() - t0,
      queryCount: Number(res.headers.get("x-query-count")) || 0,
      bytes: text.length,
      code: json?.code || json?.data?.code || null,
      timeout: false,
    };
  } catch (err) {
    const timeout = err?.name === "AbortError";
    return {
      status: 0,
      json: null,
      ms: nowMs() - t0,
      queryCount: 0,
      bytes: 0,
      code: timeout ? "TIMEOUT" : err.message,
      timeout,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function unwrap(json) {
  return json?.data ?? json;
}

/**
 * Sign a JWT the same way POST /auth/login does.
 * Fleet setup must not call the login endpoint 20–50 times: loginLimiter is
 * 10 / 15min / IP and is NOT skipped in development (only NODE_ENV=test).
 * Route auth is unchanged — every request still carries a valid Bearer token.
 */
export function issueToken(user) {
  // LOADTEST_BREAK_AUTH is harness-only: signs with a secret requireAuth will reject.
  const secret =
    process.env.LOADTEST_BREAK_AUTH === "1"
      ? "intentionally-wrong-secret-for-fail-closed-check"
      : process.env.JWT_SECRET || "loadtest-jwt-secret-not-for-production";
  return jwt.sign(
    { id: Number(user.id), username: user.username, role: user.role },
    secret,
    JWT_OPTIONS
  );
}

export async function loginVu(baseUrl, username, password, appPortal) {
  const res = await api(baseUrl, "POST", "/api/v1/auth/login", {
    body: { username, password, app: appPortal },
  });
  const token = unwrap(res.json)?.token;
  if (!token) {
    throw new Error(`login failed ${username} ${res.status} ${JSON.stringify(res.json)}`);
  }
  return token;
}

async function startShift(baseUrl, token) {
  return api(baseUrl, "POST", "/api/v1/shifts/start", { token, body: {} });
}

function uniqueKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export async function runVu(ctx) {
  const { baseUrl, role, token, catalog, rng, stopAt, measuring, record, thinkMultiplier } = ctx;
  const weights = role === "pos" ? POS_OPS : role === "office" ? OFFICE_OPS : ADMIN_OPS;
  let lastSaleId = null;

  while (Date.now() < stopAt) {
    const op = pickWeighted(rng, weights);
    const sample = await execOp({ baseUrl, token, role, op, catalog, rng, lastSaleId });
    if (sample.json?.transaction_id || unwrap(sample.json)?.transaction_id) {
      lastSaleId = unwrap(sample.json).transaction_id;
    }
    sample.role = role;
    sample.vu = ctx.vuId;
    sample.tStart = Date.now();
    if (measuring()) record(sample);
    const sleep = thinkMs(rng, role, thinkMultiplier);
    await new Promise((r) => setTimeout(r, sleep));
  }
}

async function execOp({ baseUrl, token, op, catalog, rng, lastSaleId }) {
  const product = catalog.products[Math.floor(rng() * catalog.products.length)] || catalog.products[0];
  const customer = catalog.customers[Math.floor(rng() * catalog.customers.length)];
  const livePrice = Number(product?.price) || 10;
  let res;
  switch (op) {
    case "pos_search":
      res = await api(baseUrl, "GET", `/api/v1/pos/search?q=${encodeURIComponent("صنف")}`, { token });
      break;
    case "pos_barcode":
      res = await api(baseUrl, "GET", `/api/v1/products/by-barcode/${product.barcode}`, { token });
      break;
    case "checkout_cash":
      res = await api(baseUrl, "POST", "/api/v1/checkout", {
        token,
        body: {
          items: [{ product_id: product.id, quantity: 1, price: livePrice }],
          payment_method: "cash",
          idempotency_key: uniqueKey("lt-cash"),
        },
      });
      break;
    case "checkout_split": {
      const cash = Math.round(livePrice * 0.4 * 100) / 100;
      const visa = Math.round((livePrice - cash) * 100) / 100;
      res = await api(baseUrl, "POST", "/api/v1/checkout", {
        token,
        body: {
          items: [{ product_id: product.id, quantity: 1, price: livePrice }],
          payment_method: "mixed",
          payments: [
            { method: "cash", amount: cash },
            { method: "visa", amount: visa },
          ],
          idempotency_key: uniqueKey("lt-split"),
        },
      });
      break;
    }
    case "checkout_credit":
      res = await api(baseUrl, "POST", "/api/v1/checkout", {
        token,
        body: {
          items: [{ product_id: product.id, quantity: 1, price: livePrice }],
          payment_method: "on_account",
          customer_id: customer?.id,
          idempotency_key: uniqueKey("lt-credit"),
        },
      });
      break;
    case "suspend":
      res = await api(baseUrl, "POST", "/api/v1/suspended-sales", {
        token,
        body: {
          note: "load",
          items: [{ product_id: product.id, quantity: 1, price: livePrice }],
        },
      });
      break;
    case "refund_request":
      if (!lastSaleId) {
        res = await api(baseUrl, "GET", "/api/v1/shifts/current", { token });
        return { ...res, op: "shift_current", longRunning: false };
      }
      res = await api(baseUrl, "POST", "/api/v1/refund-requests", {
        token,
        body: {
          original_transaction_id: lastSaleId,
          lines: [{ product_id: product.id, quantity: 1 }],
          payment_method: "cash",
        },
      });
      break;
    case "shift_current":
      res = await api(baseUrl, "GET", "/api/v1/shifts/current", { token });
      break;
    case "product_search":
      res = await api(baseUrl, "GET", `/api/v1/products?q=${encodeURIComponent("صنف")}&limit=20`, { token });
      break;
    case "product_list":
      res = await api(baseUrl, "GET", "/api/v1/products?limit=50&offset=0", { token });
      break;
    case "product_put":
      res = await api(baseUrl, "PUT", `/api/v1/products/${product.id}`, {
        token,
        body: {
          barcode: product.barcode,
          name: product.name,
          price: livePrice,
          cost: Number(product.cost) || 2,
          stock: Number(product.stock) || 10,
          category: product.category || "LoadTest",
        },
      });
      break;
    case "change_price":
      res = await api(baseUrl, "POST", `/api/v1/products/${product.id}/change-price`, {
        token,
        body: { new_price: Math.round((livePrice + 0.1) * 100) / 100, reason: "loadtest" },
      });
      if (res.status < 400) product.price = livePrice + 0.1;
      break;
    case "inventory_adjust":
      res = await api(baseUrl, "POST", "/api/v1/inventory/adjustments", {
        token,
        body: { adjustment_type: "in", items: [{ product_id: product.id, quantity: 1 }], post: true },
      });
      break;
    case "customer_op":
      res = await api(baseUrl, "GET", "/api/v1/customers?q=زبون", { token });
      break;
    case "supplier_op":
      res = await api(baseUrl, "GET", "/api/v1/suppliers?q=مورد", { token });
      break;
    case "report_daily":
      res = await api(baseUrl, "GET", "/api/v1/reports/today", { token });
      break;
    case "report_stock":
      res = await api(baseUrl, "GET", "/api/v1/reports/low-stock", { token });
      break;
    case "report_range": {
      const today = shopTodayYmd();
      res = await api(baseUrl, "GET", `/api/v1/reports/range?from=${today}&to=${today}`, {
        token,
        timeoutMs: 60000,
      });
      break;
    }
    case "settings":
      res = await api(baseUrl, "GET", "/api/v1/settings", { token });
      break;
    case "admin_users":
      res = await api(baseUrl, "GET", "/api/v1/admin/users", { token });
      break;
    case "account_statement":
      res = await api(
        baseUrl,
        "GET",
        `/api/v1/reports/account-statement?party_type=customer&party_id=${customer?.id || 1}`,
        { token, timeoutMs: 60000 }
      );
      break;
    default:
      res = await api(baseUrl, "GET", "/api/v1/health");
      op = "health";
  }
  return { ...res, op, longRunning: LONG_OPS.has(op) };
}

export async function holdSse(baseUrl, token, stopAt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, stopAt - Date.now()));
  try {
    await fetch(`${baseUrl}/api/v1/pos/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
  } catch {
    /* closed */
  } finally {
    clearTimeout(timer);
  }
}

export async function runBackgroundJobs({ baseUrl, token, catalog, schedule, record, measuring }) {
  const jobs = [];
  for (const job of schedule) {
    jobs.push(
      (async () => {
        await new Promise((r) => setTimeout(r, job.atMs));
        const t0 = nowMs();
        let res;
        if (job.op === "import_csv") {
          const csv = buildProductCsv(importedProductRows(job.rows, job.start || 930000));
          const fd = new FormData();
          fd.append("file", new Blob([csv], { type: "text/csv" }), job.filename || "load.csv");
          res = await api(baseUrl, "POST", "/api/v1/admin/products/upload", {
            token,
            body: fd,
            timeoutMs: 120000,
          });
        } else if (job.op === "backup") {
          res = await api(baseUrl, "POST", "/api/v1/admin/backup", { token, timeoutMs: 120000 });
        } else {
          res = { status: 0, ms: nowMs() - t0, code: "skipped", queryCount: 0, bytes: 0 };
        }
        const sample = { ...res, op: job.op, role: "background", vu: "bg", longRunning: true, tStart: Date.now() };
        sample.ms = res.ms ?? nowMs() - t0;
        if (measuring()) record(sample);
      })()
    );
  }
  await Promise.all(jobs);
}

export { startShift };
