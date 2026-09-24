import { HttpError } from "../utils/httpError.js";
import { PUNCH_ROLES } from "../utils/roles.js";
import { withTransaction } from "../utils/dbTx.js";
import { businessDayFromTimestamp } from "../utils/businessDay.js";
import { getAppSettings } from "../utils/settings.js";
import { shopLocalParts, shopLocalToUtcMs, shopYmdFromTimestamp, utcMsToSql } from "../utils/shopTime.js";
import { round2, shiftHours, shiftPay, parseTimestampMs } from "./cashierPayrollService.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

export const ATTENDANCE_MAX_OPEN_MS = 12 * 60 * 60 * 1000;
export const AUTO_CHECKOUT_LABEL = "انصراف تلقائي بعد 12 ساعة";

let clockOverride = null;

export function attendanceNow() {
  return clockOverride ? new Date(clockOverride.getTime()) : new Date();
}

/** @param {Date|number|string|null} value */
export function setAttendanceNow(value) {
  if (value == null) {
    clockOverride = null;
    return;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid attendance clock");
  clockOverride = date;
}

function nowMs() {
  return attendanceNow().getTime();
}

function sqlNow() {
  return utcMsToSql(nowMs());
}

/**
 * Shop-local "YYYY-MM-DDTHH:MM" or UTC sql/ISO → UTC sql.
 * @param {string} value
 */
export function parseAttendanceInstant(value) {
  const s = String(value || "").trim();
  const local = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local && !s.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = shopLocalToUtcMs(local[1], Number(local[2]), Number(local[3]), Number(local[4] || 0));
    if (!Number.isFinite(ms)) return null;
    return utcMsToSql(ms);
  }
  const ms = parseTimestampMs(s);
  if (!Number.isFinite(ms)) return null;
  return utcMsToSql(ms);
}

function capEndMs(checkInSql, explicitEndSql, atMs) {
  const start = parseTimestampMs(checkInSql);
  if (!Number.isFinite(start)) return null;
  const cap = start + ATTENDANCE_MAX_OPEN_MS;
  if (explicitEndSql) {
    const end = parseTimestampMs(explicitEndSql);
    return Number.isFinite(end) ? end : null;
  }
  return Math.min(atMs, cap);
}

export function sessionHoursAndPay(row, atMs = nowMs()) {
  const endMs = capEndMs(row.check_in_at, row.status === "closed" ? row.check_out_at : null, atMs);
  if (endMs == null) return { hours: 0, pay: 0, capped: false };
  const start = parseTimestampMs(row.check_in_at);
  const capped = row.status !== "closed" && atMs >= start + ATTENDANCE_MAX_OPEN_MS;
  const endSql = utcMsToSql(endMs);
  const hours = shiftHours(row.check_in_at, endSql);
  const rate = row.hourly_rate_snapshot;
  const pay =
    row.status === "closed" && row.earned_pay != null && !capped
      ? round2(Number(row.earned_pay))
      : shiftPay(rate, hours);
  return { hours, pay, capped, effective_end: endSql };
}

function mapSession(row, atMs = nowMs()) {
  const calc = sessionHoursAndPay(row, atMs);
  const auto = row.close_source === "auto" && Number(row.corrected) !== 1;
  return {
    id: row.id,
    user_id: row.user_id,
    employee_id: row.employee_id,
    check_in_at: row.check_in_at,
    check_out_at: row.status === "closed" ? row.check_out_at : calc.capped ? calc.effective_end : null,
    recorded_at: row.recorded_at,
    recorded_check_out_at: row.recorded_check_out_at,
    hourly_rate_snapshot: row.hourly_rate_snapshot == null ? null : Number(row.hourly_rate_snapshot),
    earned_pay: row.status === "closed" ? round2(Number(row.earned_pay) || 0) : calc.pay,
    hours: calc.hours,
    status: row.status === "closed" ? "closed" : calc.capped ? "auto_pending" : "open",
    stored_status: row.status,
    close_source: row.close_source,
    auto_checkout: auto || calc.capped,
    auto_checkout_label: auto || calc.capped ? AUTO_CHECKOUT_LABEL : null,
    corrected: Number(row.corrected) === 1,
    correction_reason: row.correction_reason,
    payroll_discrepancy: Number(row.payroll_discrepancy) === 1,
    payroll_discrepancy_note: row.payroll_discrepancy_note,
  };
}

