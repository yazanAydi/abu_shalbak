import { conflict } from "./httpError.js";

const SAFE_ALIAS = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * SQL predicate: this customer row is an ordinary walk-in/account customer,
 * not the canonical debt account linked from employees.customer_id.
 * Inactive employees stay classified as employee accounts.
 * @param {string} [alias]
 */
export function sqlOrdinaryCustomer(alias = "c") {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error("invalid customer alias");
  }
  return `NOT EXISTS (SELECT 1 FROM employees e WHERE e.customer_id = ${alias}.id)`;
}

/**
 * @param {object} db
 * @param {number|string} customerId
 * @returns {Promise<{ id: number, name: string, active: number } | null>}
 */
export async function getEmployeeLinkedToCustomer(db, customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.get(
    "SELECT id, name, active FROM employees WHERE customer_id = ?",
    [id]
  );
  return row || null;
}

/**
 * Block customer-management writes against an internal employee debt account.
 * @param {object} db
 * @param {number|string} customerId
 */
export async function assertOrdinaryCustomerWritable(db, customerId) {
  const linked = await getEmployeeLinkedToCustomer(db, customerId);
  if (!linked) return null;
  throw conflict(
    "هذا حساب ذمة موظف ولا يُعدَّل من إدارة العملاء",
    "EMPLOYEE_ACCOUNT_PROTECTED"
  );
}

function countPositive(n) {
  return Number(n) > 0;
}

/**
 * Any posted or pending financial use of this customer row.
 * Used to block ordinary employee linking / unlinking — not a transfer check.
 */
export async function customerHasFinancialHistory(db, customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const row = await db.get(
    `SELECT
       (SELECT ABS(COALESCE(balance, 0)) + ABS(COALESCE(opening_balance, 0))
          FROM customers WHERE id = ?) AS bal,
       (SELECT COUNT(*) FROM transactions WHERE customer_id = ?) AS txs,
       (SELECT COUNT(*) FROM sales_invoices WHERE customer_id = ?) AS inv,
       (SELECT COUNT(*) FROM refunds WHERE customer_id = ?) AS ref,
       (SELECT COUNT(*) FROM voucher_lines WHERE customer_id = ?) AS vl,
       (SELECT COUNT(*) FROM on_account_requests WHERE customer_id = ?) AS oa,
       (SELECT COUNT(*) FROM employee_settlements WHERE customer_id = ?) AS st,
       (SELECT COUNT(*) FROM bank_checks WHERE customer_id = ?) AS ck,
       (SELECT COUNT(*) FROM sales_deliveries WHERE customer_id = ?) AS dl`,
    [id, id, id, id, id, id, id, id, id]
  );
  if (!row) return false;
  if (Number(row.bal) > 0.009) return true;
  return [row.txs, row.inv, row.ref, row.vl, row.oa, row.st, row.ck, row.dl].some(countPositive);
}

/**
 * Employee-owned debt activity even if customer_id is currently null.
 */
export async function employeeHasDebtFinancialUse(db, employeeId) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const row = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE employee_id = ?) AS txs,
       (SELECT COUNT(*) FROM on_account_requests WHERE employee_id = ?) AS oa,
       (SELECT COUNT(*) FROM employee_settlements WHERE employee_id = ?) AS st,
       (SELECT COUNT(*) FROM refunds r
          JOIN transactions t ON t.id = r.original_transaction_id
         WHERE t.employee_id = ?) AS rf,
       (SELECT COUNT(*) FROM refund_requests rr
          JOIN transactions t ON t.id = rr.transaction_id
         WHERE t.employee_id = ?) AS rreq,
       (SELECT COUNT(*) FROM advance_requests WHERE employee_id = ?) AS adv`,
    [id, id, id, id, id, id]
  );
  return [row?.txs, row?.oa, row?.st, row?.rf, row?.rreq, row?.adv].some(countPositive);
}

export async function employeeDebtAccountInUse(db, employeeId, customerId = null) {
  if (await employeeHasDebtFinancialUse(db, employeeId)) return true;
  if (customerId && (await customerHasFinancialHistory(db, customerId))) return true;
  return false;
}
