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

/**
 * Retired whole-shekel half-up helper. New POS charges do not call this.
 * Historical weighed lines keep the line_gross already stored on the sale.
 */
export function roundScaleSaleTotal(amount) {
  const n = round2(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n + 0.5);
}

/**
 * Final POS amount due, once, after discounts and tax.
 * Integer agorot: remainder 0–49 drops, 50 stays, 51–99 goes to the next shekel.
 * This is not half-shekel rounding and not the weighed-line rule above.
 * Adjustment is payable − calculated (negative when the customer pays less).
 * @param {number} amount
 * @returns {{ calculated: number, payable: number, adjustment: number }}
 */
export function roundPosPayable(amount) {
  const calculated = round2(amount);
  if (!Number.isFinite(calculated)) {
    return { calculated: 0, payable: 0, adjustment: 0 };
  }
  const negative = calculated < 0;
  const agorot = Math.round(Math.abs(calculated) * 100);
  const remainder = agorot % 100;
  let payableAgorot = agorot;
  if (remainder > 0 && remainder < 50) payableAgorot = agorot - remainder;
  else if (remainder > 50) payableAgorot = agorot + (100 - remainder);
  const payable = round2((negative ? -1 : 1) * (payableAgorot / 100));
  return { calculated, payable, adjustment: round2(payable - calculated) };
}

/**
 * Refund share of a sale's stored rounding adjustment.
 * Intermediate returns take the nearest-agora proportion of that adjustment.
 * The return that exhausts the sale takes whatever payable amount is left,
 * so the refunds sum to the original amount paid. This does not reapply
 * {@link roundPosPayable}.
 */
export function allocatePosRefundPayable({
  merchandise,
  saleMerchandise,
  saleAdjustment = 0,
  salePayable,
  alreadyRefunded = 0,
  exhaustsSale = false,
}) {
  const merch = round2(merchandise);
  const saleMerch = round2(saleMerchandise);
  const adjustment = round2(saleAdjustment || 0);
  const payableSale = round2(salePayable);
  const already = round2(alreadyRefunded);
  const remaining = round2(Math.max(0, payableSale - already));
  let payable;
  if (!adjustment) {
    payable = round2(Math.min(Math.max(merch, 0), remaining));
  } else if (exhaustsSale) {
    payable = remaining;
  } else {
    const share = saleMerch > 0 ? round2(adjustment * (merch / saleMerch)) : 0;
    payable = round2(merch + share);
    if (payable > remaining) payable = remaining;
    if (payable < 0) payable = 0;
  }
  return { payable, adjustment: round2(payable - merch), merchandise: merch };
}

/** Sum an array of money values, rounding the running total each step. */
export function sumMoney(values) {
  let total = 0;
  for (const v of values) total = round2(total + Number(v || 0));
  return total;
}
