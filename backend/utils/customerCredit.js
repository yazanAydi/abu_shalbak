/**
 * Customer credit-limit check used at sale/approval time.
 * Source of truth is customers.balance (the maintained cache).
 * credit_limit <= 0 means no numeric cap (existing rule).
 *
 * @param {object} db
 * @param {number|null|undefined} custId
 * @param {number} onAccountAmount
 * @returns {Promise<null | { status: number, error: string, code: string }>}
 */
export async function validateCustomerCredit(db, custId, onAccountAmount) {
  if (!custId || onAccountAmount <= 0) return null;
  const cust = await db.get("SELECT * FROM customers WHERE id = ?", [custId]);
  if (!cust) return { status: 404, error: "العميل غير موجود", code: "NOT_FOUND" };
  if (cust.no_credit) return { status: 400, error: "هذا العميل ممنوع الدين", code: "CREDIT_BLOCKED" };
  if (cust.credit_limit > 0 && cust.balance + onAccountAmount > cust.credit_limit) {
    return { status: 400, error: "العميل تجاوز حد الائتمان", code: "CREDIT_LIMIT_EXCEEDED" };
  }
  return null;
}

/**
 * @param {{ status: number, error: string, code: string }} creditErr
 */
export function throwCreditError(creditErr) {
  const err = new Error(creditErr.error);
  err.status = creditErr.status;
  err.code = creditErr.code;
  throw err;
}
