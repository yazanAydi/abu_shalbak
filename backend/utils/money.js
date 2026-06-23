/**
 * Canonical money rounding for the backend.
 *
 * All money values are stored as REAL (IEEE-754 double) and rounded to 2
 * decimals at every boundary. This is the single definition of that rounding
 * so every route/report rounds identically. Centralizing here lets us change
 * the strategy (e.g. move to integer minor units) in ONE place later.
 *
 * `round2(0.1 + 0.2)` → 0.3 (not 0.30000000000000004). Rounding per line and
 * again on totals keeps cumulative drift below half a fils for realistic carts.
 *
 * See docs/MONEY_PRECISION_REPORT.md for the full assessment and the planned
 * future migration path to integer minor units.
 */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Sum an array of money values, rounding the running total each step. */
export function sumMoney(values) {
  let total = 0;
  for (const v of values) total = round2(total + Number(v || 0));
  return total;
}
