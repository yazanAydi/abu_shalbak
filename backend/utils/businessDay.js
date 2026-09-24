/**
 * Business-day attribution (Asia/Hebron).
 *
 * New shifts store `cashier_shifts.business_day` at open:
 * local hour < cutoff → previous calendar date; otherwise the calendar date.
 * Every sale on that shift keeps that stored day, including after midnight
 * and after the next cutoff. Changing the setting does not rewrite it.
 *
 * A transaction or refund with no shift stores its own `business_day` from
 * its effective timestamp and the cutoff in force at insert time.
 *
 * Historical fallback, when no business day was stored: the Asia/Hebron
 * calendar date of the shift start, otherwise of created_at. The cutoff is
 * not applied. That is the interpretation from before this column existed,
 * so today's cutoff is not applied retroactively and open shifts from before
 * the migration keep the day they already had.
 *
 * Date-only fields (paid_on, occurred_on, invoice_date) are not timestamps
 * and are never passed through this cutoff.
 */

import {
  previousCalendarYmd,
  shopLocalParts,
  shopYmdFromTimestamp,
  shopYmdRangeToUtcBounds,
  shopYmdToUtcBounds,
} from "./shopTime.js";

export const TX_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id";
export const REFUND_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = r.shift_id";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeCutoffHour(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (typeof raw === "string" && !/^\d+$/.test(raw)) return null;
  const hour = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

/**
 * Business day for an instant under a cutoff. Hour is Asia/Hebron local time.
 * Before the cutoff the day is the previous calendar date; at the cutoff it
 * is the current calendar date.
 * @param {string|number|Date|null|undefined} ts
 * @param {number|string} cutoffHour
 * @returns {string|null}
 */
export function businessDayFromTimestamp(ts, cutoffHour) {
  const cutoff = normalizeCutoffHour(cutoffHour);
  if (cutoff == null) return null;
  const parts = shopLocalParts(ts);
  if (!parts?.ymd) return null;
  if (parts.hour < cutoff) return previousCalendarYmd(parts.ymd);
  return parts.ymd;
}

function ymdOrNull(value) {
  if (typeof value !== "string" || !YMD_RE.test(value.trim())) return null;
  return value.trim();
}

/**
 * Assigned business day for a shift, sale, or refund row.
 * Stored shift day wins. A shiftless row uses its own stored day.
 * Otherwise the historical calendar-date fallback applies (no cutoff).
 *
 * Pass `created_at` only for a sale or refund. A shift row should pass
 * `business_day` and `start_time` without `created_at`, so a stored
 * assignment is not discarded.
 * @param {object|null|undefined} row
 * @returns {string|null}
 */
export function shopBusinessDayYmd(row) {
  if (!row || typeof row !== "object") return null;
  const shiftDay = ymdOrNull(row.shift_business_day);
  if (shiftDay) return shiftDay;
  const shiftTs = row.start_time ?? row.shift_start_time ?? null;
  if (shiftTs && row.created_at != null) return shopYmdFromTimestamp(shiftTs);
  const ownDay = ymdOrNull(row.business_day);
  if (ownDay) return ownDay;
  if (shiftTs) return shopYmdFromTimestamp(shiftTs);
  return shopYmdFromTimestamp(row.created_at);
}

/**
 * SQL predicate: the row's assigned business day is inside [from, to].
 * Placeholders: from, to, from, to, startSql, endSql, startSql, endSql.
 * @param {string} rowAlias transactions `t` or refunds `r`
 * @param {string} shiftAlias
 */
export function businessDayRangeClause(rowAlias, shiftAlias) {
  return `(
    (${shiftAlias}.id IS NOT NULL AND ${shiftAlias}.business_day IS NOT NULL
      AND ${shiftAlias}.business_day >= ? AND ${shiftAlias}.business_day <= ?)
    OR (${shiftAlias}.id IS NULL AND ${rowAlias}.business_day IS NOT NULL
      AND ${rowAlias}.business_day >= ? AND ${rowAlias}.business_day <= ?)
    OR (${shiftAlias}.id IS NOT NULL AND ${shiftAlias}.business_day IS NULL
      AND datetime(${shiftAlias}.start_time) >= datetime(?)
      AND datetime(${shiftAlias}.start_time) <= datetime(?))
    OR (${shiftAlias}.id IS NULL AND ${rowAlias}.business_day IS NULL
      AND datetime(${rowAlias}.created_at) >= datetime(?)
      AND datetime(${rowAlias}.created_at) <= datetime(?))
  )`;
}

export function businessDayRangeParams(fromYmd, toYmd) {
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fromYmd, toYmd);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  return [fromYmd, toYmd, fromYmd, toYmd, startSql, endSql, startSql, endSql];
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
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.subtotal, t.tax, t.total, t.discount, t.amount_before_rounding, t.rounding_adjustment, t.change_amount, t.payment_method, t.created_at,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time,
            CASE WHEN EXISTS (
              SELECT 1 FROM sales_invoices si
               WHERE si.transaction_id = t.id AND si.status = 'posted'
            ) THEN 1 ELSE 0 END AS office_invoice
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND ${businessDayRangeClause("t", "cs")}`,
    businessDayRangeParams(dateStr, dateStr)
  );
  return rows.filter((r) => txMatchesShopDate(r, dateStr));
}

/**
 * @param {object} db
 * @param {string} dateStr
 */
export async function fetchRefundsForShopDate(db, dateStr) {
  const rows = await db.all(
    `SELECT r.id, r.total, r.payment_method, r.created_at,
            r.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE r.status = 'approved'
       AND ${businessDayRangeClause("r", "cs")}`,
    businessDayRangeParams(dateStr, dateStr)
  );
  return rows.filter((r) => txMatchesShopDate(r, dateStr));
}

/**
 * @param {object} db
 * @param {string} fromYmd
 * @param {string} toYmd
 */
export async function fetchTransactionsForShopDateRange(db, fromYmd, toYmd) {
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.subtotal, t.tax, t.total, t.discount, t.amount_before_rounding, t.rounding_adjustment, t.change_amount, t.payment_method, t.created_at,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time,
            CASE WHEN EXISTS (
              SELECT 1 FROM sales_invoices si
               WHERE si.transaction_id = t.id AND si.status = 'posted'
            ) THEN 1 ELSE 0 END AS office_invoice
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND ${businessDayRangeClause("t", "cs")}`,
    businessDayRangeParams(fromYmd, toYmd)
  );
  return rows.filter((r) => rowMatchesShopDateRange(r, fromYmd, toYmd));
}

/**
 * @param {object} db
 * @param {string} fromYmd
 * @param {string} toYmd
 */
export async function fetchRefundsForShopDateRange(db, fromYmd, toYmd) {
  const rows = await db.all(
    `SELECT r.id, r.total, r.payment_method, r.items_json, r.original_transaction_id,
            r.created_at, r.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE r.status = 'approved'
       AND ${businessDayRangeClause("r", "cs")}`,
    businessDayRangeParams(fromYmd, toYmd)
  );
  return rows.filter((r) => rowMatchesShopDateRange(r, fromYmd, toYmd));
}
