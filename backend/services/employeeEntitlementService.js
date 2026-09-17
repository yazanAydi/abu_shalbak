import { round2, sumMoney } from "../utils/money.js";
import {
  addShopDays,
  shopTodayYmd,
  shopYmdFromTimestamp,
  shopYmdInRange,
  shopYmdRangeToUtcBounds,
} from "../utils/shopTime.js";
import { withTransaction } from "../utils/dbTx.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { shiftHours } from "./cashierPayrollService.js";
import { appendEmployeeEvent, nextEmployeeEventSeq } from "./employeeEventSeq.js";
import { employeeKind, parseYmd, requireEmployee } from "./employeeService.js";

export const SHIFT_ASSIGNMENT_RULE = "shop_start_date";

/** Machine flags stay stable for tests and frozen hours_json. Arabic is for UI. */
export const SHIFT_FLAG_AR = {
  missing_snapshot: "أجر الساعة غير محفوظ لهذه الوردية",
  open: "وردية مفتوحة",
  pending_count: "وردية بانتظار العد",
};

export const INCOMPLETE_REASON_AR = {
  missing_snapshot: "أجر الساعة غير محفوظ لهذه الوردية",
  open_shift: "وردية مفتوحة",
  pending_count: "وردية بانتظار العد",
};

export function firstYmdOfCalendarMonth(ymd) {
  const day = parseYmd(ymd);
  if (!day) return null;
  return `${day.slice(0, 8)}01`;
}

export function lastYmdOfCalendarMonth(ymd) {
  const day = parseYmd(ymd);
  if (!day) return null;
  const [y, m] = day.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

export function isCompleteCalendarMonth(periodFrom, periodTo) {
  const from = parseYmd(periodFrom);
  const to = parseYmd(periodTo);
  if (!from || !to) return false;
  return from === firstYmdOfCalendarMonth(from) && to === lastYmdOfCalendarMonth(from);
}

export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return String(aFrom) <= String(bTo) && String(bFrom) <= String(aTo);
}

/** Whole shift belongs to the shop-local calendar date of start_time. Never split. */
export function shiftAssignmentDate(startTime) {
  return shopYmdFromTimestamp(startTime);
}

function requirePeriod(from, to) {
  const periodFrom = parseYmd(from);
  const periodTo = parseYmd(to);
  if (!periodFrom || !periodTo) {
    throw badRequest("فترة الراتب يجب أن تكون بتاريخين بصيغة YYYY-MM-DD");
  }
  if (periodFrom > periodTo) {
    throw badRequest("بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها");
  }
  return { periodFrom, periodTo };
}

function optionalReason(value) {
  if (value == null || value === "") return null;
  const reason = String(value).trim();
  if (reason.length > 500) throw badRequest("السبب طويل جداً");
  return reason || null;
}

function requireReason(value, label = "سبب المبلغ أو التصحيح مطلوب") {
  const reason = optionalReason(value);
  if (!reason) throw badRequest(label, "REASON_REQUIRED");
  return reason;
}

function requirePositiveAmount(value) {
  const amt = round2(Number(value));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "VALIDATION_ERROR");
  }
  return amt;
}

function parseHoursJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function mapEntitlement(row, extras = {}) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    period_from: row.period_from,
    period_to: row.period_to,
    event_date: row.event_date,
    amount: round2(Number(row.amount)),
    kind: row.kind,
    source: row.source,
    status: row.status,
    incomplete: Number(row.incomplete) === 1,
    hours: parseHoursJson(row.hours_json),
    reason: row.reason,
    reverses_id: row.reverses_id,
    event_seq: row.event_seq,
    created_at: row.created_at,
    reversed_at: row.reversed_at,
    ...extras,
  };
}

async function loadCompensationAsOf(db, employeeId, asOf) {
  return db.get(
    `SELECT * FROM employee_compensation
     WHERE employee_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`,
    [employeeId, asOf]
  );
}

