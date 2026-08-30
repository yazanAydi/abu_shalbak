import { AsyncLocalStorage } from "node:async_hooks";

export const queryAls = new AsyncLocalStorage();
export const readPreferenceAls = new AsyncLocalStorage();

/**
 * Run `fn` with a fresh per-request SQL counter.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithQueryStats(fn) {
  return queryAls.run({ count: 0 }, fn);
}

export function incrementQueryCount() {
  const store = queryAls.getStore();
  if (store) store.count += 1;
}

export function getQueryCount() {
  return queryAls.getStore()?.count ?? 0;
}

function shouldExposeQueryCount() {
  return process.env.NODE_ENV !== "production" || process.env.PERF_QUERY_COUNT === "1";
}

/**
 * Attach `X-Query-Count` on the response when instrumentation is enabled.
 */
export function queryCountMiddleware(req, res, next) {
  const enter = (cb) => {
    if (req.method === "GET" || req.method === "HEAD") {
      return readPreferenceAls.run({ readonly: true }, cb);
    }
    return cb();
  };
  return enter(() => {
  if (!shouldExposeQueryCount()) return next();
  runWithQueryStats(() => {
    const originalEnd = res.end.bind(res);
    res.end = function patchedEnd(...args) {
      if (!res.headersSent) {
        try {
          res.setHeader("X-Query-Count", String(getQueryCount()));
        } catch {
          /* headers already flushed */
        }
      }
      return originalEnd(...args);
    };
    next();
  });
  });
}

/**
 * @param {string} sql
 * @param {number} startedAtMs
 */
export function maybeLogSlowQuery(sql, startedAtMs) {
  const threshold = Number(process.env.PERF_LOG_SLOW_MS);
  if (!(threshold > 0)) return;
  const ms = Date.now() - startedAtMs;
  if (ms < threshold) return;
  const preview = String(sql || "").replace(/\s+/g, " ").trim().slice(0, 200);
  console.warn(`[slow-query] ${ms}ms ${preview}`);
}
