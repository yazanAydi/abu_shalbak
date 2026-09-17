/**
 * Business day = calendar date the cashier shift started (Ramallah shop time).
 * Falls back to row created_at when shift_id is missing (legacy rows).
 */

import { shopYmdFromTimestamp, shopYmdToUtcBounds, shopYmdRangeToUtcBounds } from "./shopTime.js";

export const TX_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id";
export const REFUND_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = r.shift_id";

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

export function rowMatchesShopDateRange(row, fromYmd, toYmd) {
  const ymd = shopBusinessDayYmd(row);
  if (!ymd) return false;
  return ymd >= fromYmd && ymd <= toYmd;
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
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND (
         (datetime(t.created_at) >= datetime(?)
          AND datetime(t.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
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
     WHERE r.status = 'approved'
       AND (
         (datetime(r.created_at) >= datetime(?)
          AND datetime(r.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
    [startSql, endSql, startSql, endSql]
  );
  return rows.filter((r) =>
    txMatchesShopDate({ start_time: r.shift_start_time, created_at: r.created_at }, dateStr)
  );
}

/**
 * @param {object} db
 * @param {string} fromYmd
 * @param {string} toYmd
 */
export async function fetchTransactionsForShopDateRange(db, fromYmd, toYmd) {
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fromYmd, toYmd);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.subtotal, t.tax, t.total, t.change_amount, t.payment_method, t.created_at,
            cs.start_time AS shift_start_time
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND (
         (datetime(t.created_at) >= datetime(?)
          AND datetime(t.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
    [startSql, endSql, startSql, endSql]
  );
  return rows.filter((r) =>
    rowMatchesShopDateRange({ start_time: r.shift_start_time, created_at: r.created_at }, fromYmd, toYmd)
  );
}

/**
 * @param {object} db
 * @param {string} fromYmd
 * @param {string} toYmd
 */
export async function fetchRefundsForShopDateRange(db, fromYmd, toYmd) {
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fromYmd, toYmd);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  const rows = await db.all(
    `SELECT r.id, r.total, r.payment_method, r.items_json, r.original_transaction_id,
            r.created_at, cs.start_time AS shift_start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE r.status = 'approved'
       AND (
         (datetime(r.created_at) >= datetime(?)
          AND datetime(r.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
    [startSql, endSql, startSql, endSql]
  );
  return rows.filter((r) =>
    rowMatchesShopDateRange({ start_time: r.shift_start_time, created_at: r.created_at }, fromYmd, toYmd)
  );
}