async function compensationChangesInside(db, employeeId, periodFrom, periodTo) {
  return db.all(
    `SELECT * FROM employee_compensation
     WHERE employee_id = ?
       AND effective_from > ?
       AND effective_from <= ?
     ORDER BY effective_from ASC, id ASC`,
    [employeeId, periodFrom, periodTo]
  );
}

export async function configuredMonthlyEligibility(db, emp, periodFrom, periodTo) {
  const reasons = [];
  if (employeeKind(emp) === "cashier") {
    reasons.push("cashier_kind");
  }
  if (!isCompleteCalendarMonth(periodFrom, periodTo)) {
    reasons.push("partial_period");
  }
  if (emp.start_on && emp.start_on > periodFrom) {
    reasons.push("start_inside_period");
  }
  if (emp.end_on && emp.end_on < periodTo) {
    reasons.push("end_inside_period");
  }
  const rate = await loadCompensationAsOf(db, emp.id, periodFrom);
  if (!rate) {
    reasons.push("missing_rate");
  } else if (rate.compensation_type !== "monthly") {
    reasons.push("not_monthly_rate");
  }
  const changes = await compensationChangesInside(db, emp.id, periodFrom, periodTo);
  if (changes.length) {
    reasons.push("rate_change_inside_period");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    configured_amount: rate && rate.compensation_type === "monthly" ? round2(Number(rate.amount)) : null,
    rate,
  };
}

function assertEmployedDuringPeriod(emp, periodFrom, periodTo) {
  if (emp.start_on && emp.start_on > periodTo) {
    throw badRequest("الموظف لم يبدأ العمل في هذه الفترة", "EMPLOYEE_NOT_IN_PERIOD");
  }
  if (emp.end_on && emp.end_on < periodFrom) {
    throw badRequest("الموظف غير موظف في هذه الفترة", "EMPLOYEE_NOT_IN_PERIOD");
  }
}

async function findOverlappingActive(db, employeeId, periodFrom, periodTo, exceptId = null) {
  const rows = await db.all(
    `SELECT * FROM employee_salary_entitlements
     WHERE employee_id = ?
       AND kind = 'entitlement'
       AND status = 'active'
       AND period_from <= ?
       AND period_to >= ?
       AND (? IS NULL OR id != ?)`,
    [employeeId, periodTo, periodFrom, exceptId, exceptId]
  );
  return rows;
}

function shiftFlagList(row) {
  const flags = [];
  if (!row.end_time || row.status === "open") flags.push("open");
  if (row.status === "pending_count") flags.push("pending_count");
  if (row.hourly_rate_snapshot == null || Number(row.hourly_rate_snapshot) <= 0) {
    flags.push("missing_snapshot");
  }
  return flags;
}

async function loadCashierShiftsInPeriod(db, cashierUserId, periodFrom, periodTo) {
  const fetchFrom = addShopDays(periodFrom, -1) || periodFrom;
  const fetchTo = addShopDays(periodTo, 1) || periodTo;
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fetchFrom, fetchTo);
  const startSql = startIso.replace("T", " ").slice(0, 19);
  const endSql = endIso.replace("T", " ").slice(0, 19);
  const rows = await db.all(
    `SELECT s.id AS shift_id, s.start_time, s.end_time, s.status, s.hourly_rate_snapshot
     FROM cashier_shifts s
     WHERE s.cashier_id = ?
       AND datetime(s.start_time) >= datetime(?)
       AND datetime(s.start_time) <= datetime(?)
     ORDER BY datetime(s.start_time) ASC, s.id ASC`,
    [cashierUserId, startSql, endSql]
  );
  return rows.filter((row) => shopYmdInRange(row.start_time, periodFrom, periodTo));
}

