import { SHOP_TZ, shopTodayYmd } from "./shopTime.js";

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


function shopDateParts(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Parse a server timestamp into a Date. All server timestamps are UTC, but they
 * come in two shapes: SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS" (no zone
 * marker) and JS `toISOString()` → "...Z". JS parses the marker-less form as
 * *local* time, which shows UTC values verbatim (e.g. 14:30 instead of 17:30 on
 * a UTC+3 machine). SQLite emits UTC, so we append 'Z' to naive strings.
 * @param {string|null|undefined} s
 * @returns {Date|null}
 */
export function parseServerDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(str);
  const d = new Date(naive ? `${str.replace(" ", "T")}Z` : str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD HH:MM in Ramallah shop time */
export function dateTime(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  const p = shopDateParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD HH:MM:SS in Ramallah shop time */
export function dateTimeSeconds(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  const p = shopDateParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function dateOnly(s) {
  if (!s) return "—";
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = parseServerDate(str);
  if (!d) return str.slice(0, 10);
  const p = shopDateParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Arabic date + time in Ramallah shop timezone */
export function formatDateTimeShopAr(s) {
  let d = null;
  if (s instanceof Date) d = s;
  else if (typeof s === "number") d = new Date(s);
  else d = parseServerDate(s);
  if (!d || Number.isNaN(d.getTime())) return s ? String(s) : "—";
  return d.toLocaleString("ar-EG", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function todayISO() {
  return shopTodayYmd();
}
