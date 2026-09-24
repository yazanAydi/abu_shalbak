import { round2 } from "./money.js";

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
export async function creditLimitPreview(db, custId, onAccountAmount) {
  if (!custId) return null;
  const cust = await db.get(
    "SELECT balance, credit_limit, no_credit FROM customers WHERE id = ?",
    [custId]
  );
  if (!cust) return null;
  const current = round2(Number(cust.balance) || 0);
  const requested = round2(Number(onAccountAmount) || 0);
  const limit = round2(Number(cust.credit_limit) || 0);
  const projected = round2(current + requested);
  return {
    current_balance: current,
    requested_amount: requested,
    credit_limit: limit,
    projected_balance: projected,
    exceeds_limit: limit > 0 && projected - limit > 0.009,
    no_credit: Number(cust.no_credit) === 1,
  };
}

export async function validateCustomerCredit(db, custId, onAccountAmount, { allowOverLimit = false } = {}) {
  if (!custId || onAccountAmount <= 0) return null;
  const cust = await db.get("SELECT * FROM customers WHERE id = ?", [custId]);
  if (!cust) return { status: 404, error: "العميل غير موجود", code: "NOT_FOUND" };
  if (cust.no_credit) return { status: 400, error: "هذا العميل ممنوع الدين", code: "CREDIT_BLOCKED" };
  const preview = await creditLimitPreview(db, custId, onAccountAmount);
  if (preview?.exceeds_limit && !allowOverLimit) {
    return {
      status: 400,
      error: "البيع يتجاوز حد الائتمان. أكّد الاستثناء صراحة للموافقة فوق الحد.",
      code: "CREDIT_LIMIT_EXCEEDED",
      credit: preview,
    };
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
