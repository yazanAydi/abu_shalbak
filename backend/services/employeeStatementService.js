import { round2, sumMoney } from "../utils/money.js";
import { badRequest } from "../utils/httpError.js";
import { parseYmd, requireEmployee, employeeKind } from "./employeeService.js";
import { previewCashierHours, mapEntitlement } from "./employeeEntitlementService.js";
import { paymentCorrectionBlock } from "./employeePaymentService.js";

const PAY_METHOD_AR = {
  cash: "نقد",
  transfer: "تحويل",
  check: "شيك",
  other: "أخرى",
};

function periodLabel(from, to) {
  return `من ${from} إلى ${to}`;
}

function entitlementDescription(row) {
  const period = periodLabel(row.period_from, row.period_to);
  if (row.kind === "reversal") {
    return `عكس استحقاق راتب — ${period}`;
  }
  if (row.source === "manual") {
    return Number(row.incomplete) === 1
      ? `استحقاق راتب (مبلغ صريح — حساب غير نهائي) — ${period}`
      : `استحقاق راتب (مبلغ صريح) — ${period}`;
  }
  if (row.source === "cashier_shifts") return `استحقاق راتب من ساعات الكاشير — ${period}`;
  if (row.source === "configured") return `استحقاق راتب شهري — ${period}`;
  return `استحقاق راتب — ${period}`;
}

function openingDescription(row) {
  return row.kind === "prepaid_salary"
    ? "رصيد افتتاحي — مقدّم راتب"
    : "رصيد افتتاحي — راتب غير مدفوع";
}

function paymentDescription(row) {
  const reversal = row.entry_type === "salary_payment_reversal";
  const base = reversal
    ? `عكس ${row.purpose === "salary_advance" ? "سلفة على الراتب" : "دفعة راتب"}`
    : row.purpose === "salary_advance"
      ? "سلفة على الراتب"
      : "دفعة راتب";
  const method = row.payment_method ? PAY_METHOD_AR[row.payment_method] || row.payment_method : null;
  const ref = row.reference_note ? String(row.reference_note).trim() : "";
  const intended = row.intended_employee_name
    ? `المستلم الفعلي محفوظ — المقصود كان ${row.intended_employee_name}`
    : "";
  const reason = row.correction_reason ? String(row.correction_reason).trim() : "";
  const bits = [base];
  if (method && !reversal) bits.push(method);
  if (ref) bits.push(ref);
  if (intended) bits.push(intended);
  if (reason && (reversal || intended)) bits.push(reason);
  return bits.join(" — ");
}

function sortEvents(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return Number(a.event_seq) - Number(b.event_seq);
}

function signedAmount(ev) {
  return round2((Number(ev.debit) || 0) - (Number(ev.credit) || 0));
}

async function loadRawEvents(db, employeeId) {
  const [openings, entitlements, payments, intendedNotes] = await Promise.all([
    db.all(
      `SELECT * FROM employee_opening_balances
       WHERE employee_id = ?
       ORDER BY as_of ASC, event_seq ASC, id ASC`,
      [employeeId]
    ),
    db.all(
      `SELECT * FROM employee_salary_entitlements
       WHERE employee_id = ?
       ORDER BY event_date ASC, event_seq ASC, id ASC`,
      [employeeId]
    ),
    db.all(
      `SELECT e.*, o.payment_method, o.reference_note,
              intended.name AS intended_employee_name
       FROM employee_ledger_entries e
       LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
       LEFT JOIN employees intended ON intended.id = e.intended_employee_id
       WHERE e.employee_id = ?
       ORDER BY e.occurred_on ASC, e.event_seq ASC, e.id ASC`,
      [employeeId]
    ),
    db.all(
      `SELECT e.*, o.payment_method, o.reference_note,
              actual.name AS actual_employee_name
       FROM employee_ledger_entries e
       LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
       JOIN employees actual ON actual.id = e.employee_id
       WHERE e.intended_employee_id = ? AND e.employee_id != ?`,
      [employeeId, employeeId]
    ),
  ]);

  const events = [];

  for (const row of openings) {
    const unpaid = row.kind === "unpaid_salary";
    const amount = round2(Number(row.amount));
    events.push({
      date: row.as_of,
      event_seq: row.event_seq,
      kind: row.kind,
      kind_label: openingDescription(row),
      description: openingDescription(row),
      debit: unpaid ? amount : 0,
      credit: unpaid ? 0 : amount,
      amount,
      source: "opening",
      source_id: row.id,
      operating_expense_id: row.operating_expense_id,
      payment_method: null,
      reference: row.reason,
    });
  }

  for (const row of entitlements) {
    const amt = round2(Number(row.amount));
    const reversal = row.kind === "reversal" || amt < 0;
    const abs = round2(Math.abs(amt));
    events.push({
      date: row.event_date,
      event_seq: row.event_seq,
      kind: reversal ? "payroll_earn_reversal" : "payroll_earn",
      kind_label: entitlementDescription(row),
      description: entitlementDescription(row),
      debit: reversal ? 0 : abs,
      credit: reversal ? abs : 0,
      amount: abs,
      source: "entitlement",
      source_id: row.id,
      entitlement: mapEntitlement(row),
      operating_expense_id: null,
      payment_method: null,
      reference: row.reason,
    });
  }

  for (const row of payments) {
    const amount = round2(Number(row.amount));
    const isAdvance = row.purpose === "salary_advance";
    const reversal = row.entry_type === "salary_payment_reversal";
    const block = paymentCorrectionBlock(row);
    events.push({
      date: row.occurred_on,
      event_seq: row.event_seq,
      kind: reversal ? "salary_payment_reversal" : row.purpose,
      purpose: row.purpose,
      kind_label: reversal
        ? `عكس ${isAdvance ? "سلفة على الراتب" : "دفعة راتب"}`
        : isAdvance
          ? "سلفة على الراتب"
          : "دفعة راتب",
      description: paymentDescription(row),
      debit: reversal ? amount : 0,
      credit: reversal ? 0 : amount,
      amount,
      source: "salary_payment",
      source_id: row.id,
      operating_expense_id: row.operating_expense_id,
      advance_request_id: row.advance_request_id,
      shift_cash_movement_id: row.shift_cash_movement_id || null,
      payment_method: row.payment_method || null,
      payment_method_label: row.payment_method ? PAY_METHOD_AR[row.payment_method] || row.payment_method : null,
      reference: row.reference_note || row.correction_reason || null,
      status: row.status || "active",
      can_correct: !block,
      correction_block: block,
      intended_employee_id: row.intended_employee_id || null,
      intended_employee_name: row.intended_employee_name || null,
    });
  }

  for (const row of intendedNotes) {
    const when = row.correction_date || row.occurred_on;
    events.push({
      date: when,
      event_seq: 0,
      kind: "payment_annotation",
      kind_label: "ملاحظة مستلم مقصود",
      description: `ملاحظة: دفعة سُجّلت على ${row.actual_employee_name} بينما المقصود هذا الموظف — لم يُنقل نقد${
        row.correction_reason ? ` — ${row.correction_reason}` : ""
      }`,
      debit: 0,
      credit: 0,
      amount: 0,
      source: "payment_annotation",
      source_id: row.id,
      operating_expense_id: null,
      payment_method: null,
      reference: row.correction_reason || null,
      can_correct: false,
      informational: true,
    });
  }

  events.sort(sortEvents);
  return events;
}

