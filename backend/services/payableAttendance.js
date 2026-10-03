import { conflict } from "../utils/httpError.js";
import { round2, sumMoney } from "../utils/money.js";
import { parseTimestampMs, shiftHours, shiftPay } from "./cashierPayrollService.js";
import { shopYmdFromTimestamp, addShopDays } from "../utils/shopTime.js";
import { previewCashierHours } from "./employeeEntitlementService.js";
import { previewHourlyAttendance } from "./attendanceSessionService.js";
import { getPayrollAttendanceCutover } from "./payrollCutover.js";

export const SESSION_LIMIT_MS = 16 * 60 * 60 * 1000;

const WARNING_AR = {
  missing_checkout: "لا يوجد انصراف خلال 16 ساعة — الجلسة بلا أجر",
  open_session: "جلسة حضور مفتوحة — لا تُحتسب حتى تسجيل الانصراف",
  missing_attendance: "وردية نقطة بيع بلا حضور على الجهاز — أجر الحضور صفر",
  missing_snapshot: "أجر الساعة غير محفوظ لجلسة الحضور",
  orphan_out: "انصراف بلا حضور",
  extra_in: "حضور إضافي أثناء جلسة مفتوحة",
};

function warningLabels(codes) {
  return [...new Set(codes)].map((code) => WARNING_AR[code] || code);
}

/**
 * Pair stored IN/OUT punches. An open session older than 16 hours pays nothing
 * and does not invent an OUT. A real overnight pair within 16 hours pays the gap.
 * @param {Array<object>} punches active punches, chronological
 * @param {number} nowMs
 */
export function sessionsFromPunches(punches, nowMs) {
  const sessions = [];
  const warnings = [];
  let open = null;

  function pushMissing(start) {
    sessions.push({
      status: "missing_checkout",
      hours: 0,
      pay: 0,
      hourly_rate: start.hourly_rate,
      included_in_final: false,
      check_in_at: start.punched_at,
      check_out_at: null,
      in_punch_id: start.id,
      out_punch_id: null,
      shop_start_on: shopYmdFromTimestamp(start.punched_at),
      manual: start.source === "manual",
      flags: ["missing_checkout"],
    });
    warnings.push("missing_checkout");
  }

  for (const punch of punches) {
    const at = parseTimestampMs(punch.punched_at);
    if (punch.punch_type === "in") {
      if (open && at - open.at > SESSION_LIMIT_MS) {
        pushMissing(open);
        open = null;
      }
      if (open && punch.source === "manual") {
        warnings.push("extra_in");
        continue;
      }
      if (open) {
        pushMissing(open);
      }
      const rate = punch.hourly_rate_snapshot == null ? null : round2(Number(punch.hourly_rate_snapshot));
      open = {
        id: punch.id,
        at,
        punched_at: punch.punched_at,
        source: punch.source,
        hourly_rate: rate != null && rate > 0 ? rate : null,
      };
      continue;
    }
    if (!open) {
      warnings.push("orphan_out");
      continue;
    }
    const gap = at - open.at;
    if (gap <= 0) {
      warnings.push("orphan_out");
      open = null;
      continue;
    }
    if (gap > SESSION_LIMIT_MS && punch.source !== "manual") {
      pushMissing(open);
      open = null;
      continue;
    }
    const endSql = punch.punched_at;
    const hours = shiftHours(open.punched_at, endSql);
    const rateOk = open.hourly_rate != null;
    const pay = rateOk ? shiftPay(open.hourly_rate, hours) : 0;
    const flags = [];
    if (!rateOk) {
      flags.push("missing_snapshot");
      warnings.push("missing_snapshot");
    }
    sessions.push({
      status: "closed",
      hours,
      pay,
      hourly_rate: open.hourly_rate,
      included_in_final: rateOk && hours > 0,
      check_in_at: open.punched_at,
      check_out_at: endSql,
      in_punch_id: open.id,
      out_punch_id: punch.id,
      shop_start_on: shopYmdFromTimestamp(open.punched_at),
      manual: open.source === "manual" || punch.source === "manual",
      flags,
    });
    open = null;
  }

  if (open) {
    if (nowMs - open.at > SESSION_LIMIT_MS) {
      pushMissing(open);
    } else {
      sessions.push({
        status: "open",
        hours: 0,
        pay: 0,
        hourly_rate: open.hourly_rate,
        included_in_final: false,
        check_in_at: open.punched_at,
        check_out_at: null,
        in_punch_id: open.id,
        out_punch_id: null,
        shop_start_on: shopYmdFromTimestamp(open.punched_at),
        manual: open.source === "manual",
        flags: ["open_session"],
      });
      warnings.push("open_session");
    }
  }

  return { sessions, warnings };
}

