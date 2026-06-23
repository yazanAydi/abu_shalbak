# Money Precision Report — "أبو شلبك" POS

## Summary

All monetary values (prices, costs, subtotals, tax, totals, refunds, shift cash,
supplier amounts) are stored as SQLite `REAL` (IEEE-754 double precision) and
rounded to 2 decimal places at every computation boundary. This is the standard
floating-point approach and is **adequate for a single-store supermarket** at
this transaction scale, but it carries a small, well-understood rounding risk.

## How rounding works today

- One canonical rounding function: `round2` in
  [`backend/utils/money.js`](../backend/utils/money.js). `backend/utils/tax.js`,
  `backend/utils/cogs.js`, `backend/routes/reports.js`, and
  `backend/routes/finance.js` all use it (previously each redefined its own).
- Totals are computed per line and the running subtotal/tax/total are rounded at
  each step (`computeSaleTotals` in `tax.js`, `sumMoney` in `money.js`), which
  keeps cumulative drift below half a fils for realistic cart sizes.
- `round2` adds `Number.EPSILON` before scaling to neutralize the most common
  representation artifacts (e.g. `0.1 + 0.2`).

## Known residual risk

- Double precision cannot represent every 2-dp decimal exactly. For very large
  aggregations (e.g. months of data summed in one pass) sub-fils errors can
  accumulate. Reports mitigate this by rounding at each step.
- Tax decomposition on tax-inclusive prices (`gross / (1 + rate)`) can produce a
  1-fils rounding difference on individual lines; this is industry-normal.
- The `payment_method` CHECK on the legacy `transactions` table lists only
  `cash`/`visa`; this is unrelated to precision and tracked separately.

## Why we did NOT migrate to integer minor units now

Switching all money columns to integer **agorot/fils** (or a fixed-point
representation) is the robust long-term fix, but it requires:

- A data migration of every existing money column across ~15 tables.
- Touching every read/write path and the two React frontends.
- Re-validating receipts, reports, shift reconciliation, and exports.

That is a high-risk change disproportionate to the current, low residual error.
Per the agreed plan it is **deferred**, not abandoned.

## Future migration path (when warranted)

1. Introduce integer `*_minor` columns alongside existing REAL columns.
2. Backfill `*_minor = round(value * 100)`; reconcile against current values.
3. Switch writes to populate both, reads to prefer `*_minor`.
4. Move all arithmetic to integers; format to decimals only at display.
5. Drop the REAL columns after a full verification cycle and a backup.

## Tests

`backend/tests/moneyPrecision.test.js` locks in the rounding contract:
`0.1 + 0.2`, repeated fractional quantities, tax-inclusive/exclusive
decomposition, and `qty × fractional price` exactness.
