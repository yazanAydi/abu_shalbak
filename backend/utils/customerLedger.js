import { round2 } from "./tax.js";
import { dayBefore } from "./supplierLedger.js";

/**
 * @param {object} db
 * @param {number} customerId
 * @param {string} [from]
 * @param {string} [to]
 */
export async function fetchCustomerLedgerEvents(db, customerId, from, to) {
  const dateClause = (col) => {
    let c = "";
    const p = [];
    if (from) {
      c += ` AND ${col} >= ?`;
      p.push(from);
    }
    if (to) {
      c += ` AND ${col} <= ?`;
      p.push(to + "T23:59:59");
    }
    return { c, p };
  };

  const sales = dateClause("t.created_at");
  const saleInv = dateClause("si.invoice_date");
  const refs = dateClause("r.created_at");
  const pays = dateClause("v.voucher_date");
  const settles = dateClause("s.occurred_on");
  const revs = dateClause("COALESCE(s.reversed_on, s.occurred_on)");

  return db.all(
    `SELECT 'sale' AS ev_type, t.created_at AS ev_date, t.total AS debit, 0 AS credit, t.id AS ref_id, t.notes AS notes, t.id AS sort_id
       FROM transactions t
       WHERE t.customer_id = ? AND t.payment_method = 'on_account'
         AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.transaction_id = t.id) ${sales.c}
     UNION ALL
     SELECT 'sale_invoice', si.invoice_date, si.on_account_amount, 0, si.id, si.notes, si.id
       FROM sales_invoices si
       WHERE si.customer_id = ? AND si.status = 'posted' AND si.on_account_amount > 0 ${saleInv.c}
     UNION ALL
     SELECT 'refund' AS ev_type, r.created_at AS ev_date, 0 AS debit, r.total AS credit, r.id AS ref_id, NULL AS notes, r.id AS sort_id
       FROM refunds r
       WHERE r.customer_id = ? AND r.status = 'approved' ${refs.c}
     UNION ALL
     SELECT 'payment' AS ev_type, v.voucher_date AS ev_date, 0 AS debit, vl.amount_nis AS credit, v.id AS ref_id, NULL AS notes, v.id AS sort_id
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.customer_id = ? AND v.voucher_type = 'receipt' AND v.status = 'posted' ${pays.c}
     UNION ALL
     SELECT 'payroll_settlement', s.occurred_on, 0, s.amount, s.id, 'تسوية ذمة راتب غير نقدية', s.id
       FROM employee_settlements s
       WHERE s.customer_id = ? AND s.kind = 'debt' ${settles.c}
     UNION ALL
     SELECT 'payroll_settlement_reversal', COALESCE(s.reversed_on, s.occurred_on), s.amount, 0, s.id, 'عكس تسوية ذمة راتب', s.id
       FROM employee_settlements s
       WHERE s.customer_id = ? AND s.kind = 'debt' AND s.status = 'reversed' ${revs.c}
     ORDER BY ev_date ASC, sort_id ASC`,
    [
      customerId, ...sales.p,
      customerId, ...saleInv.p,
      customerId, ...refs.p,
      customerId, ...pays.p,
      customerId, ...settles.p,
      customerId, ...revs.p,
    ]
  );
}

/**
 * Customer running balance: previous + debit - credit
 * @param {object} db
 * @param {object} customer
 * @param {string} [from]
 * @param {string} [to]
 * @param {{ limit?: number|null }} [options] limit keeps only the most recent
 *   events in the response; the running balance is still computed over every
 *   event, so the numbers are identical either way.
 */
export async function buildCustomerLedger(db, customer, from, to, options = {}) {
  const limit =
    Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Number(options.limit)
      : null;
  let openingBalance = round2(Number(customer.opening_balance) || 0);
  if (from) {
    const priorEvents = await fetchCustomerLedgerEvents(db, customer.id, null, dayBefore(from));
    openingBalance = applyCustomerRunning(priorEvents, openingBalance).closing;
  }

  const events = await fetchCustomerLedgerEvents(db, customer.id, from, to);
  const { rows, closing } = applyCustomerRunning(events, openingBalance);

  const opening = {
    ev_type: "opening",
    ev_date: null,
    debit: openingBalance > 0 ? openingBalance : 0,
    credit: openingBalance < 0 ? round2(-openingBalance) : 0,
    ref_id: null,
    running_balance: openingBalance,
  };

  const windowed = limit != null && rows.length > limit ? rows.slice(rows.length - limit) : rows;

  return {
    opening,
    events: windowed,
    total_events: rows.length,
    truncated: windowed.length < rows.length,
    closing_balance: closing,
    opening_balance: openingBalance,
  };
}

/**
 * @param {object[]} events
 * @param {number} start
 */
function applyCustomerRunning(events, start) {
  let running = round2(start);
  const rows = events.map((e) => {
    running = round2(running + (Number(e.debit) || 0) - (Number(e.credit) || 0));
    return { ...e, running_balance: running };
  });
  return { rows, closing: running };
}