async function hourlyEmployee(db, userId) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");
  const user = await db.get(
    `SELECT u.id, u.username, u.role, u.hourly_rate, e.id AS employee_id, e.wage_basis, e.daily_rate
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.id = ?`,
    [id]
  );
  if (!user) throw new HttpError(404, "المستخدم غير موجود");
  if (user.role === "cashier") {
    throw new HttpError(400, "الكاشير يُحتسب من ورديات نقطة البيع وليس من سجل الحضور هذا");
  }
  if (!PUNCH_ROLES.includes(user.role)) {
    throw new HttpError(400, "هذا الحساب لا يستخدم حضور الأجر بالساعة");
  }
  if (user.wage_basis !== "hourly") {
    throw new HttpError(400, "طريقة احتساب الأجر ليست أجراً بالساعة");
  }
  return user;
}

async function assertNoOverlap(db, userId, startSql, endSql, exceptId = null) {
  const rows = await db.all(
    `SELECT id, check_in_at, check_out_at, status FROM attendance_sessions
     WHERE user_id = ? AND (? IS NULL OR id != ?)`,
    [userId, exceptId, exceptId]
  );
  const start = parseTimestampMs(startSql);
  const end = endSql ? parseTimestampMs(endSql) : Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const a0 = parseTimestampMs(row.check_in_at);
    const a1 = row.check_out_at ? parseTimestampMs(row.check_out_at) : Number.POSITIVE_INFINITY;
    if (start < a1 && a0 < end) {
      throw new HttpError(409, "تتداخل هذه الفترة مع جلسة حضور أخرى");
    }
  }
}

async function insertClosed(db, user, checkInSql, checkOutSql, closeSource, recordedOutSql) {
  const hours = shiftHours(checkInSql, checkOutSql);
  const pay = shiftPay(user.hourly_rate, hours);
  const ins = await db.run(
    `INSERT INTO attendance_sessions
       (user_id, employee_id, check_in_at, check_out_at, recorded_at, recorded_check_out_at,
        hourly_rate_snapshot, earned_pay, status, close_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?)`,
    [
      user.id,
      user.employee_id,
      checkInSql,
      checkOutSql,
      sqlNow(),
      recordedOutSql,
      round2(Number(user.hourly_rate)),
      pay,
      closeSource,
    ]
  );
  return db.get("SELECT * FROM attendance_sessions WHERE id = ?", [ins.lastID]);
}