export function buildCashierHoursPreviewFromRows(rows, { periodFrom, periodTo }) {
  const shifts = [];
  const incompleteReasons = [];
  for (const row of rows) {
    const flags = shiftFlagList(row);
    const snapshot =
      row.hourly_rate_snapshot == null || Number(row.hourly_rate_snapshot) <= 0
        ? null
        : round2(Number(row.hourly_rate_snapshot));
    const open = flags.includes("open");
    const hours = open ? 0 : shiftHours(row.start_time, row.end_time);
    const included = flags.length === 0 && snapshot != null && hours > 0;
    const pay = included ? round2(snapshot * hours) : 0;
    if (flags.includes("open")) incompleteReasons.push("open_shift");
    if (flags.includes("pending_count")) incompleteReasons.push("pending_count");
    if (flags.includes("missing_snapshot")) incompleteReasons.push("missing_snapshot");
    shifts.push({
      shift_id: row.shift_id,
      start_time: row.start_time,
      end_time: row.end_time,
      shop_start_on: shiftAssignmentDate(row.start_time),
      status: row.status,
      hours,
      hourly_rate: snapshot,
      pay,
      included_in_final: included,
      eligible_for_automatic: included,
      flags,
      flag_labels: flags.map((flag) => SHIFT_FLAG_AR[flag] || flag),
    });
  }
  const included = shifts.filter((s) => s.included_in_final);
  const uniqueReasons = [...new Set(incompleteReasons)];
  const recordedHours = round2(sumMoney(shifts.map((s) => s.hours)));
  const eligibleHours = round2(sumMoney(included.map((s) => s.hours)));
  const postedPay = round2(sumMoney(included.map((s) => s.pay)));
  const openShiftCount = shifts.filter((s) => s.flags.includes("open")).length;
  const pendingCount = shifts.filter((s) => s.flags.includes("pending_count")).length;
  const missingSnapshotCount = shifts.filter((s) => s.flags.includes("missing_snapshot")).length;
  const incomplete =
    uniqueReasons.length > 0 || shifts.some((s) => !s.included_in_final && s.flags.length);
  return {
    is_preview: true,
    assignment_rule: SHIFT_ASSIGNMENT_RULE,
    period_from: periodFrom,
    period_to: periodTo,
    shifts,
    recorded_hours: recordedHours,
    eligible_hours: eligibleHours,
    posted_hours: eligibleHours,
    posted_pay: postedPay,
    preview_pay_incomplete: missingSnapshotCount > 0,
    incomplete,
    incomplete_reasons: uniqueReasons,
    incomplete_reason_labels: uniqueReasons.map((reason) => INCOMPLETE_REASON_AR[reason] || reason),
    open_shift_count: openShiftCount,
    pending_count: pendingCount,
    missing_snapshot_count: missingSnapshotCount,
    uses_live_hourly_rate: false,
    automatic_posting_blocked: incomplete,
    source_breakdown: {
      recorded_hours: recordedHours,
      eligible_hours: eligibleHours,
      excluded_hours: round2(recordedHours - eligibleHours),
      posted_pay: postedPay,
      missing_snapshot_count: missingSnapshotCount,
      open_shift_count: openShiftCount,
      pending_count: pendingCount,
    },
    final: uniqueReasons.length === 0 && !shifts.some((s) => s.flags.length > 0),
  };
}

export async function previewCashierHours(db, employeeId, periodFrom, periodTo) {
  const emp = await requireEmployee(db, employeeId);
  const { periodFrom: from, periodTo: to } = requirePeriod(periodFrom, periodTo);
  if (employeeKind(emp) !== "cashier" || !emp.user_id) {
    return {
      applicable: false,
      employee_id: emp.id,
      kind: employeeKind(emp),
      is_preview: true,
      message: "معاينة الساعات للكاشير المربوط فقط",
    };
  }
  const rows = await loadCashierShiftsInPeriod(db, emp.user_id, from, to);
  const preview = buildCashierHoursPreviewFromRows(rows, { periodFrom: from, periodTo: to });
  return {
    applicable: true,
    employee_id: emp.id,
    kind: "cashier",
    cashier_user_id: emp.user_id,
    ...preview,
  };
}

