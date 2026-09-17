import { round2, sumMoney } from "../utils/money.js";
import { badRequest } from "../utils/httpError.js";
import { employeeKind, parseYmd, requireEmployee } from "./employeeService.js";
import { listEmployeeDebts, listEmployeeDebtRepayments } from "./employeeDebtService.js";
import { paymentCorrectionBlock } from "./employeePaymentService.js";

const PAY_METHOD_AR = {
  cash: "نقد",
  transfer: "تحويل",
  check: "شيك",
  other: "أخرى",
};

function inRange(ymd, from, to) {
  if (from && ymd < from) return false;
  if (to && ymd > to) return false;
  return true;
}

async function settlementsBySource(db, employeeId, kind, asOf) {
  const rows = await db.all(
    `SELECT s.source_id, s.occurred_on, s.amount, s.payout_id, p.ledger_entry_id
     FROM employee_settlements s
     LEFT JOIN employee_payroll_payouts p ON p.id = s.payout_id
     WHERE s.employee_id = ? AND s.kind = ? AND s.status = 'active'
       AND (? IS NULL OR s.occurred_on <= ?)
     ORDER BY s.occurred_on ASC, s.id ASC`,
    [employeeId, kind, asOf, asOf]
  );
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.source_id) || [];
    list.push({
      date: row.occurred_on,
      amount: round2(Number(row.amount) || 0),
      payout_id: row.payout_id,
      salary_payment_id: row.ledger_entry_id || null,
    });
    map.set(row.source_id, list);
  }
  return map;
}

export async function listEmployeeAdvances(db, employeeId, { from = null, to = null, asOf = null } = {}) {
  const asOfDay = asOf || to || null;
  const rows = await db.all(
    `SELECT e.*, o.payment_method, o.reference_note, ar.notes AS request_notes
     FROM employee_ledger_entries e
     LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
     LEFT JOIN advance_requests ar ON ar.id = e.advance_request_id
     WHERE e.employee_id = ?
       AND e.purpose = 'salary_advance'
       AND e.entry_type = 'salary_payment'
     ORDER BY e.occurred_on ASC, e.event_seq ASC, e.id ASC`,
    [employeeId]
  );
  const settlementMap = await settlementsBySource(db, employeeId, "advance", asOfDay);
  const items = [];
  for (const row of rows) {
    const original = round2(Number(row.amount) || 0);
    const reversed = String(row.status || "active") === "reversed";
    const afterAsOf = Boolean(asOfDay && row.occurred_on > asOfDay);
    const history = afterAsOf ? [] : settlementMap.get(row.id) || [];
    const settled = reversed || afterAsOf ? (reversed ? original : 0) : round2(sumMoney(history.map((s) => s.amount)));
    const remaining = reversed || afterAsOf ? 0 : round2(Math.max(0, original - settled));
    items.push({
      id: row.id,
      date: row.occurred_on,
      amount: original,
      settled,
      remaining,
      reason: row.request_notes || row.reference_note || null,
      payment_method: row.payment_method || null,
      payment_method_label: row.payment_method ? PAY_METHOD_AR[row.payment_method] || row.payment_method : null,
      advance_request_id: row.advance_request_id || null,
      settlements: history,
      status: reversed ? "reversed" : remaining > 0 ? "outstanding" : "settled",
      selectable: !reversed && remaining > 0,
    });
  }
  const inPeriod = items.filter((row) => inRange(row.date, from, to));
  return {
    items,
    period_items: inPeriod,
    period_total: round2(sumMoney(inPeriod.map((row) => row.amount))),
    period_settled: round2(sumMoney(inPeriod.map((row) => row.settled))),
    outstanding_as_of: round2(sumMoney(items.map((row) => row.remaining))),
  };
}

export async function listEmployeeSalaryPayments(db, employeeId, { from = null, to = null } = {}) {
  const rows = await db.all(
    `SELECT e.*, o.payment_method, o.reference_note, o.source AS expense_source
     FROM employee_ledger_entries e
     LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
     WHERE e.employee_id = ?
       AND e.purpose = 'salary_payment'
       AND e.entry_type IN ('salary_payment', 'salary_payment_reversal')
     ORDER BY e.occurred_on ASC, e.event_seq ASC, e.id ASC`,
    [employeeId]
  );
  const items = rows
    .filter((row) => inRange(row.occurred_on, from, to))
    .map((row) => {
      const reversal = row.entry_type === "salary_payment_reversal";
      const amount = round2(Number(row.amount) || 0);
      return {
        id: row.id,
        date: row.occurred_on,
        amount: reversal ? round2(-amount) : amount,
        payment_method: row.payment_method || null,
        payment_method_label: row.payment_method
          ? PAY_METHOD_AR[row.payment_method] || row.payment_method
          : null,
        reference: row.reference_note || null,
        reversal,
        can_correct: !reversal && !paymentCorrectionBlock(row),
      };
    });
  return {
    items,
    period_total: round2(sumMoney(items.map((row) => row.amount))),
  };
}

/**
 * Transaction-history statement for كشف حساب الموظفين.
 * Not a running-balance ledger and not an entitlement editor.
 */
export async function getEmployeeHistoryStatement(db, employeeId, query = {}) {
  const from = query.from ? parseYmd(query.from) : null;
  const to = query.to ? parseYmd(query.to) : null;
  if ((query.from && !from) || (query.to && !to)) {
    throw badRequest("التواريخ يجب أن تكون بصيغة YYYY-MM-DD");
  }
  if (from && to && from > to) {
    throw badRequest("تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساوياً له");
  }

  const emp = await requireEmployee(db, employeeId);
  const asOf = to;
  const [salaries, advances, debts, repayments] = await Promise.all([
    listEmployeeSalaryPayments(db, emp.id, { from, to }),
    listEmployeeAdvances(db, emp.id, { from, to, asOf }),
    listEmployeeDebts(db, emp, { from, to, asOf }),
    listEmployeeDebtRepayments(db, emp, { from, to }),
  ]);

  return {
    employee_id: emp.id,
    name: emp.name,
    kind: employeeKind(emp),
    report_title: "كشف حساب موظف",
    date_from: from,
    date_to: to,
    salaries: {
      items: salaries.items,
      period_total: salaries.period_total,
    },
    presentation: "transaction_history",
    advances: {
      items: advances.period_items,
      outstanding_items: advances.items.filter((row) => row.remaining > 0),
      period_total: advances.period_total,
      period_settled: advances.period_settled,
      outstanding_as_of: advances.outstanding_as_of,
    },
    debts: {
      linked: debts.linked,
      customer_id: debts.customer_id,
      customer_name: debts.customer_name || null,
      items: debts.period_invoices || [],
      outstanding_items: (debts.invoices || []).filter((row) => row.remaining > 0),
      period_total: debts.period_original_total,
      outstanding_as_of: debts.outstanding_as_of,
      customer_balance: debts.customer_balance,
    },
    repayments: {
      items: repayments.period_items,
      period_total: repayments.period_total,
    },
  };
}