export async function checkInAttendance(db, { userId, checkInAt, checkOutAt }, req) {
  const user = await hourlyEmployee(db, userId);
  const rate = Number(user.hourly_rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new HttpError(400, "أجر الساعة مطلوب قبل تسجيل الحضور");
  }
  const checkInSql = checkInAt ? parseAttendanceInstant(checkInAt) : sqlNow();
  if (!checkInSql) throw new HttpError(400, "وقت الحضور غير صالح");
  if (parseTimestampMs(checkInSql) > nowMs() + 60_000) {
    throw new HttpError(400, "وقت الحضور لا يمكن أن يكون في المستقبل");
  }
  const manualOut = checkOutAt ? parseAttendanceInstant(checkOutAt) : null;
  if (checkOutAt && !manualOut) throw new HttpError(400, "وقت الانصراف غير صالح");
  if (manualOut && parseTimestampMs(manualOut) <= parseTimestampMs(checkInSql)) {
    throw new HttpError(400, "الانصراف يجب أن يكون بعد الحضور");
  }
  if (manualOut && parseTimestampMs(manualOut) > nowMs() + 60_000) {
    throw new HttpError(400, "وقت الانصراف لا يمكن أن يكون في المستقبل");
  }

  const overdue = !manualOut && nowMs() >= parseTimestampMs(checkInSql) + ATTENDANCE_MAX_OPEN_MS;
  const row = await withTransaction(db, async () => {
    const open = await db.get(
      "SELECT id FROM attendance_sessions WHERE user_id = ? AND status = 'open'",
      [user.id]
    );
    if (open) throw new HttpError(409, "توجد جلسة حضور مفتوحة لهذا الموظف");
    if (manualOut) {
      await assertNoOverlap(db, user.id, checkInSql, manualOut);
      return insertClosed(db, user, checkInSql, manualOut, "manual", sqlNow());
    }
    if (overdue) {
      const autoOut = utcMsToSql(parseTimestampMs(checkInSql) + ATTENDANCE_MAX_OPEN_MS);
      await assertNoOverlap(db, user.id, checkInSql, autoOut);
      return insertClosed(db, user, checkInSql, autoOut, "auto", sqlNow());
    }
    await assertNoOverlap(db, user.id, checkInSql, null);
    const ins = await db.run(
      `INSERT INTO attendance_sessions
         (user_id, employee_id, check_in_at, recorded_at, hourly_rate_snapshot, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
      [user.id, user.employee_id, checkInSql, sqlNow(), round2(rate)]
    );
    return db.get("SELECT * FROM attendance_sessions WHERE id = ?", [ins.lastID]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_CHECK_IN, "attendance_sessions", row.id, null, {
      user_id: user.id,
      check_in_at: row.check_in_at,
      check_out_at: row.check_out_at,
      close_source: row.close_source,
    });
  }
  return mapSession(row);
}

export async function checkOutAttendance(db, { userId, checkOutAt }, req) {
  const user = await hourlyEmployee(db, userId);
  const checkOutSql = checkOutAt ? parseAttendanceInstant(checkOutAt) : sqlNow();
  if (!checkOutSql) throw new HttpError(400, "وقت الانصراف غير صالح");
  if (parseTimestampMs(checkOutSql) > nowMs() + 60_000) {
    throw new HttpError(400, "وقت الانصراف لا يمكن أن يكون في المستقبل");
  }

  const row = await withTransaction(db, async () => {
    const open = await db.get(
      "SELECT * FROM attendance_sessions WHERE user_id = ? AND status = 'open'",
      [user.id]
    );
    if (!open) throw new HttpError(400, "لا يوجد حضور مفتوح لتسجيل الانصراف");
    if (parseTimestampMs(checkOutSql) <= parseTimestampMs(open.check_in_at)) {
      throw new HttpError(400, "الانصراف يجب أن يكون بعد الحضور");
    }
    await assertNoOverlap(db, user.id, open.check_in_at, checkOutSql, open.id);
    const pay = shiftPay(open.hourly_rate_snapshot, shiftHours(open.check_in_at, checkOutSql));
    const updated = await db.run(
      `UPDATE attendance_sessions
       SET check_out_at = ?, recorded_check_out_at = ?, earned_pay = ?, status = 'closed', close_source = 'manual'
       WHERE id = ? AND status = 'open'`,
      [checkOutSql, sqlNow(), pay, open.id]
    );
    if (!updated.changes) throw new HttpError(409, "أُغلقت الجلسة مسبقاً");
    return db.get("SELECT * FROM attendance_sessions WHERE id = ?", [open.id]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_CHECK_OUT, "attendance_sessions", row.id, null, {
      check_out_at: row.check_out_at,
      close_source: row.close_source,
      earned_pay: row.earned_pay,
    });
  }
  return mapSession(row);
}

export async function correctAttendanceCheckout(db, sessionId, { checkOutAt, reason }, req) {
  const id = Number(sessionId);
  if (!id) throw new HttpError(400, "معرّف الجلسة غير صالح");
  const note = String(reason || "").trim();
  if (!note) throw new HttpError(400, "سبب التصحيح مطلوب");
  const checkOutSql = parseAttendanceInstant(checkOutAt);
  if (!checkOutSql) throw new HttpError(400, "وقت الانصراف غير صالح");

  const row = await withTransaction(db, async () => {
    const existing = await db.get("SELECT * FROM attendance_sessions WHERE id = ?", [id]);
    if (!existing) throw new HttpError(404, "جلسة الحضور غير موجودة");
    if (existing.status !== "closed") throw new HttpError(400, "التصحيح لجلسة مغلقة");
    if (parseTimestampMs(checkOutSql) <= parseTimestampMs(existing.check_in_at)) {
      throw new HttpError(400, "الانصراف يجب أن يكون بعد الحضور");
    }
    await assertNoOverlap(db, existing.user_id, existing.check_in_at, checkOutSql, existing.id);
    const pay = shiftPay(existing.hourly_rate_snapshot, shiftHours(existing.check_in_at, checkOutSql));
    const linked = await db.get(
      "SELECT session_id, pay FROM employee_period_attendance WHERE session_id = ?",
      [id]
    );
    let discrepancy = Number(existing.payroll_discrepancy) === 1 ? 1 : 0;
    let discrepancyNote = existing.payroll_discrepancy_note;
    if (linked && Math.abs(round2(Number(linked.pay)) - pay) >= 0.009) {
      discrepancy = 1;
      discrepancyNote = "تغيّر أجر الجلسة بعد ترحيل الراتب — لم يُعدَّل الراتب المرحّل";
    }
    await db.run(
      `UPDATE attendance_sessions
       SET check_out_at = ?, earned_pay = ?, close_source = 'correction', corrected = 1,
           correction_reason = ?, corrected_at = ?,
           payroll_discrepancy = ?, payroll_discrepancy_note = ?
       WHERE id = ?`,
      [checkOutSql, pay, note.slice(0, 500), sqlNow(), discrepancy, discrepancyNote, id]
    );
    return db.get("SELECT * FROM attendance_sessions WHERE id = ?", [id]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_CORRECT, "attendance_sessions", row.id, null, {
      check_out_at: row.check_out_at,
      reason: note,
      earned_pay: row.earned_pay,
      payroll_discrepancy: Number(row.payroll_discrepancy) === 1,
    });
  }
  return mapSession(row);
}

/**
 * Close non-cashier hourly sessions that have been open for 12 hours.
 * Checkout time is check-in + 12h, not the job clock. Idempotent.
 */
export async function closeOverdueAttendanceSessions(db, at = attendanceNow()) {
  const atMs = at instanceof Date ? at.getTime() : Number(at);
  const deadlineSql = utcMsToSql(atMs - ATTENDANCE_MAX_OPEN_MS);
  const open = await db.all(
    `SELECT * FROM attendance_sessions
     WHERE status = 'open' AND corrected = 0 AND datetime(check_in_at) <= datetime(?)`,
    [deadlineSql]
  );
  let closed = 0;
  for (const row of open) {
    const checkOutSql = utcMsToSql(parseTimestampMs(row.check_in_at) + ATTENDANCE_MAX_OPEN_MS);
    const pay = shiftPay(row.hourly_rate_snapshot, shiftHours(row.check_in_at, checkOutSql));
    const result = await db.run(
      `UPDATE attendance_sessions
       SET check_out_at = ?, recorded_check_out_at = ?, earned_pay = ?, status = 'closed', close_source = 'auto'
       WHERE id = ? AND status = 'open' AND corrected = 0`,
      [checkOutSql, utcMsToSql(atMs), pay, row.id]
    );
    if (result.changes) closed += 1;
  }
  return { closed };
}

export async function listHourlySessionsForReport(db, userId, fromYmd, toYmd) {
  const rows = await db.all(
    `SELECT * FROM attendance_sessions WHERE user_id = ? ORDER BY datetime(check_in_at) ASC, id ASC`,
    [userId]
  );
  const atMs = nowMs();
  return rows
    .map((row) => mapSession(row, atMs))
    .filter((row) => {
      const ymd = shopYmdFromTimestamp(row.check_in_at);
      return ymd && ymd >= fromYmd && ymd <= toYmd;
    });
}

export async function previewHourlyAttendance(db, employeeId, fromYmd, toYmd) {
  const emp = await db.get(
    `SELECT e.id, e.user_id, e.wage_basis, u.hourly_rate, u.role
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp || emp.role === "cashier" || emp.wage_basis !== "hourly" || !emp.user_id) {
    return { applicable: false };
  }
  const sessions = await listHourlySessionsForReport(db, emp.user_id, fromYmd, toYmd);
  const open = sessions.filter((s) => s.status === "open");
  const included = sessions.filter((s) => s.status !== "open");
  const pay = round2(included.reduce((sum, s) => sum + (Number(s.earned_pay) || 0), 0));
  const hours = round2(included.reduce((sum, s) => sum + (Number(s.hours) || 0), 0));
  return {
    applicable: true,
    final: open.length === 0,
    posted_pay: pay,
    posted_hours: hours,
    sessions,
    incomplete_reasons: open.length ? ["open_session"] : [],
    payroll_discrepancies: sessions.filter((s) => s.payroll_discrepancy),
  };
}

export async function linkPostedAttendanceSessions(db, periodId, sessions) {
  for (const session of sessions || []) {
    if (session.status === "open") continue;
    await db.run(
      `INSERT OR IGNORE INTO employee_period_attendance
         (period_id, session_id, hours, hourly_rate, pay)
       VALUES (?, ?, ?, ?, ?)`,
      [periodId, session.session_id || session.id, session.hours, session.hourly_rate ?? session.hourly_rate_snapshot, session.pay ?? session.earned_pay]
    );
  }
}

export async function listHourlyAttendanceBoard(db) {
  const users = await db.all(
    `SELECT u.id, u.username, u.role, u.hourly_rate, e.name, e.wage_basis
     FROM users u
     JOIN employees e ON e.user_id = u.id
     WHERE e.wage_basis = 'hourly' AND u.role != 'cashier'
     ORDER BY e.name COLLATE NOCASE`
  );
  const atMs = nowMs();
  const board = [];
  for (const user of users) {
    const rows = await db.all(
      `SELECT * FROM attendance_sessions WHERE user_id = ? ORDER BY datetime(check_in_at) DESC, id DESC LIMIT 20`,
      [user.id]
    );
    const sessions = rows.map((row) => mapSession(row, atMs));
    board.push({
      user_id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      hourly_rate: user.hourly_rate == null ? null : Number(user.hourly_rate),
      open_session: sessions.find((s) => s.stored_status === "open") || null,
      sessions,
    });
  }
  return board;
}

export async function employeeHasOpenHourlySession(db, userId) {
  if (!userId) return false;
  const row = await db.get(
    "SELECT id FROM attendance_sessions WHERE user_id = ? AND status = 'open'",
    [userId]
  );
  return Boolean(row);
}

/**
 * Active hourly employees whose attendance is entered by hand and who still
 * need a record for the current business day. An open session from any day
 * counts as already checked in.
 */
export async function listMissingHourlyAttendance(db, at = attendanceNow()) {
  const settings = await getAppSettings(db);
  const cutoff = settings.business_day_cutoff_hour;
  const businessDay = businessDayFromTimestamp(at, cutoff);
  const placeholders = PUNCH_ROLES.map(() => "?").join(", ");
  const employees = await db.all(
    `SELECT u.id AS user_id, e.id AS employee_id, e.name
     FROM users u
     JOIN employees e ON e.user_id = u.id
     WHERE e.active = 1
       AND e.wage_basis = 'hourly'
       AND u.role IN (${placeholders})
     ORDER BY e.name COLLATE NOCASE, e.id`,
    PUNCH_ROLES
  );
  const missing = [];
  for (const emp of employees) {
    const sessions = await db.all(
      "SELECT check_in_at, status FROM attendance_sessions WHERE user_id = ?",
      [emp.user_id]
    );
    if (sessions.some((row) => row.status === "open")) continue;
    const recorded = sessions.some(
      (row) => businessDayFromTimestamp(row.check_in_at, cutoff) === businessDay
    );
    if (recorded) continue;
    missing.push({
      user_id: emp.user_id,
      employee_id: emp.employee_id,
      name: emp.name,
    });
  }
  return { business_day: businessDay, cutoff_hour: cutoff, employees: missing };
}

export async function attendanceReminderForUser(db, userId, at = attendanceNow()) {
  const payload = await listMissingHourlyAttendance(db, at);
  const dismissed = await db.get(
    "SELECT 1 AS ok FROM attendance_reminder_dismissals WHERE user_id = ? AND business_day = ?",
    [userId, payload.business_day]
  );
  return {
    business_day: payload.business_day,
    cutoff_hour: payload.cutoff_hour,
    dismissed: Boolean(dismissed),
    employees: payload.employees,
  };
}

export async function dismissAttendanceReminder(db, userId, at = attendanceNow()) {
  const payload = await listMissingHourlyAttendance(db, at);
  await db.run(
    `INSERT INTO attendance_reminder_dismissals (user_id, business_day)
     VALUES (?, ?)
     ON CONFLICT(user_id, business_day) DO NOTHING`,
    [userId, payload.business_day]
  );
  return { business_day: payload.business_day, dismissed: true };
}

export function shopPartsLabel(sql) {
  const parts = shopLocalParts(sql);
  if (!parts) return sql;
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  return `${parts.ymd} ${hh}:${mm}`;
}