async function assertShiftsNotOnOtherActive(db, shiftIds, exceptEntitlementId = null) {
  if (!shiftIds.length) return;
  const placeholders = shiftIds.map(() => "?").join(", ");
  const taken = await db.all(
    `SELECT s.shift_id, e.id AS entitlement_id, e.period_from, e.period_to
     FROM employee_entitlement_shifts s
     JOIN employee_salary_entitlements e ON e.id = s.entitlement_id
     WHERE s.shift_id IN (${placeholders})
       AND s.included_in_final = 1
       AND e.kind = 'entitlement'
       AND e.status = 'active'
       AND (? IS NULL OR e.id != ?)`,
    [...shiftIds, exceptEntitlementId, exceptEntitlementId]
  );
  if (taken.length) {
    throw conflict(
      "وردية محسوبة في استحقاق راتب نشط آخر — لا تُحتسب الوردية مرتين",
      "SHIFT_ALREADY_ENTITLED"
    );
  }
}

async function insertEntitlementRow(db, payload) {
  const ins = await db.run(
    `INSERT INTO employee_salary_entitlements
       (employee_id, period_from, period_to, event_date, amount, kind, source, status,
        incomplete, hours_json, reason, reverses_id, event_seq, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.employeeId,
      payload.periodFrom,
      payload.periodTo,
      payload.eventDate,
      payload.amount,
      payload.kind,
      payload.source,
      payload.status,
      payload.incomplete ? 1 : 0,
      payload.hoursJson,
      payload.reason,
      payload.reversesId,
      payload.eventSeq,
      payload.createdBy,
    ]
  );
  const eventKind = payload.kind === "reversal" ? "payroll_earn_reversal" : "payroll_earn";
  await appendEmployeeEvent(db, {
    employeeId: payload.employeeId,
    eventDate: payload.eventDate,
    kind: eventKind,
    eventSeq: payload.eventSeq,
    sourceTable: "employee_salary_entitlements",
    sourceId: ins.lastID,
  });
  return ins.lastID;
}

async function insertEntitlementShifts(db, entitlementId, preview) {
  if (!preview?.shifts?.length) return;
  for (const shift of preview.shifts) {
    await db.run(
      `INSERT INTO employee_entitlement_shifts
         (entitlement_id, shift_id, shop_start_on, hours, hourly_rate, pay, shift_status, included_in_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entitlementId,
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

function frozenHoursPayload(preview) {
  if (!preview || preview.applicable === false) return null;
  return JSON.stringify({
    is_preview: false,
    assignment_rule: SHIFT_ASSIGNMENT_RULE,
    period_from: preview.period_from,
    period_to: preview.period_to,
    shifts: preview.shifts,
    recorded_hours: preview.recorded_hours,
    eligible_hours: preview.eligible_hours,
    posted_hours: preview.posted_hours,
    posted_pay: preview.posted_pay,
    preview_pay_incomplete: preview.preview_pay_incomplete,
    incomplete: preview.incomplete,
    incomplete_reasons: preview.incomplete_reasons,
    incomplete_reason_labels: preview.incomplete_reason_labels,
    source_breakdown: preview.source_breakdown,
    uses_live_hourly_rate: false,
    frozen: true,
  });
}

async function resolvePosting(db, emp, body) {
  const { periodFrom, periodTo } = requirePeriod(body?.period_from, body?.period_to);
  assertEmployedDuringPeriod(emp, periodFrom, periodTo);
  const kind = employeeKind(emp);
  const amountProvided = body?.amount != null && body?.amount !== "";
  const confirmManual = body?.confirm_manual === true;
  const confirmIncomplete = body?.confirm_incomplete === true;

  const overlapping = await findOverlappingActive(db, emp.id, periodFrom, periodTo);
  if (overlapping.length) {
    throw conflict(
      "يوجد استحقاق راتب نشط يتداخل مع هذه الفترة",
      "PERIOD_OVERLAP"
    );
  }

  if (kind === "cashier") {
    const preview = await previewCashierHours(db, emp.id, periodFrom, periodTo);
    const includedIds = (preview.shifts || []).filter((s) => s.included_in_final).map((s) => s.shift_id);
    await assertShiftsNotOnOtherActive(db, includedIds);

    if (preview.incomplete && !confirmIncomplete) {
      throw conflict(
        "حساب ساعات الكاشير غير نهائي — أغلق الورديات الناقصة أو أكّد مبلغاً يدوياً مع السبب",
        "INCOMPLETE_SHIFTS"
      );
    }
    if (preview.incomplete && confirmIncomplete) {
      if (!amountProvided) {
        throw badRequest("المبلغ الصريح مطلوب عندما يكون حساب الساعات غير نهائي", "MANUAL_AMOUNT_REQUIRED");
      }
      const reason = requireReason(body?.reason);
      if (!confirmManual) {
        throw badRequest("أكّد المبلغ اليدوي صراحةً", "MANUAL_CONFIRM_REQUIRED");
      }
      return {
        periodFrom,
        periodTo,
        eventDate: periodTo,
        amount: requirePositiveAmount(body.amount),
        source: "manual",
        incomplete: true,
        reason,
        preview,
      };
    }

    const computed = round2(Number(preview.posted_pay) || 0);
    if (!amountProvided) {
      if (computed <= 0) {
        throw badRequest("لا توجد ساعات مغلقة بأجر محفوظ في هذه الفترة", "NO_POSTABLE_HOURS");
      }
      return {
        periodFrom,
        periodTo,
        eventDate: periodTo,
        amount: computed,
        source: "cashier_shifts",
        incomplete: false,
        reason: optionalReason(body?.reason),
        preview,
      };
    }
    const amount = requirePositiveAmount(body.amount);
    if (amount === computed && !preview.incomplete) {
      return {
        periodFrom,
        periodTo,
        eventDate: periodTo,
        amount,
        source: "cashier_shifts",
        incomplete: false,
        reason: optionalReason(body?.reason),
        preview,
      };
    }
    if (!confirmManual) {
      throw badRequest("المبلغ يختلف عن حساب الساعات — أكّد المبلغ اليدوي مع السبب", "MANUAL_CONFIRM_REQUIRED");
    }
    return {
      periodFrom,
      periodTo,
      eventDate: periodTo,
      amount,
      source: "manual",
      incomplete: preview.incomplete,
      reason: requireReason(body?.reason),
      preview,
    };
  }

  const eligibility = await configuredMonthlyEligibility(db, emp, periodFrom, periodTo);
  if (eligibility.eligible && !amountProvided) {
    return {
      periodFrom,
      periodTo,
      eventDate: periodTo,
      amount: eligibility.configured_amount,
      source: "configured",
      incomplete: false,
      reason: optionalReason(body?.reason),
      preview: null,
    };
  }
  if (eligibility.eligible && amountProvided) {
    const amount = requirePositiveAmount(body.amount);
    if (amount === eligibility.configured_amount) {
      return {
        periodFrom,
        periodTo,
        eventDate: periodTo,
        amount,
        source: "configured",
        incomplete: false,
        reason: optionalReason(body?.reason),
        preview: null,
      };
    }
    if (!confirmManual) {
      throw badRequest("المبلغ يختلف عن الراتب الشهري المضبوط — أكّد المبلغ مع السبب", "MANUAL_CONFIRM_REQUIRED");
    }
    return {
      periodFrom,
      periodTo,
      eventDate: periodTo,
      amount,
      source: "manual",
      incomplete: false,
      reason: requireReason(body?.reason),
      preview: null,
    };
  }

  if (!amountProvided || !confirmManual) {
    throw badRequest(
      "هذه الفترة ليست شهراً كاملاً بسعر شهري ثابت — أدخل المبلغ وأكّده مع السبب",
      "MANUAL_AMOUNT_REQUIRED"
    );
  }
  return {
    periodFrom,
    periodTo,
    eventDate: periodTo,
    amount: requirePositiveAmount(body.amount),
    source: "manual",
    incomplete: false,
    reason: requireReason(body?.reason),
    preview: null,
  };
}

export async function postSalaryEntitlement(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const resolved = await resolvePosting(db, emp, body);

  const created = await withTransaction(db, async () => {
    const overlapping = await findOverlappingActive(db, emp.id, resolved.periodFrom, resolved.periodTo);
    if (overlapping.length) {
      throw conflict("يوجد استحقاق راتب نشط يتداخل مع هذه الفترة", "PERIOD_OVERLAP");
    }
    if (resolved.preview?.shifts) {
      const includedIds = resolved.preview.shifts.filter((s) => s.included_in_final).map((s) => s.shift_id);
      await assertShiftsNotOnOtherActive(db, includedIds);
    }
    const eventSeq = await nextEmployeeEventSeq(db, emp.id);
    const id = await insertEntitlementRow(db, {
      employeeId: emp.id,
      periodFrom: resolved.periodFrom,
      periodTo: resolved.periodTo,
      eventDate: resolved.eventDate,
      amount: resolved.amount,
      kind: "entitlement",
      source: resolved.source,
      status: "active",
      incomplete: resolved.incomplete,
      hoursJson: frozenHoursPayload(resolved.preview),
      reason: resolved.reason,
      reversesId: null,
      eventSeq,
      createdBy: req?.user?.id ?? null,
    });
    await insertEntitlementShifts(db, id, resolved.preview);
    return db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [id]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_ENTITLEMENT_POST, "employee_salary_entitlements", created.id, null, {
      employee_id: emp.id,
      period_from: resolved.periodFrom,
      period_to: resolved.periodTo,
      event_date: resolved.eventDate,
      amount: resolved.amount,
      source: resolved.source,
      incomplete: resolved.incomplete,
      reason: resolved.reason,
      manual_override: resolved.source === "manual",
      incomplete_reasons: resolved.preview?.incomplete_reasons || [],
      missing_snapshot_count: resolved.preview?.missing_snapshot_count || 0,
    });
  }
  return mapEntitlement(created);
}

async function loadEntitlement(db, employeeId, entitlementId) {
  const row = await db.get(
    "SELECT * FROM employee_salary_entitlements WHERE id = ? AND employee_id = ?",
    [entitlementId, employeeId]
  );
  if (!row) throw notFound("استحقاق الراتب غير موجود");
  return row;
}

async function reverseEntitlementInTx(db, emp, original, { reason, correctionDate, createdBy }) {
  if (original.kind !== "entitlement" || original.status !== "active") {
    throw conflict("لا يمكن عكس استحقاق غير نشط", "ENTITLEMENT_NOT_ACTIVE");
  }
  const day = parseYmd(correctionDate) || shopTodayYmd();
  if (day < original.event_date) {
    throw badRequest("تاريخ التصحيح لا يمكن أن يسبق تاريخ الاستحقاق الأصلي", "CORRECTION_DATE_BEFORE_ORIGINAL");
  }
  const reverseSeq = await nextEmployeeEventSeq(db, emp.id);
  const reverseId = await insertEntitlementRow(db, {
    employeeId: emp.id,
    periodFrom: original.period_from,
    periodTo: original.period_to,
    eventDate: day,
    amount: round2(-Number(original.amount)),
    kind: "reversal",
    source: "reversal",
    status: "active",
    incomplete: 0,
    hoursJson: null,
    reason,
    reversesId: original.id,
    eventSeq: reverseSeq,
    createdBy,
  });
  await db.run(
    `UPDATE employee_salary_entitlements
     SET status = 'reversed', reversed_at = datetime('now'), reversed_by = ?
     WHERE id = ?`,
    [createdBy, original.id]
  );
  return { reverseId, correctionDate: day };
}

export async function reverseSalaryEntitlement(db, employeeId, entitlementId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const reason = requireReason(body?.reason);
  const original = await loadEntitlement(db, emp.id, entitlementId);

  const result = await withTransaction(db, async () => {
    const fresh = await loadEntitlement(db, emp.id, entitlementId);
    const { reverseId, correctionDate } = await reverseEntitlementInTx(db, emp, fresh, {
      reason,
      correctionDate: body?.correction_date,
      createdBy: req?.user?.id ?? null,
    });
    return {
      original: await db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [fresh.id]),
      reversal: await db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [reverseId]),
      correctionDate,
    };
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_ENTITLEMENT_REVERSE, "employee_salary_entitlements", original.id, {
      status: "active",
      amount: original.amount,
    }, {
      status: "reversed",
      reversal_id: result.reversal.id,
      correction_date: result.correctionDate,
      reason,
    });
  }
  return {
    original: mapEntitlement(result.original),
    reversal: mapEntitlement(result.reversal),
  };
}

export async function reverseAndReplaceSalaryEntitlement(db, employeeId, entitlementId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const reason = requireReason(body?.reason);
  const original = await loadEntitlement(db, emp.id, entitlementId);
  if (original.kind !== "entitlement" || original.status !== "active") {
    throw conflict("لا يمكن استبدال استحقاق غير نشط", "ENTITLEMENT_NOT_ACTIVE");
  }

  const replaceBody = {
    period_from: original.period_from,
    period_to: original.period_to,
    amount: body?.amount,
    reason,
    confirm_manual: body?.confirm_manual,
    confirm_incomplete: body?.confirm_incomplete,
  };

  const result = await withTransaction(db, async () => {
    const fresh = await loadEntitlement(db, emp.id, entitlementId);
    const { reverseId, correctionDate } = await reverseEntitlementInTx(db, emp, fresh, {
      reason,
      correctionDate: body?.correction_date,
      createdBy: req?.user?.id ?? null,
    });
    const resolved = await resolvePosting(db, emp, replaceBody);
    const replaceSeq = await nextEmployeeEventSeq(db, emp.id);
    const replaceId = await insertEntitlementRow(db, {
      employeeId: emp.id,
      periodFrom: resolved.periodFrom,
      periodTo: resolved.periodTo,
      eventDate: correctionDate,
      amount: resolved.amount,
      kind: "entitlement",
      source: resolved.source,
      status: "active",
      incomplete: resolved.incomplete,
      hoursJson: frozenHoursPayload(resolved.preview),
      reason,
      reversesId: null,
      eventSeq: replaceSeq,
      createdBy: req?.user?.id ?? null,
    });
    await insertEntitlementShifts(db, replaceId, resolved.preview);
    return {
      original: await db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [fresh.id]),
      reversal: await db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [reverseId]),
      replacement: await db.get("SELECT * FROM employee_salary_entitlements WHERE id = ?", [replaceId]),
      correctionDate,
      resolved,
    };
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_ENTITLEMENT_REVERSE, "employee_salary_entitlements", original.id, {
      status: "active",
      amount: original.amount,
    }, {
      status: "reversed",
      reversal_id: result.reversal.id,
      replacement_id: result.replacement.id,
      correction_date: result.correctionDate,
      amount: result.replacement.amount,
      reason,
    });
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_ENTITLEMENT_POST, "employee_salary_entitlements", result.replacement.id, null, {
      employee_id: emp.id,
      replaces: original.id,
      event_date: result.correctionDate,
      amount: result.replacement.amount,
      source: result.replacement.source,
      incomplete: result.resolved.incomplete,
      reason: result.resolved.reason,
      manual_override: result.resolved.source === "manual",
      incomplete_reasons: result.resolved.preview?.incomplete_reasons || [],
      missing_snapshot_count: result.resolved.preview?.missing_snapshot_count || 0,
    });
  }

  return {
    original: mapEntitlement(result.original),
    reversal: mapEntitlement(result.reversal),
    replacement: mapEntitlement(result.replacement),
  };
}

export async function listEmployeeEntitlements(db, employeeId) {
  const rows = await db.all(
    `SELECT * FROM employee_salary_entitlements
     WHERE employee_id = ?
     ORDER BY event_date ASC, event_seq ASC, id ASC`,
    [employeeId]
  );
  return rows.map((row) => mapEntitlement(row));
}
