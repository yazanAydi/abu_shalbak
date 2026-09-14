/**
 * Loopback + Origin allow-list for the cashier-PC receipt print helper.
 * No wildcard CORS. Origins are scheme+host+port only (no path).
 */

export function parseReceiptPrintAllowedOrigins(env = process.env) {
  return String(env.RECEIPT_PRINT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => normalizeReceiptPrintOrigin(o))
    .filter(Boolean);
}

/** POS URL such as http://192.168.1.10:3000/pos → http://192.168.1.10:3000 */
export function originFromPosUrl(posUrl) {
  return normalizeReceiptPrintOrigin(posUrl);
}

export function normalizeReceiptPrintOrigin(origin) {
  const raw = String(origin || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password) return "";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export function isReceiptPrintOriginAllowed(origin, allowedOrigins) {
  const normalized = normalizeReceiptPrintOrigin(origin);
  if (!normalized) return false;
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return list.includes(normalized);
}

export function receiptPrintCorsHeaders(origin, allowedOrigins) {
  const normalized = normalizeReceiptPrintOrigin(origin);
  if (!isReceiptPrintOriginAllowed(normalized, allowedOrigins)) return {};
  return {
    "Access-Control-Allow-Origin": normalized,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

/**
 * Decide whether a helper request may proceed.
 * GET /health without Origin is for local PowerShell. POST /print requires Origin.
 */
export function decideReceiptPrintAccess({ method, path, origin, loopback }, allowedOrigins) {
  if (!loopback) {
    return { ok: false, status: 403, code: "FORBIDDEN", error: "local only" };
  }

  const hasOrigin = Boolean(normalizeReceiptPrintOrigin(origin));
  const originOk = isReceiptPrintOriginAllowed(origin, allowedOrigins);
  const cors = originOk;

  if (method === "OPTIONS") {
    if (!originOk) {
      return { ok: false, status: 403, code: "ORIGIN_DENIED", error: "origin not allowed" };
    }
    return { ok: true, status: 204, cors };
  }

  const isHealth = method === "GET" && (path === "/health" || path === "/");
  if (isHealth) {
    if (hasOrigin && !originOk) {
      return { ok: false, status: 403, code: "ORIGIN_DENIED", error: "origin not allowed" };
    }
    return { ok: true, status: 200, cors };
  }

  if (method === "POST" && path === "/print") {
    if (!originOk) {
      return { ok: false, status: 403, code: "ORIGIN_DENIED", error: "origin not allowed" };
    }
    return { ok: true, status: 200, cors };
  }

  if (method === "POST" && (path === "/arm" || path === "/disarm")) {
    return { ok: false, status: 410, code: "GONE", error: "arm/disarm لم يعد مستخدماً", cors };
  }

  return { ok: false, status: 404, code: "NOT_FOUND", error: "not found", cors };
}