export async function buildPayableAttendance(db, employeeId, { from, to, nowMs = Date.now() } = {}) {
  const punches = await db.all(
    `SELECT id, employee_id, punched_at, punch_type, source, status, hourly_rate_snapshot, correction_note
     FROM attendance_interpreted_punches
     WHERE employee_id = ? AND status = 'active'
     ORDER BY datetime(punched_at) ASC, id ASC`,
    [employeeId]
  );
  const built = sessionsFromPunches(punches, nowMs);
  const sessions = built.sessions.filter((session) => {
    if (!from || !to) return true;
    return session.shop_start_on && session.shop_start_on >= from && session.shop_start_on <= to;
  });
  const warnings = [];
  for (const session of sessions) {
    if (session.status === "missing_checkout") warnings.push("missing_checkout");
    if (session.status === "open") warnings.push("open_session");
    if (session.flags?.includes("missing_snapshot")) warnings.push("missing_snapshot");
  }
  const included = sessions.filter((session) => session.included_in_final);
  const postedPay = round2(sumMoney(included.map((session) => session.pay)));
  const postedHours = round2(sumMoney(included.map((session) => session.hours)));
  const recordedHours = round2(
    sumMoney(sessions.filter((session) => session.status === "closed").map((session) => session.hours))
  );
  const missingSnapshot = sessions.some((session) => session.flags?.includes("missing_snapshot"));
  const openCount = sessions.filter((session) => session.status === "open").length;
  const calculationFinal = openCount === 0 && !missingSnapshot;
  return {
    applicable: true,
    sessions,
    attendance_sessions: sessions,
    posted_pay: postedPay,
    posted_hours: postedHours,
    recorded_hours: recordedHours,
    attendance_hours: postedHours,
    calculation_final: calculationFinal,
    final: calculationFinal,
    warnings: [...new Set(warnings)],
    warning_labels: warningLabels(warnings),
    open_session_count: openCount,
    missing_checkout_count: sessions.filter((session) => session.status === "missing_checkout").length,
    missing_snapshot_count: sessions.filter((session) => session.flags?.includes("missing_snapshot")).length,
  };
}

function summarizeShiftRows(shifts) {
  const included = shifts.filter((shift) => shift.included_in_final);
  const reasons = [];
  for (const shift of shifts) {
    if (shift.flags?.includes("open")) reasons.push("open_shift");
    if (shift.flags?.includes("pending_count")) reasons.push("pending_count");
    if (shift.flags?.includes("missing_snapshot")) reasons.push("missing_snapshot");
  }
  const unique = [...new Set(reasons)];
  return {
    shifts,
    posted_pay: round2(sumMoney(included.map((shift) => shift.pay))),
    posted_hours: round2(sumMoney(included.map((shift) => shift.hours))),
    recorded_hours: round2(sumMoney(shifts.map((shift) => Number(shift.hours) || 0))),
    final: unique.length === 0 && shifts.every((shift) => !(shift.flags || []).length),
    incomplete_reasons: unique,
    missing_snapshot_count: shifts.filter((shift) => shift.flags?.includes("missing_snapshot")).length,
    open_shift_count: shifts.filter((shift) => shift.flags?.includes("open")).length,
  };
}

function posComparison(shifts) {
  return shifts.map((shift) => ({
    shift_id: shift.shift_id,
    start_time: shift.start_time,
    end_time: shift.end_time,
    shop_start_on: shift.shop_start_on,
    status: shift.status,
    hours: shift.hours,
    pay_excluded: true,
    included_in_final: false,
  }));
}

/**
 * One hour engine for dates on/after the cutover, combined with the historical
 * source for earlier shop dates in the same period. POS duration is comparison only.
 */
