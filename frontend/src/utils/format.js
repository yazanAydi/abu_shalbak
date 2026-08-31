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

export function isWeighedProduct(product) {
  return Number(product?.is_weighed) === 1;
}

/** Authoritative stock text: 3 decimals + كغم for weighed products. */
export function formatStockQty(stock, product) {
  return num(stock, isWeighedProduct(product) ? 3 : 0);
}

/**
 * Stock label with unit. Optional package equivalent is informational only.
 * @param {number} stock
 * @param {object | null | undefined} product
 * @param {Array<{ conversion_to_base?: number, unit_name?: string }> | null} [units]
 */
export function formatStockWithUnit(stock, product, units) {
  const weighed = isWeighedProduct(product);
  const qtyText = formatStockQty(stock, product);
  const unitName = weighed ? (product?.unit || "كغم") : "";
  const main = unitName ? `${qtyText} ${unitName}` : qtyText;
  if (!weighed || !Array.isArray(units)) return main;
  const pack = units.find((u) => Number(u.conversion_to_base) > 1);
  if (!pack) return main;
  const equiv = Number(stock) / Number(pack.conversion_to_base);
  if (!Number.isFinite(equiv)) return main;
  const equivText = equiv.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return `${main} ≈ ${equivText} ${pack.unit_name}`;
}


const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/;

/** YYYY-MM-DD → DD/MM/YY */
export function ymdToDmy(ymd) {
  const m = YMD_RE.exec(String(ymd || "").trim());
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
}

/**
 * Parse a typed date (DD/MM/YY, D/M/YY, DD/MM/YYYY, or YYYY-MM-DD) to YYYY-MM-DD.
 * Two-digit years map to 2000–2099. Invalid calendar dates return "".
 */
export function dmyToYmd(text) {
  const str = String(text || "").trim();
  const asYmd = YMD_RE.exec(str);
  if (asYmd) return `${asYmd[1]}-${asYmd[2]}-${asYmd[3]}`;
  const m = DMY_RE.exec(str);
  if (!m) return "";
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return "";
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function partsToDmy(p) {
  return `${p.day}/${p.month}/${String(p.year).slice(-2)}`;
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

/** DD/MM/YY HH:MM in Ramallah shop time */
export function dateTime(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  const p = shopDateParts(d);
  return `${partsToDmy(p)} ${p.hour}:${p.minute}`;
}

/** DD/MM/YY HH:MM:SS in Ramallah shop time */
export function dateTimeSeconds(s) {
  const d = parseServerDate(s);
  if (!d) return "—";
  const p = shopDateParts(d);
  return `${partsToDmy(p)} ${p.hour}:${p.minute}:${p.second}`;
}

/** DD/MM/YY in Ramallah shop time (ISO date-only strings stay on that calendar day) */
export function dateOnly(s) {
  if (!s) return "—";
  const str = String(s).trim();
  const fromYmd = ymdToDmy(str);
  if (fromYmd) return fromYmd;
  const d = parseServerDate(str);
  if (!d) return str.slice(0, 10);
  return partsToDmy(shopDateParts(d));
}

/** Date + time in Ramallah shop timezone as DD/MM/YY HH:MM */
export function formatDateTimeShopAr(s) {
  let d = null;
  if (s instanceof Date) d = s;
  else if (typeof s === "number") d = new Date(s);
  else d = parseServerDate(s);
  if (!d || Number.isNaN(d.getTime())) return s ? String(s) : "—";
  const p = shopDateParts(d);
  return `${partsToDmy(p)} ${p.hour}:${p.minute}`;
}

export function todayISO() {
  return shopTodayYmd();
}
