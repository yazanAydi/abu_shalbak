/**
 * Customer balance: positive = customer owes us, negative = credit/advance.
 */
export function customerBalanceView(systemBalance) {
  const n = Number(systemBalance) || 0;
  if (Math.abs(n) < 0.009) {
    return { displayAmount: 0, className: "", hesabatiBalance: 0 };
  }
  const displayAmount = n < 0 ? Math.abs(n) : n;
  const className = n > 0 ? "negative" : "positive";
  return { displayAmount, className, hesabatiBalance: n };
}

/**
 * Format Hesabati-style balance for customer statement rows.
 * @param {number} balance
 */
export function formatCustomerHesabatiBalance(balance) {
  const n = Number(balance) || 0;
  if (Math.abs(n) < 0.009) return "0.00";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `${abs}-` : abs;
}
