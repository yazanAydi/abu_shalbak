import { createHash } from "crypto";
import { round2, sumMoney } from "../utils/money.js";
import { withTransaction } from "../utils/dbTx.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { employeeKind, parseYmd, requireEmployee } from "./employeeService.js";
import { previewCashierHours, rangesOverlap } from "./employeeEntitlementService.js";
import { linkPostedAttendanceSessions, previewHourlyAttendance } from "./attendanceSessionService.js";
import { listEmployeeAdvances } from "./employeeHistoryStatementService.js";
import { applyCustomerDebtDeltaInTx, listEmployeeDebts, withEmployeeDebtLock } from "./employeeDebtService.js";
import { postEmployeePaymentInTx } from "./employeePaymentService.js";

const PAY_METHODS = new Set(["cash", "transfer", "check", "other"]);
const LONG_SHIFT_HOURS = 16;

/**
 * Expense-recognition and debt-settlement mapping
 * -----------------------------------------------
 * Cash salary paid this payday
 *   → one operating_expenses row (category salaries) via postEmployeePaymentInTx
 *     + one employee_ledger_entries salary_payment. This is the cash cost.
 *
 * Previously paid salary advances selected for deduction
 *   → employee_settlements only. No second expense: the advance already created
 *     opex when it was paid (office or approved POS).
 *
 * Product-debt deductions
 *   → employee_settlements tagged to the canonical customer invoice/sale
 *   → reduce customers.balance by the same amount (same write as customer payment)
 *   → one non-cash operating_expenses row:
 *        source = 'employee_salary_in_kind'
 *        payment_method = 'other'
 *        reference_note = 'تسوية ذمة موظف — مصروف راتب غير نقدي'
 *     This is salary paid in kind (goods already taken). It is not a sale, not a
 *     drawer movement, and not a second copy of the receivable.
 *
 * Zero cash when deductions cover the known salary
 *   → payout row with cash_paid = 0 and no ledger salary_payment.
 *
 * /finance remains read-only SUM(operating_expenses.amount) by paid_on.
 * Non-cash in-kind rows are included in that existing sum. The formula is not
 * changed; the new row is labeled so operators can see it is not a cash outflow.
 */

function requireYmd(value, label) {
  const day = parseYmd(value);
  if (!day) throw badRequest(`${label} يجب أن يكون تاريخاً بصيغة YYYY-MM-DD`);
  return day;
}

