/**
 * Production /pos is served by Express + Helmet. Helmet's default CSP has
 * default-src 'self' and no connect-src, so fetch('http://127.0.0.1:17892/health')
 * is blocked. POS documents need an explicit connect-src; other pages stay as-is.
 */

/** Must match frontend-pos `RECEIPT_PRINT_HELPER_URL`. Loopback only — not a wildcard. */
export const POS_PRINT_HELPER_ORIGIN = "http://127.0.0.1:17892";

export function isPosPublicPath(pathname) {
  const p = String(pathname || "");
  return p === "/pos" || p.startsWith("/pos/");
}

function headerToString(header) {
  if (Array.isArray(header)) return header.filter(Boolean).join(";");
  return header == null ? "" : String(header);
}

export function parseCspDirectives(header) {
  const map = new Map();
  for (const part of headerToString(header).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const name = String(tokens.shift() || "").toLowerCase();
    if (!name) continue;
    const values = map.get(name) || [];
    values.push(...tokens);
    map.set(name, values);
  }
  return map;
}

export function serializeCspDirectives(map) {
  const parts = [];
  for (const [name, values] of map) {
    parts.push(values.length ? `${name} ${values.join(" ")}` : name);
  }
  return parts.join(";");
}

/** Add connect-src 'self' + helper origin. Does not drop other directives. */
export function withPosPrintHelperConnectSrc(header) {
  const map = parseCspDirectives(header);
  const connect = map.has("connect-src") ? [...map.get("connect-src")] : ["'self'"];
  if (!connect.includes("'self'")) connect.unshift("'self'");
  if (!connect.includes(POS_PRINT_HELPER_ORIGIN)) connect.push(POS_PRINT_HELPER_ORIGIN);
  map.set("connect-src", connect);
  return serializeCspDirectives(map);
}

function sourceAllowsUrl(src, documentOrigin, requestUrl) {
  if (!src || src === "'none'") return false;
  if (src === "*") return true;
  const req = new URL(requestUrl);
  if (src === "'self'") return req.origin === new URL(documentOrigin).origin;
  try {
    const allowed = new URL(src);
    if (req.protocol !== allowed.protocol || req.host !== allowed.host) return false;
    const allowedPath = allowed.pathname || "/";
    if (allowedPath === "/") return true;
    const prefix = allowedPath.endsWith("/") ? allowedPath : `${allowedPath}/`;
    return req.pathname === allowedPath || req.pathname.startsWith(prefix);
  } catch {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(src) && requestUrl.startsWith(src);
  }
}

/**
 * Browser connect-src (or default-src fallback). Used to assert /health, /print,
 * and same-origin /api without talking to a printer.
 */
export function cspAllowsConnect(header, documentUrl, requestUrl) {
  const map = parseCspDirectives(header);
  const sources = map.get("connect-src") || map.get("default-src") || [];
  return sources.some((src) => sourceAllowsUrl(src, documentUrl, requestUrl));
}

export function htmlHasCspMeta(html) {
  return /http-equiv\s*=\s*['"]Content-Security-Policy['"]/i.test(String(html || ""));
}

export function cspHeaderList(res) {
  const value = res.headers["content-security-policy"];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
