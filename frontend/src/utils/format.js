/** Shared display formatting helpers (currency, numbers, dates). */

export function ils(n) {
  const v = Number(n ?? 0);
  return `₪${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n, digits = 2) {
  return Number(n ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function qty(n) {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Parse a server timestamp into a Date. All server timestamps are UTC, but they
 * come in two shapes: SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS" (no zone
 * marker) and JS `toISOString()` → "...Z". JS parses the marker-less form as
 * *local* time, which shows UTC values verbatim (e.g. 14:30 instead of 17:30 on
 * a UTC+3 machine). We append 'Z' to naive strings so they're read as UTC, then
 * callers format in local time.
 * @param {string|null|undefined} s
 * @returns {Date|null}
 */
export function parseServerDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str);
  const d = new Date(naive ? `${str.replace(" ", "T")}Z` : str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD HH:MM in the viewer's local timezone */
export function dateTime(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM-DD HH:MM:SS in the viewer's local timezone */
export function dateTimeSeconds(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function dateOnly(s) {
  if (!s) return "—";
  const str = String(s).trim();
  // Pure date strings (e.g. report filters "2026-07-11") have no time component
  // and must not be timezone-shifted.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = parseServerDate(str);
  if (!d) return str.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