export async function composeCutoverPayrollHours(db, emp, { periodFrom, periodTo, kind, nowMs = Date.now(), cutover }) {
  const dayBefore = addShopDays(cutover, -1);
  const usesShifts = periodFrom < cutover;
  const attFrom = periodFrom > cutover ? periodFrom : cutover;
  let shiftSummary = summarizeShiftRows([]);
  let legacy = null;
  let posShifts = [];

  if (kind === "cashier") {
    const full = await previewCashierHours(db, emp.id, periodFrom, periodTo);
    const rows = full.shifts || [];
    if (usesShifts) {
      const end = dayBefore && dayBefore < periodTo ? dayBefore : periodTo;
      shiftSummary = summarizeShiftRows(
        rows.filter((shift) => shift.shop_start_on >= periodFrom && shift.shop_start_on <= end && shift.shop_start_on < cutover)
      );
    }
    posShifts = posComparison(
      rows.filter((shift) => shift.shop_start_on >= cutover && shift.shop_start_on <= periodTo)
    );
  } else {
    const legacyTo = dayBefore && dayBefore < periodTo ? dayBefore : periodTo;
    if (usesShifts && periodFrom <= legacyTo) {
      legacy = await previewHourlyAttendance(db, emp.id, periodFrom, legacyTo);
    }
  }

  const attendance = await buildPayableAttendance(db, emp.id, { from: attFrom, to: periodTo, nowMs });
  const legacyPay = kind === "cashier" ? shiftSummary.posted_pay : round2(Number(legacy?.posted_pay) || 0);
  const legacyHours = kind === "cashier" ? shiftSummary.posted_hours : round2(Number(legacy?.posted_hours) || 0);
  const warnings = [...attendance.warnings];
  if (kind === "cashier") {
    const attendedDays = new Set(attendance.sessions.map((session) => session.shop_start_on));
    const missingDays = new Set(
      posShifts.map((shift) => shift.shop_start_on).filter((day) => day && !attendedDays.has(day))
    );
    if (missingDays.size) warnings.push("missing_attendance");
  }
  const legacyFinal = kind === "cashier" ? shiftSummary.final : legacy == null || legacy.final !== false;
  const calculationFinal = legacyFinal && attendance.calculation_final;
  const payrollSource = usesShifts ? "split" : "attendance";
  const uniqueWarnings = [...new Set(warnings)];
  return {
    applicable: true,
    attendance_authoritative: true,
    payroll_source: payrollSource,
    cutover,
    kind,
    employee_id: emp.id,
    cashier_user_id: emp.user_id ?? null,
    live_hourly_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate),
    period_from: periodFrom,
    period_to: periodTo,
    shifts: shiftSummary.shifts,
    pos_shifts: posShifts,
    pos_hours: round2(sumMoney(posShifts.map((shift) => Number(shift.hours) || 0))),
    pos_affects_pay: false,
    sessions: legacy?.sessions || [],
    legacy_sessions: legacy?.sessions || [],
    attendance_sessions: attendance.sessions,
    attendance_hours: attendance.posted_hours,
    shift_hours: legacyHours,
    recorded_hours: round2((kind === "cashier" ? shiftSummary.recorded_hours : legacyHours) + attendance.recorded_hours),
    posted_hours: round2(legacyHours + attendance.posted_hours),
    posted_pay: round2(legacyPay + attendance.posted_pay),
    calculation_final: calculationFinal,
    final: calculationFinal,
    review_required: !calculationFinal || uniqueWarnings.length > 0,
    warnings: uniqueWarnings,
    warning_labels: warningLabels(uniqueWarnings),
    incomplete_reasons: [
      ...(shiftSummary.incomplete_reasons || []),
      ...(attendance.calculation_final ? [] : ["open_session"]),
    ],
    missing_snapshot_count:
      (shiftSummary.missing_snapshot_count || 0) + (attendance.missing_snapshot_count || 0),
    open_shift_count: shiftSummary.open_shift_count || 0,
    open_session_count: attendance.open_session_count,
    missing_checkout_count: attendance.missing_checkout_count,
    comparison_note: "بعد تاريخ الاعتماد، ساعات جهاز البصمة هي ساعات الراتب. مدة وردية نقطة البيع للمقارنة فقط ولا تُضاف إلى الأجر.",
  };
}

export async function cutoverForPeriod(db, periodTo) {
  const cutover = await getPayrollAttendanceCutover(db);
  if (!cutover || !periodTo || periodTo < cutover) return null;
  return cutover;
}

export async function linkPostedDeviceSessions(db, periodId, employeeId, sessions) {
  for (const session of sessions || []) {
    if (!session.included_in_final || !session.in_punch_id) continue;
    const taken = await db.get(
      `SELECT s.period_id
       FROM employee_period_device_sessions s
       JOIN employee_salary_periods p ON p.id = s.period_id
       WHERE s.in_punch_id = ? AND s.included_in_final = 1 AND p.status = 'active' AND p.id != ?`,
      [session.in_punch_id, periodId]
    );
    if (taken) {
      throw conflict("جلسة حضور محسوبة في فترة راتب أخرى", "ATTENDANCE_ALREADY_PAID");
    }
    await db.run(
      `INSERT INTO employee_period_device_sessions
         (period_id, in_punch_id, employee_id, shop_start_on, hours, hourly_rate, pay, session_status, included_in_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(period_id, in_punch_id) DO NOTHING`,
      [
        periodId,
        session.in_punch_id,
        employeeId,
        session.shop_start_on,
        session.hours,
        session.hourly_rate,
        session.pay,
        session.status,
      ]
    );
  }
}
