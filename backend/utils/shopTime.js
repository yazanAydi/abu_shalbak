/**
 * Shop calendar helpers — Ramallah / Palestine local time (Asia/Hebron).
 * Stored timestamps remain UTC; calendar-day boundaries use this zone.
 */

import { parseTimestampMs } from "../services/cashierPayrollService.js";

export { parseTimestampMs };

/** @type {string} IANA zone for Ramallah (West Bank). */
export const SHOP_TZ = process.env.TZ || "Asia/Hebron";

export const SHOP_TZ_LABEL = "Ramallah";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHOP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Inclusive shop date → UTC bounds for SQL prefiltering.
 * @param {string} ymd
 * @returns {{ startIso: string, endIso: string }}
 */
export function shopYmdToUtcBounds(ymd) {
  const d = parseYmd(ymd);
  if (!d) throw new Error(`Invalid shop date: ${ymd}`);

  const [y, m, day] = d.split("-").map(Number);
  let lo = Date.UTC(y, m - 1, day - 1, 0, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, day + 1, 23, 59, 59, 999);

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midYmd = shopYmdFromDate(mid);
    if (midYmd < d) lo = mid + 1;
    else hi = mid;
  }
  const startMs = lo;

  lo = startMs;
  hi = startMs + 48 * 3_600_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const midYmd = shopYmdFromDate(mid);
    if (midYmd > d) hi = mid - 1;
    else lo = mid;
  }

  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(lo).toISOString(),
  };
}

/**
 * @param {Date|number} [date=new Date()]
 * @returns {string} YYYY-MM-DD in shop timezone
 */
export function shopYmdFromDate(date = new Date()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (Number.isNaN(ms)) return "";
  return ymdFormatter.format(new Date(ms));
}

/** @returns {string} Today's YYYY-MM-DD in Ramallah time */
export function shopTodayYmd() {
  return shopYmdFromDate(new Date());
}

/**
 * @param {string|null|undefined} ts
 * @returns {string|null}
 */
export function shopYmdFromTimestamp(ts) {
  const ms = parseTimestampMs(ts);
  if (Number.isNaN(ms)) return null;
  return shopYmdFromDate(ms);
}

/**
 * @param {string} ymd YYYY-MM-DD shop calendar date
 * @param {number} delta days to add (negative allowed)
 * @returns {string|null}
 */
export function addShopDays(ymd, delta) {
  const base = parseYmd(ymd);
  if (!base || !Number.isFinite(delta)) return null;
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta, 12, 0, 0));
  return shopYmdFromDate(dt);
}

function parseYmd(ymd) {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd.trim())) return null;
  return ymd.trim();
}

/**
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {{ startIso: string, endIso: string }}
 */
export function shopYmdRangeToUtcBounds(fromYmd, toYmd) {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) throw new Error("Invalid shop date range");
  const start = shopYmdToUtcBounds(from);
  const end = shopYmdToUtcBounds(to);
  return { startIso: start.startIso, endIso: end.endIso };
}

/**
 * @param {string|null|undefined} ts
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {boolean}
 */
export function shopYmdInRange(ts, fromYmd, toYmd) {
  const ymd = shopYmdFromTimestamp(ts);
  if (!ymd) return false;
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) return false;
  return ymd >= from && ymd <= to;
}

/** UTC bounds for a single shop calendar day (alias). */
export function shopDateUtcPrefilter(dateStr) {
  return shopYmdToUtcBounds(dateStr);
}

/**
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {string[]}
 */
export function shopDateRange(fromYmd, toYmd) {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to || from > to) return [];
  const dates = [];
  let d = from;
  while (d <= to) {
    dates.push(d);
    const next = addShopDays(d, 1);
    if (!next || next <= d) break;
    d = next;
  }
  return dates;
}
