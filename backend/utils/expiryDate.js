/**
 * Calendar expiry dates as YYYY-MM-DD strings.
 * Never persist via Date.parse / new Date(isoDate) — those shift across timezones.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

export const UNKNOWN_EXPIRY_LABEL = "غير محدد";
export const PREFERRED_AUTO = "auto";
export const PREFERRED_UNKNOWN = "__unknown__";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {unknown} value */
export function normalizeExpiryDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * Whole calendar days from `fromYmd` to `toYmd` (to - from).
 * Uses UTC date-only arithmetic so the string is not interpreted in local TZ.
 */
export function calendarDaysBetween(fromYmd, toYmd) {
  const a = normalizeExpiryDate(fromYmd);
  const b = normalizeExpiryDate(toYmd);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86400000);
}

/** Days from shop today until expiry (negative = expired). */
export function daysUntilExpiry(expiryYmd, todayYmd) {
  const expiry = normalizeExpiryDate(expiryYmd);
  if (!expiry) return null;
  return calendarDaysBetween(todayYmd, expiry);
}

/**
 * @param {unknown} value
 * @returns {'auto' | 'unknown' | string} auto, unknown, or YYYY-MM-DD
 */
export function parsePreferredExpiry(value) {
  if (value == null) return PREFERRED_AUTO;
  const s = String(value).trim();
  if (!s || s === PREFERRED_AUTO) return PREFERRED_AUTO;
  if (s === PREFERRED_UNKNOWN) return PREFERRED_UNKNOWN;
  const ymd = normalizeExpiryDate(s);
  return ymd || PREFERRED_AUTO;
}
