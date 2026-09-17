import { round2 } from "./money.js";

/**
 * Posted purchase invoices and returns for a calendar date range.
 * Same document dates as the supplier ledger / purchases module:
 *   purchase_invoices.invoice_date, purchase_returns.return_date
 * Amount is the payable document total (after line discount).
 * Drafts and any non-posted row are excluded. supplier_invoices / vouchers / payments are not used.
 *
 * @param {object} db
 * @param {string} from YYYY-MM-DD inclusive
 * @param {string} to YYYY-MM-DD inclusive
 */
export async function postedPurchaseTotalsForDateRange(db, from, to) {
  const [inv, ret] = await Promise.all([
    db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_invoices
       WHERE status = 'posted'
         AND invoice_date >= ?
         AND invoice_date <= ?`,
      [from, to]
    ),
    db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_returns
       WHERE status = 'posted'
         AND return_date >= ?
         AND return_date <= ?`,
      [from, to]
    ),
  ]);

  const gross = round2(Number(inv?.total) || 0);
  const returns = round2(Number(ret?.total) || 0);
  return {
    gross,
    returns,
    net: round2(gross - returns),
    invoiceCount: Number(inv?.n) || 0,
    returnCount: Number(ret?.n) || 0,
  };
}
