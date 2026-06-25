/**
 * Supplier balance in DB: positive = we owe the supplier, negative = they owe us (advance).
 * Hesabati Excel: negative = we owe, positive = they owe us.
 */
export const SUPPLIER_BALANCE_SUMMARY_LABELS = {
  /** Red — matches minus in Hesabati (we owe the supplier) */
  payable: "إجمالي ما علينا للموردين",
  /** Green — matches plus in Hesabati (supplier owes us) */
  receivable: "إجمالي ما لنا من الموردين",
};

/**
 * @param {unknown} systemBalance
 * @returns {{ displayAmount: number, className: string, hesabatiSigned: number }}
 */
export function supplierBalanceView(systemBalance) {
  const n = Number(systemBalance) || 0;
  if (Math.abs(n) < 0.009) {
    return { displayAmount: 0, className: "", hesabatiSigned: 0 };
  }
  const hesabatiSigned = -n;
  const displayAmount = n < 0 ? Math.abs(n) : n;
  const className = n > 0 ? "negative" : "positive";
  return { displayAmount, className, hesabatiSigned };
}
