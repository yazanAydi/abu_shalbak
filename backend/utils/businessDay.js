/**
 * Business day = calendar date the cashier shift started (Ramallah shop time).
 * Falls back to row created_at when shift_id is missing (legacy rows).
 */

import { shopYmdFromTimestamp, shopYmdToUtcBounds } from "./shopTime.js";

export const TX_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id";
export const REFUND_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = r.shift_id";

/** @deprecated Use shopBusinessDayYmd + JS filter instead of SQL date() */
export const TX_BUSINESS_DAY_EXPR = "COALESCE(date(cs.start_time), date(t.created_at))";
/** @deprecated Use shopBusinessDayYmd + JS filter instead of SQL date() */
export const REFUND_BUSINESS_DAY_EXPR = "COALESCE(date(cs.start_time), date(r.created_at))";

/** @deprecated Prefer shopBusinessDayYmd with JS filtering */
export function txBusinessDayEquals(paramPlaceholder = "?") {
  return `${TX_BUSINESS_DAY_EXPR} = ${paramPlaceholder}`;
}

/** @deprecated Prefer shopBusinessDayYmd with JS filtering */
export function txBusinessDayBetween(fromPlaceholder = "?", toPlaceholder = "?") {
  return `${TX_BUSINESS_DAY_EXPR} >= ${fromPlaceholder} AND ${TX_BUSINESS_DAY_EXPR} <= ${toPlaceholder}`;
}

/** @deprecated Prefer shopBusinessDayYmd with JS filtering */
export function refundBusinessDayEquals(paramPlaceholder = "?") {
  return `${REFUND_BUSINESS_DAY_EXPR} = ${paramPlaceholder}`;
}

/** @deprecated Prefer shopBusinessDayYmd with JS filtering */
export function refundBusinessDayBetween(fromPlaceholder = "?", toPlaceholder = "?") {
  return `${REFUND_BUSINESS_DAY_EXPR} >= ${fromPlaceholder} AND ${REFUND_BUSINESS_DAY_EXPR} <= ${toPlaceholder}`;
}

/**
 * Shop calendar date for a transaction or refund row.
 * @param {{ start_time?: string|null, created_at?: string|null }} row
 * @returns {string|null}
 */
export function shopBusinessDayYmd(row) {
  const ts = row.start_time ?? row.created_at;
  return shopYmdFromTimestamp(ts);
}

/**
 * @param {{ start_time?: string|null, created_at?: string|null }} row
 * @param {string} dateStr YYYY-MM-DD shop calendar date
 * @returns {boolean}
 */
export function txMatchesShopDate(row, dateStr) {
  return shopBusinessDayYmd(row) === dateStr;
}

export function shopDateUtcPrefilter(dateStr) {
  return shopYmdToUtcBounds(dateStr);
}

export function toSqlUtc(ts) {
  return String(ts).replace("T", " ").slice(0, 19);
}

/**
 * @param {object} db
 * @param {string} dateStr
 */
export async function fetchTransactionsForShopDate(db, dateStr) {
  const { startIso, endIso } = shopYmdToUtcBounds(dateStr);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.subtotal, t.tax, t.total, t.change_amount, t.payment_method, t.created_at,
            cs.start_time AS shift_start_time
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE (datetime(t.created_at) >= datetime(?)
       AND datetime(t.created_at) <= datetime(?))
        OR (cs.start_time IS NOT NULL
            AND datetime(cs.start_time) >= datetime(?)
            AND datetime(cs.start_time) <= datetime(?))`,
    [startSql, endSql, startSql, endSql]
  );
  return rows.filter((r) =>
    txMatchesShopDate({ start_time: r.shift_start_time, created_at: r.created_at }, dateStr)
  );
}

/**
 * @param {object} db
 * @param {string} dateStr
 */
export async function fetchRefundsForShopDate(db, dateStr) {
  const { startIso, endIso } = shopYmdToUtcBounds(dateStr);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  const rows = await db.all(
    `SELECT r.id, r.total, r.payment_method, r.created_at, cs.start_time AS shift_start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE (datetime(r.created_at) >= datetime(?)
       AND datetime(r.created_at) <= datetime(?))
        OR (cs.start_time IS NOT NULL
            AND datetime(cs.start_time) >= datetime(?)
            AND datetime(cs.start_time) <= datetime(?))`,
    [startSql, endSql, startSql, endSql]
  );
  return rows.filter((r) =>
    txMatchesShopDate({ start_time: r.shift_start_time, created_at: r.created_at }, dateStr)
  );
}
