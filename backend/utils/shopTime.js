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

/**
 * Calendar day after `ymd` (UTC date arithmetic; input is a shop YYYY-MM-DD).
 * Used for half-open SQL ranges: `created_at >= from AND created_at < nextDay(to)`.
 */
export function nextCalendarYmd(ymd) {
  if (!YMD_RE.test(String(ymd || ""))) return null;
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHOP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHOP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
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
 * Asia/Hebron calendar parts for an instant. Hour is 0–23.
 * Calendar dates are not derived by subtracting a fixed number of hours.
 * @param {Date|number|string} instant
 * @returns {{ ymd: string, hour: number, minute: number } | null}
 */
export function shopLocalParts(instant) {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : parseTimestampMs(instant);
  if (!Number.isFinite(ms)) return null;
  const parts = localPartsFormatter.formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  let hour = Number(pick("hour"));
  const minute = Number(pick("minute"));
  if (!year || !month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour === 24) hour = 0;
  return { ymd: `${year}-${month}-${day}`, hour, minute };
}

/**
 * The calendar date before `ymd`. Uses the Y-M-D label itself, not UTC-offset
 * arithmetic and not a 24-hour step back from an instant.
 * @param {string} ymd
 * @returns {string|null}
 */
export function previousCalendarYmd(ymd) {
  if (!YMD_RE.test(String(ymd || ""))) return null;
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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

/**
 * Asia/Hebron wall time → UTC epoch ms. Ambiguous or skipped DST times
 * resolve to the first instant whose shop parts match, or the next valid instant.
 * @param {string} ymd
 * @param {number} hour
 * @param {number} minute
 * @param {number} [second]
 * @returns {number}
 */
export function shopLocalToUtcMs(ymd, hour, minute, second = 0) {
  const day = parseYmd(ymd);
  if (!day || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return NaN;
  }
  const [y, m, d] = day.split("-").map(Number);
  let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  const want = `${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const parts = shopLocalParts(mid);
    const key = parts
      ? `${parts.ymd} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
      : "";
    if (key < want) lo = mid + 1;
    else hi = mid;
  }
  const snapped = Math.floor(lo / 60000) * 60000 + second * 1000;
  const check = shopLocalParts(snapped);
  if (check && check.ymd === day && check.hour === hour && check.minute === minute) return snapped;
  return NaN;
}

/** @param {number} ms */
export function utcMsToSql(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
