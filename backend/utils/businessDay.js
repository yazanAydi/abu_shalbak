/**
 * Business day = calendar date the cashier shift started.
 * Falls back to row created_at when shift_id is missing (legacy rows).
 */

export const TX_BUSINESS_DAY_EXPR = "COALESCE(date(cs.start_time), date(t.created_at))";
export const REFUND_BUSINESS_DAY_EXPR = "COALESCE(date(cs.start_time), date(r.created_at))";

export const TX_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id";
export const REFUND_BUSINESS_DAY_JOIN = "LEFT JOIN cashier_shifts cs ON cs.id = r.shift_id";

export function txBusinessDayEquals(paramPlaceholder = "?") {
  return `${TX_BUSINESS_DAY_EXPR} = ${paramPlaceholder}`;
}

export function txBusinessDayBetween(fromPlaceholder = "?", toPlaceholder = "?") {
  return `${TX_BUSINESS_DAY_EXPR} >= ${fromPlaceholder} AND ${TX_BUSINESS_DAY_EXPR} <= ${toPlaceholder}`;
}

export function refundBusinessDayEquals(paramPlaceholder = "?") {
  return `${REFUND_BUSINESS_DAY_EXPR} = ${paramPlaceholder}`;
}

export function refundBusinessDayBetween(fromPlaceholder = "?", toPlaceholder = "?") {
  return `${REFUND_BUSINESS_DAY_EXPR} >= ${fromPlaceholder} AND ${REFUND_BUSINESS_DAY_EXPR} <= ${toPlaceholder}`;
}