/**
 * GET is read-only: never inserts or recalculates posted salary.
 * Opening = events with date < from. Period rows = from <= date <= to.
 * Openings appear in exactly one of those two places.
 */
export async function getEmployeeStatement(db, id, query = {}) {
  const emp = await requireEmployee(db, id);
  const from = query.from ? parseYmd(query.from) : null;
  const to = query.to ? parseYmd(query.to) : null;
  if (query.from && !from) throw badRequest("تاريخ البداية غير صالح");
  if (query.to && !to) throw badRequest("تاريخ النهاية غير صالح");
  if (from && to && from > to) {
    throw badRequest("تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساوياً له");
  }

  const all = await loadRawEvents(db, emp.id);
  const filtered = from
    ? all.filter((ev) => {
        if (ev.date < from) return false;
        if (to && ev.date > to) return false;
        return true;
      })
    : to
      ? all.filter((ev) => ev.date <= to)
      : all;

  const openingEvents = from ? all.filter((ev) => ev.date < from) : [];
  const openingBalance = round2(sumMoney(openingEvents.map(signedAmount)));

  let running = openingBalance;
  const movements = [];

  if (from) {
    movements.push({
      date: from,
      event_seq: 0,
      kind: "period_opening",
      kind_label: "رصيد افتتاحي",
      description: "رصيد افتتاحي",
      debit: 0,
      credit: 0,
      amount: openingBalance,
      balance: openingBalance,
      source: "opening_balance",
      synthetic: true,
    });
  }

  for (const ev of filtered) {
    running = round2(running + signedAmount(ev));
    movements.push({
      ...ev,
      balance: running,
    });
  }

  const periodEntitled = round2(
    sumMoney(
      filtered
        .filter((ev) => ev.kind !== "salary_payment_reversal" && ev.kind !== "payment_annotation")
        .map((ev) => ev.debit || 0)
    )
  );
  const periodPaid = round2(
    sumMoney(
      filtered
        .filter((ev) => ev.kind !== "payment_annotation")
        .map((ev) => round2((Number(ev.credit) || 0) - (ev.kind === "salary_payment_reversal" ? Number(ev.debit) || 0 : 0)))
    )
  );
  const periodAdvances = round2(
    sumMoney(
      filtered
        .filter((ev) => ev.purpose === "salary_advance" || ev.kind === "salary_advance")
        .map((ev) =>
          ev.kind === "salary_payment_reversal" ? round2(-(Number(ev.debit) || 0)) : Number(ev.credit) || 0
        )
    )
  );
  const periodSalaryPayments = round2(
    sumMoney(
      filtered
        .filter((ev) => ev.purpose === "salary_payment" || ev.kind === "salary_payment")
        .map((ev) =>
          ev.kind === "salary_payment_reversal" ? round2(-(Number(ev.debit) || 0)) : Number(ev.credit) || 0
        )
    )
  );
  const closing = running;
  const owed = closing > 0 ? closing : 0;
  const excessPrepaid = closing < 0 ? round2(-closing) : 0;

  let cashierPreview = null;
  if (employeeKind(emp) === "cashier" && from && to) {
    cashierPreview = await previewCashierHours(db, emp.id, from, to);
  }

  const postedEntitlements = all
    .filter((ev) => ev.source === "entitlement" && ev.entitlement)
    .map((ev) => ev.entitlement);

  return {
    employee_id: emp.id,
    name: emp.name,
    kind: employeeKind(emp),
    report_title: "كشف حساب موظف",
    date_from: from,
    date_to: to,
    opening_balance: openingBalance,
    closing_balance: closing,
    amount_owed: owed,
    excess_prepaid: excessPrepaid,
    period_entitled: periodEntitled,
    period_paid: periodPaid,
    period_salary_payments: periodSalaryPayments,
    period_advances: periodAdvances,
    movements,
    entitlements: postedEntitlements,
    cashier_preview: cashierPreview,
  };
}