function moneyOrZero(value) {
  const n = round2(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function payloadHash(body) {
  const normalized = JSON.stringify({
    period_from: body.period_from,
    period_to: body.period_to,
    salary_before_deductions: body.salary_before_deductions ?? null,
    cash_paid: body.cash_paid,
    payment_method: body.payment_method || null,
    occurred_on: body.occurred_on,
    deductions: body.deductions || [],
    reason: body.reason || null,
  });
  return createHash("sha256").update(normalized).digest("hex");
}

function shiftMs(value) {
  if (!value) return null;
  const t = Date.parse(String(value).includes("T") ? value : String(value).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
}

const REVIEW_FLAG_AR = {
  open_shift: "وردية مفتوحة",
  pending_count: "وردية بانتظار العد",
  missing_snapshot: "أجر الساعة غير محفوظ لهذه الوردية",
  long_shift: "وردية طويلة جداً — راجع الساعات",
  overlapping: "تداخل مع وردية أخرى",
};

function addShiftFlag(shift, flag) {
  if (shift.flags.includes(flag)) return;
  shift.flags.push(flag);
  shift.flag_labels.push(REVIEW_FLAG_AR[flag] || flag);
}

function decorateHoursReview(preview) {
  if (!preview?.applicable) {
    return {
      ...preview,
      review_required: false,
      review_flags: [],
      review_flag_labels: [],
      calculation_final: false,
    };
  }
  const shifts = (preview.shifts || []).map((shift) => ({
    ...shift,
    flags: [...(shift.flags || [])],
    flag_labels: [...(shift.flag_labels || [])],
  }));
  for (const shift of shifts) {
    if (Number(shift.hours) > LONG_SHIFT_HOURS) addShiftFlag(shift, "long_shift");
  }
  for (let i = 0; i < shifts.length; i += 1) {
    const a0 = shiftMs(shifts[i].start_time);
    const a1 = shiftMs(shifts[i].end_time);
    if (a0 == null || a1 == null) continue;
    for (let j = i + 1; j < shifts.length; j += 1) {
      const b0 = shiftMs(shifts[j].start_time);
      const b1 = shiftMs(shifts[j].end_time);
      if (b0 == null || b1 == null) continue;
      if (a0 < b1 && b0 < a1) {
        addShiftFlag(shifts[i], "overlapping");
        addShiftFlag(shifts[j], "overlapping");
      }
    }
  }
  const extra = [];
  if (shifts.some((shift) => shift.flags.includes("long_shift"))) extra.push("long_shift");
  if (shifts.some((shift) => shift.flags.includes("overlapping"))) extra.push("overlapping");
  const reviewFlags = [...new Set([...(preview.incomplete_reasons || []), ...extra])];
  const reviewRequired =
    reviewFlags.length > 0 || preview.incomplete === true || preview.preview_pay_incomplete === true;
  return {
    ...preview,
    shifts,
    review_required: reviewRequired,
    review_flags: reviewFlags,
    review_flag_labels: reviewFlags.map((flag) => REVIEW_FLAG_AR[flag] || flag),
    calculation_final: preview.final === true && !reviewRequired,
  };
}

async function resolveSalariesCategory(db) {
  const row = await db.get(
    `SELECT id, name FROM expense_categories
     WHERE name = 'salaries' OR name_ar = 'رواتب'
     ORDER BY CASE WHEN name = 'salaries' THEN 0 ELSE 1 END, id
     LIMIT 1`
  );
  return row || { id: null, name: "salaries" };
}

async function periodProgress(db, period) {
  const deductedRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM employee_settlements WHERE period_id = ? AND status = 'active'`,
    [period.id]
  );
  const cashRow = await db.get(
    `SELECT COALESCE(SUM(cash_paid), 0) AS total
     FROM employee_payroll_payouts WHERE period_id = ?`,
    [period.id]
  );
  const deducted = round2(Number(deductedRow?.total) || 0);
  const cashPaid = round2(Number(cashRow?.total) || 0);
  const salaryBefore =
    period.salary_before_deductions == null ? null : round2(Number(period.salary_before_deductions));
  return {
    deducted,
    cash_paid: cashPaid,
    remaining_salary:
      salaryBefore == null ? null : round2(salaryBefore - deducted - cashPaid),
  };
}

async function findOverlappingPeriod(db, employeeId, periodFrom, periodTo, exceptId = null) {
  const rows = await db.all(
    `SELECT * FROM employee_salary_periods
     WHERE employee_id = ? AND status = 'active' AND (? IS NULL OR id != ?)`,
    [employeeId, exceptId, exceptId]
  );
  return rows.filter((row) => rangesOverlap(row.period_from, row.period_to, periodFrom, periodTo));
}

async function assertShiftsFree(db, shiftIds, exceptPeriodId = null) {
  if (!shiftIds.length) return;
  const placeholders = shiftIds.map(() => "?").join(", ");
  const onPeriod = await db.all(
    `SELECT s.shift_id, p.id AS period_id
     FROM employee_period_shifts s
     JOIN employee_salary_periods p ON p.id = s.period_id
     WHERE s.shift_id IN (${placeholders})
       AND s.included_in_final = 1
       AND p.status = 'active'
       AND (? IS NULL OR p.id != ?)`,
    [...shiftIds, exceptPeriodId, exceptPeriodId]
  );
  if (onPeriod.length) {
    throw conflict("وردية محسوبة في فترة راتب أخرى — لا تُحتسب الوردية مرتين", "SHIFT_ALREADY_ENTITLED");
  }
  const onEntitlement = await db.all(
    `SELECT s.shift_id, e.id AS entitlement_id
     FROM employee_entitlement_shifts s
     JOIN employee_salary_entitlements e ON e.id = s.entitlement_id
     WHERE s.shift_id IN (${placeholders})
       AND s.included_in_final = 1
       AND e.kind = 'entitlement'
       AND e.status = 'active'`,
    shiftIds
  );
  if (onEntitlement.length) {
    throw conflict("وردية محسوبة في استحقاق راتب سابق — لا تُحتسب الوردية مرتين", "SHIFT_ALREADY_ENTITLED");
  }
}

export async function getPayrollPreview(db, employeeId, query = {}) {
  const periodFrom = requireYmd(query.period_from || query.from, "بداية فترة الراتب");
  const periodTo = requireYmd(query.period_to || query.to, "نهاية فترة الراتب");
  if (periodFrom > periodTo) throw badRequest("بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها");

  const emp = await requireEmployee(db, employeeId);
  const kind = employeeKind(emp);
  const asOf = query.as_of ? requireYmd(query.as_of, "تاريخ التسوية") : shopTodayYmd();

  let hours = { applicable: false };
  if (kind === "cashier") {
    hours = decorateHoursReview(await previewCashierHours(db, emp.id, periodFrom, periodTo));
  } else if (emp.wage_basis === "hourly") {
    const attendance = await previewHourlyAttendance(db, emp.id, periodFrom, periodTo);
    hours = {
      applicable: attendance.applicable,
      ...attendance,
      calculation_final: attendance.final === true,
      review_required: attendance.final !== true,
    };
  } else if (emp.wage_basis === "daily") {
    hours = {
      applicable: false,
      wage_basis: "daily",
      daily_rate: emp.daily_rate == null ? null : Number(emp.daily_rate),
      daily_accrual: false,
    };
  }

  const [advances, debts] = await Promise.all([
    listEmployeeAdvances(db, emp.id, { asOf }),
    listEmployeeDebts(db, emp, { asOf }),
  ]);

  const samePeriod = await db.get(
    `SELECT * FROM employee_salary_periods
     WHERE employee_id = ? AND period_from = ? AND period_to = ? AND status = 'active'`,
    [emp.id, periodFrom, periodTo]
  );
  const overlapping = await findOverlappingPeriod(db, emp.id, periodFrom, periodTo, samePeriod?.id || null);
  const progress = samePeriod ? await periodProgress(db, samePeriod) : null;

  const calculatedSalary =
    hours.calculation_final && (kind === "cashier" || emp.wage_basis === "hourly")
      ? round2(Number(hours.posted_pay) || 0)
      : null;

  return {
    employee_id: emp.id,
    name: emp.name,
    kind,
    period_from: periodFrom,
    period_to: periodTo,
    as_of: asOf,
    hours,
    cashier_user_id: emp.user_id ?? null,
    live_hourly_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate),
    calculated_salary: calculatedSalary,
    salary_known: calculatedSalary != null || (progress && samePeriod?.salary_before_deductions != null),
    calculation_final: hours.calculation_final === true,
    advances: advances.items.filter((row) => row.remaining > 0),
    advances_outstanding_total: advances.outstanding_as_of,
    debts: (debts.invoices || []).filter((row) => row.remaining > 0),
    debts_outstanding_total: debts.outstanding_as_of,
    customer_id: emp.customer_id ?? null,
    customer_linked: Boolean(emp.customer_id),
    active_period: samePeriod
      ? {
          id: samePeriod.id,
          salary_before_deductions:
            samePeriod.salary_before_deductions == null
              ? null
              : round2(Number(samePeriod.salary_before_deductions)),
          source: samePeriod.source,
          ...progress,
        }
      : null,
    overlapping_periods: overlapping.map((row) => ({
      id: row.id,
      period_from: row.period_from,
      period_to: row.period_to,
    })),
  };
}

function parseDeductions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw badRequest("قائمة الحسومات غير صالحة");
  return raw.map((item, index) => {
    const kind = item?.kind;
    const sourceType = item?.source_type;
    const sourceId = Number(item?.source_id);
    const amount = round2(Number(item?.amount));
    if (kind !== "advance" && kind !== "debt") {
      throw badRequest(`نوع الحسم غير صالح (سطر ${index + 1})`);
    }
    if (kind === "advance" && sourceType !== "ledger_entry") {
      throw badRequest("حسم السلفة يجب أن يشير إلى قيد السلفة");
    }
    if (kind === "debt" && sourceType !== "pos_sale" && sourceType !== "sales_invoice") {
      throw badRequest("حسم الذمة يجب أن يشير إلى فاتورة ذمة");
    }
    if (!sourceId) throw badRequest("معرّف بند الحسم مطلوب");
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest("مبلغ الحسم يجب أن يكون أكبر من صفر");
    return { kind, source_type: sourceType, source_id: sourceId, amount };
  });
}

async function insertPeriodShifts(db, periodId, preview) {
  if (!preview?.shifts?.length) return;
  for (const shift of preview.shifts) {
    await db.run(
      `INSERT INTO employee_period_shifts
         (period_id, shift_id, shop_start_on, hours, hourly_rate, pay, shift_status, included_in_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        periodId,
        shift.shift_id,
        shift.shop_start_on,
        shift.hours,
        shift.hourly_rate,
        shift.pay,
        shift.status,
        shift.included_in_final ? 1 : 0,
      ]
    );
  }
}

export async function confirmPayrollPayout(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const kind = employeeKind(emp);
  const periodFrom = requireYmd(body?.period_from, "بداية فترة الراتب");
  const periodTo = requireYmd(body?.period_to, "نهاية فترة الراتب");
  if (periodFrom > periodTo) throw badRequest("بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها");
  const occurredOn = requireYmd(body?.occurred_on || shopTodayYmd(), "تاريخ الدفعة");
  const cashPaid = moneyOrZero(body?.cash_paid);
  if (cashPaid < 0) throw badRequest("مبلغ الدفع لا يمكن أن يكون سالباً");
  const paymentMethod = body?.payment_method ? String(body.payment_method).trim() : null;
  if (cashPaid > 0 && !PAY_METHODS.has(paymentMethod)) {
    throw badRequest("طريقة الدفع مطلوبة لدفع نقدي");
  }
  const deductions = parseDeductions(body?.deductions);
  if (cashPaid === 0 && deductions.length === 0) {
    throw badRequest("أدخل مبلغ دفعة أو حسماً واحداً على الأقل");
  }
  const confirmManual = body?.confirm_manual === true;
  const confirmIncomplete = body?.confirm_incomplete === true;
  const reason = body?.reason != null ? String(body.reason).trim() : "";
  const idempotencyKey =
    body?.idempotency_key != null && String(body.idempotency_key).trim()
      ? String(body.idempotency_key).trim().slice(0, 80)
      : null;
  const hash = payloadHash({
    period_from: periodFrom,
    period_to: periodTo,
    salary_before_deductions: body?.salary_before_deductions ?? null,
    cash_paid: cashPaid,
    payment_method: paymentMethod,
    occurred_on: occurredOn,
    deductions,
    reason: reason || null,
  });

  if (idempotencyKey) {
    const existingPayout = await db.get(
      "SELECT * FROM employee_payroll_payouts WHERE idempotency_key = ?",
      [idempotencyKey]
    );
    if (existingPayout) {
      if (existingPayout.payload_hash && existingPayout.payload_hash !== hash) {
        throw conflict("مفتاح التكرار مستخدم لدفعة مختلفة", "IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      return mapPayout(existingPayout);
    }
  }

  const preview = await getPayrollPreview(db, emp.id, {
    period_from: periodFrom,
    period_to: periodTo,
    as_of: occurredOn,
  });
  if (preview.overlapping_periods.length) {
    throw conflict("توجد فترة راتب نشطة تتداخل مع هذه التواريخ", "PERIOD_OVERLAP");
  }

  const frozenSalary =
    preview.active_period?.salary_before_deductions == null
      ? null
      : round2(Number(preview.active_period.salary_before_deductions));
  let salaryBefore = frozenSalary;
  let source = preview.active_period?.source || "unspecified";
  let incomplete = false;
  const submittedSalary =
    body?.salary_before_deductions == null || body?.salary_before_deductions === ""
      ? null
      : round2(Number(body.salary_before_deductions));
  if (submittedSalary != null && !Number.isFinite(submittedSalary)) {
    throw badRequest("مبلغ الراتب قبل الحسم غير صالح");
  }
  if (submittedSalary != null && submittedSalary < 0) {
    throw badRequest("مبلغ الراتب قبل الحسم غير صالح");
  }

  if (frozenSalary != null) {
    salaryBefore = frozenSalary;
    source = preview.active_period?.source || source;
  } else if (submittedSalary != null) {
    if (kind === "cashier") {
      incomplete = !preview.calculation_final;
      const calculated = preview.calculated_salary;
      const matchesCalculated =
        preview.calculation_final &&
        calculated != null &&
        Math.abs(submittedSalary - calculated) < 0.009;
      if (matchesCalculated) {
        salaryBefore = calculated;
        source = "cashier_shifts";
      } else {
        if (!confirmManual || !reason) {
          throw badRequest("تعديل أجر الكاشير يتطلب تأكيداً وسبباً", "MANUAL_CONFIRM_REQUIRED");
        }
        if (incomplete && !confirmIncomplete) {
          throw conflict("حساب الساعات غير نهائي — أكّد المبلغ اليدوي مع السبب", "INCOMPLETE_SHIFTS");
        }
        salaryBefore = submittedSalary;
        source = "manual";
      }
    } else {
      salaryBefore = submittedSalary;
      source = "manual";
    }
  }

  const created = await withEmployeeDebtLock(emp.customer_id, () =>
    withTransaction(db, async () => {
    if (idempotencyKey) {
      const raced = await db.get(
        "SELECT * FROM employee_payroll_payouts WHERE idempotency_key = ?",
        [idempotencyKey]
      );
      if (raced) return raced;
    }

    let period = await db.get(
      `SELECT * FROM employee_salary_periods
       WHERE employee_id = ? AND period_from = ? AND period_to = ? AND status = 'active'`,
      [emp.id, periodFrom, periodTo]
    );

    if (!period) {
      const overlappingNow = await findOverlappingPeriod(db, emp.id, periodFrom, periodTo, null);
      if (overlappingNow.length) {
        throw conflict("توجد فترة راتب نشطة تتداخل مع هذه التواريخ", "PERIOD_OVERLAP");
      }
      if (kind === "cashier") {
        const included = (preview.hours.shifts || []).filter((s) => s.included_in_final).map((s) => s.shift_id);
        await assertShiftsFree(db, included, null);
      }
      const ins = await db.run(
        `INSERT INTO employee_salary_periods
           (employee_id, period_from, period_to, salary_before_deductions, source, incomplete, hours_json, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          emp.id,
          periodFrom,
          periodTo,
          salaryBefore,
          source,
          incomplete ? 1 : 0,
          preview.hours?.applicable ? JSON.stringify(preview.hours) : null,
          reason || null,
          req?.user?.id ?? null,
        ]
      );
      period = await db.get("SELECT * FROM employee_salary_periods WHERE id = ?", [ins.lastID]);
      if (kind === "cashier") await insertPeriodShifts(db, period.id, preview.hours);
    } else if (period.salary_before_deductions == null && salaryBefore != null) {
      await db.run(
        `UPDATE employee_salary_periods SET salary_before_deductions = ?, source = ?, reason = COALESCE(reason, ?)
         WHERE id = ?`,
        [salaryBefore, source, reason || null, period.id]
      );
      period = await db.get("SELECT * FROM employee_salary_periods WHERE id = ?", [period.id]);
    } else if (period.salary_before_deductions != null) {
      salaryBefore = round2(Number(period.salary_before_deductions));
    }

    if (emp.wage_basis === "hourly") {
      await linkPostedAttendanceSessions(db, period.id, preview.hours?.sessions);
    }

    const liveEmp = await requireEmployee(db, emp.id);
    if (liveEmp.customer_id) {
      await db.run("UPDATE customers SET balance = COALESCE(balance, 0) WHERE id = ?", [
        liveEmp.customer_id,
      ]);
    }
    const [liveAdvances, liveDebts] = await Promise.all([
      listEmployeeAdvances(db, emp.id, { asOf: occurredOn }),
      listEmployeeDebts(db, liveEmp, { asOf: occurredOn }),
    ]);
    const advanceById = new Map(liveAdvances.items.map((row) => [row.id, row]));
    const debtByKey = new Map(
      (liveDebts.invoices || []).map((row) => [`${row.source_type}:${row.source_id}`, row])
    );
    const customerRoom = new Map();
    async function liveCustomerRemaining(customerId) {
      const cid = Number(customerId);
      if (!cid) return 0;
      if (!customerRoom.has(cid)) {
        const row = await db.get("SELECT balance FROM customers WHERE id = ?", [cid]);
        customerRoom.set(cid, round2(Math.max(0, Number(row?.balance) || 0)));
      }
      return customerRoom.get(cid);
    }
    const applied = [];
    for (const item of deductions) {
      if (item.kind === "advance") {
        const row = advanceById.get(item.source_id);
        if (!row) throw badRequest("السلفة المختارة غير قائمة أو سُوّيت مسبقاً");
        const amount = round2(Math.min(item.amount, Math.max(0, Number(row.remaining) || 0)));
        if (amount > 0.009) applied.push({ ...item, amount });
      } else {
        const row = debtByKey.get(`${item.source_type}:${item.source_id}`);
        if (!row) throw badRequest("فاتورة الذمة المختارة غير قائمة أو سُوّيت مسبقاً");
        const cid = row.customer_id || liveEmp.customer_id;
        const room = await liveCustomerRemaining(cid);
        const amount = round2(
          Math.min(item.amount, Math.max(0, Number(row.remaining) || 0), room)
        );
        if (amount > 0.009) {
          applied.push({ ...item, amount });
          customerRoom.set(Number(cid), round2(room - amount));
        }
      }
    }

    const progress = await periodProgress(db, period);
    const knownSalary = period.salary_before_deductions == null ? salaryBefore : round2(Number(period.salary_before_deductions));
    const newDeductionTotal = round2(sumMoney(applied.map((d) => d.amount)));
    if (knownSalary != null) {
      const room = round2(knownSalary - progress.deducted - progress.cash_paid);
      if (newDeductionTotal - room > 0.009) {
        throw badRequest("الحسومات المختارة أكبر من الراتب المتبقي — أبقِ الزيادة قائمة", "DEDUCTIONS_EXCEED_SALARY");
      }
      const net = round2(room - newDeductionTotal);
      if (cashPaid - net > 0.009) {
        throw badRequest("المبلغ المدفوع أكبر من صافي الراتب بعد الحسم", "CASH_EXCEEDS_NET");
      }
    }

    const debtTotal = round2(sumMoney(applied.filter((d) => d.kind === "debt").map((d) => d.amount)));
    const advanceTotal = round2(sumMoney(applied.filter((d) => d.kind === "advance").map((d) => d.amount)));
    const netAfter = knownSalary == null ? null : round2(knownSalary - progress.deducted - progress.cash_paid - newDeductionTotal);
    const remainingAfter = netAfter == null ? null : round2(netAfter - cashPaid);

    const breakdown = {
      salary_before_deductions: knownSalary,
      advance_deducted: round2(progress.deducted + advanceTotal) && advanceTotal,
      product_debt_deducted: debtTotal,
      previous_cash_paid: progress.cash_paid,
      previous_deducted: progress.deducted,
      cash_paid: cashPaid,
      net_salary: netAfter,
      remaining_salary: remainingAfter,
      in_kind_expense: debtTotal,
      in_kind_expense_label: debtTotal > 0 ? "تسوية ذمة موظف — مصروف راتب غير نقدي" : null,
    };
    breakdown.advance_deducted = advanceTotal;

    let ledger = null;
    if (cashPaid > 0) {
      ledger = await postEmployeePaymentInTx(db, {
        employeeId: emp.id,
        amount: cashPaid,
        occurredOn,
        purpose: "salary_payment",
        paymentMethod,
        referenceNote: body?.reference_note || `دفعة راتب — من ${periodFrom} إلى ${periodTo}`,
        createdBy: req?.user?.id ?? null,
        idempotencyKey: idempotencyKey ? `payroll-cash:${idempotencyKey}` : null,
      });
    }

    const payoutIns = await db.run(
      `INSERT INTO employee_payroll_payouts
         (period_id, employee_id, occurred_on, cash_paid, payment_method, reference_note,
          ledger_entry_id, breakdown_json, idempotency_key, payload_hash, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        period.id,
        emp.id,
        occurredOn,
        cashPaid,
        cashPaid > 0 ? paymentMethod : null,
        body?.reference_note || null,
        ledger?.id ?? null,
        JSON.stringify(breakdown),
        idempotencyKey,
        hash,
        req?.user?.id ?? null,
      ]
    );
    const payoutId = payoutIns.lastID;

    let inKindId = null;
    if (debtTotal > 0) {
      const cat = await resolveSalariesCategory(db);
      const exp = await db.run(
        `INSERT INTO operating_expenses
           (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id, source, source_id)
         VALUES (?, ?, ?, ?, 'other', ?, ?, 'employee_salary_in_kind', ?)`,
        [
          cat.name,
          cat.id,
          debtTotal,
          occurredOn,
          "تسوية ذمة موظف — مصروف راتب غير نقدي",
          req?.user?.id ?? null,
          payoutId,
        ]
      );
      inKindId = exp.lastID;
      await db.run("UPDATE employee_payroll_payouts SET in_kind_expense_id = ? WHERE id = ?", [
        inKindId,
        payoutId,
      ]);
    }

    for (const item of applied) {
      await db.run(
        `INSERT INTO employee_settlements
           (employee_id, period_id, payout_id, kind, source_type, source_id, amount, occurred_on, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          emp.id,
          period.id,
          payoutId,
          item.kind,
          item.source_type,
          item.source_id,
          item.amount,
          occurredOn,
          item.kind === "debt"
            ? debtByKey.get(`${item.source_type}:${item.source_id}`)?.customer_id || liveEmp.customer_id
            : null,
        ]
      );
    }
    if (debtTotal > 0) {
      const byCustomer = new Map();
      for (const item of applied.filter((d) => d.kind === "debt")) {
        const row = debtByKey.get(`${item.source_type}:${item.source_id}`);
        const cid = row?.customer_id || liveEmp.customer_id;
        if (!cid) throw badRequest("لا يمكن حسم ذمة دون حساب عميل على الفاتورة");
        byCustomer.set(cid, round2((byCustomer.get(cid) || 0) + item.amount));
      }
      for (const [cid, amt] of byCustomer) {
        await applyCustomerDebtDeltaInTx(db, cid, amt);
      }
    }

    return db.get("SELECT * FROM employee_payroll_payouts WHERE id = ?", [payoutId]);
  })
  );

  if (req && created?.id) {
    const breakdown = created.breakdown_json ? JSON.parse(created.breakdown_json) : {};
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_PAYROLL_PAYOUT, "employee_payroll_payouts", created.id, null, {
      employee_id: emp.id,
      period_from: periodFrom,
      period_to: periodTo,
      cash_paid: cashPaid,
      manual_override: source === "manual",
      incomplete,
      reason: reason || null,
      ...breakdown,
    });
  }
  return mapPayout(created);
}

function mapPayout(row) {
  if (!row) throw notFound("دفعة الراتب غير موجودة");
  let breakdown = null;
  try {
    breakdown = row.breakdown_json ? JSON.parse(row.breakdown_json) : null;
  } catch {
    breakdown = null;
  }
  return {
    id: row.id,
    period_id: row.period_id,
    employee_id: row.employee_id,
    occurred_on: row.occurred_on,
    cash_paid: round2(Number(row.cash_paid) || 0),
    payment_method: row.payment_method,
    ledger_entry_id: row.ledger_entry_id,
    in_kind_expense_id: row.in_kind_expense_id,
    breakdown,
    created_at: row.created_at,
  };
}
