import { createHash } from "crypto";
import { badRequest, conflict, notFound } from "../utils/httpError.js";
import { withTransaction } from "../utils/dbTx.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { round2, sumMoney } from "../utils/money.js";
import { shopYmdFromTimestamp } from "../utils/shopTime.js";
import { ATTENDANCE_ROLES } from "../utils/roles.js";
import { shiftPay } from "./cashierPayrollService.js";
import { buildPayableAttendance } from "./payableAttendance.js";
import { payrollReadiness, resolveLiveHourlyRate } from "./employeeHourlyRate.js";

function requireYmd(value, label) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw badRequest(`${label} يجب أن يكون تاريخاً بصيغة YYYY-MM-DD`);
  }
  return day;
}

function requireNote(value) {
  const note = String(value || "").trim();
  if (!note) throw badRequest("ملاحظة التصحيح مطلوبة");
  if (note.length > 500) throw badRequest("الملاحظة طويلة جداً");
  return note;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stable(value[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function previewToken(payload) {
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

async function countOf(db, sql, params) {
  const row = await db.get(sql, params);
  return Number(row?.n) || 0;
}

function snapshotMissing(value) {
  if (value == null || value === "") return true;
  const rate = Number(value);
  return !Number.isFinite(rate) || rate <= 0;
}

async function savedSalaryPeriods(db, employeeId) {
  return db.all(
    `SELECT id, period_from, period_to, salary_before_deductions, status
     FROM employee_salary_periods
     WHERE employee_id = ? AND status = 'active'
     ORDER BY period_from, id`,
    [employeeId]
  );
}

function periodCovering(periods, ymd) {
  return (
    periods.find(
      (period) =>
        period.salary_before_deductions != null &&
        ymd >= period.period_from &&
        ymd <= period.period_to
    ) || null
  );
}

async function linkedFinalPunchIds(db, employeeId) {
  const rows = await db.all(
    `SELECT s.in_punch_id AS id
     FROM employee_period_device_sessions s
     JOIN employee_salary_periods p ON p.id = s.period_id
     WHERE s.employee_id = ? AND s.included_in_final = 1 AND p.status = 'active'`,
    [employeeId]
  );
  return new Set(rows.map((row) => Number(row.id)));
}

async function loadRateCorrection(db, employeeId, body) {
  const from = requireYmd(body?.from || body?.period_from, "بداية الفترة");
  const to = requireYmd(body?.to || body?.period_to, "نهاية الفترة");
  if (from > to) throw badRequest("بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها");
  const note = requireNote(body?.note);
  const rate = round2(Number(body?.hourly_rate));
  if (!Number.isFinite(rate) || rate <= 0) throw badRequest("أجر الساعة للتصحيح يجب أن يكون أكبر من صفر");

  const emp = await db.get(
    `SELECT e.id, e.name, e.user_id, e.wage_basis, e.hourly_rate, e.daily_rate,
            u.hourly_rate AS linked_user_hourly_rate
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp) throw notFound("الموظف غير موجود");

  const punches = await db.all(
    `SELECT id, punched_at, punch_type, status, hourly_rate_snapshot, source
     FROM attendance_interpreted_punches
     WHERE employee_id = ? AND status = 'active' AND punch_type = 'in'
     ORDER BY datetime(punched_at) ASC, id ASC`,
    [emp.id]
  );
  const periods = await savedSalaryPeriods(db, emp.id);
  const lockedIds = await linkedFinalPunchIds(db, emp.id);
  const attendance = await buildPayableAttendance(db, emp.id, { from, to });
  const sessionByIn = new Map(
    (attendance.sessions || [])
      .filter((session) => session.in_punch_id)
      .map((session) => [Number(session.in_punch_id), session])
  );

  const eligible = [];
  const preserved = [];
  const blocked = [];
  for (const punch of punches) {
    const shopDay = shopYmdFromTimestamp(punch.punched_at);
    if (!shopDay || shopDay < from || shopDay > to) continue;
    const session = sessionByIn.get(Number(punch.id)) || null;
    const base = {
      id: punch.id,
      punched_at: punch.punched_at,
      shop_start_on: shopDay,
      source: punch.source,
      hourly_rate_snapshot: punch.hourly_rate_snapshot == null ? null : Number(punch.hourly_rate_snapshot),
      hours: session ? Number(session.hours) || 0 : 0,
      status: session?.status || "unpaired",
    };
    if (!snapshotMissing(punch.hourly_rate_snapshot)) {
      preserved.push({ ...base, reason: "positive_snapshot" });
      continue;
    }
    const covered = periodCovering(periods, shopDay);
    if (lockedIds.has(Number(punch.id)) || covered) {
      blocked.push({
        ...base,
        reason: lockedIds.has(Number(punch.id)) ? "included_in_payroll" : "salary_period_saved",
        period_id: covered?.id ?? null,
      });
      continue;
    }
    const hours = base.hours;
    eligible.push({
      ...base,
      new_snapshot: rate,
      pay_after: session?.status === "closed" ? shiftPay(rate, hours) : 0,
    });
  }

  const payableBefore = round2(sumMoney((attendance.sessions || []).filter((s) => s.included_in_final).map((s) => s.pay)));
  const payableHoursBefore = round2(
    sumMoney((attendance.sessions || []).filter((s) => s.included_in_final).map((s) => s.hours))
  );
  const addedPay = round2(sumMoney(eligible.map((row) => row.pay_after)));
  const addedHours = round2(
    sumMoney(eligible.filter((row) => row.status === "closed" && row.hours > 0).map((row) => row.hours))
  );
  const tokenPayload = {
    kind: "attendance_rate",
    employee_id: emp.id,
    from,
    to,
    hourly_rate: rate,
    note,
    eligible: eligible.map((row) => ({ id: row.id, snapshot: row.hourly_rate_snapshot })),
    blocked_ids: blocked.map((row) => row.id).sort((a, b) => a - b),
  };
  return {
    employee_id: emp.id,
    name: emp.name,
    from,
    to,
    hourly_rate: rate,
    note,
    recorded_hours: attendance.recorded_hours,
    payable_hours_before: payableHoursBefore,
    payable_pay_before: payableBefore,
    payable_hours_after: round2(payableHoursBefore + addedHours),
    payable_pay_after: round2(payableBefore + addedPay),
    eligible,
    preserved,
    blocked,
    preview_token: previewToken(tokenPayload),
    token_payload: tokenPayload,
  };
}

export async function previewAttendanceRateCorrection(db, employeeId, body) {
  const preview = await loadRateCorrection(db, Number(employeeId), body);
  const { token_payload: _token, ...publicPreview } = preview;
  return publicPreview;
}

export async function applyAttendanceRateCorrection(db, employeeId, body, req) {
  const token = String(body?.preview_token || "").trim();
  if (!token) throw badRequest("معاينة التصحيح مطلوبة قبل التطبيق", "PREVIEW_REQUIRED");
  return withTransaction(db, async () => {
    const preview = await loadRateCorrection(db, Number(employeeId), body);
    if (preview.preview_token !== token) {
      throw conflict("تغيّرت الجلسات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
    }
    if (!preview.eligible.length) {
      return { ...stripToken(preview), applied_count: 0, unchanged: true };
    }
    const ids = [];
    for (const row of preview.eligible) {
      const current = await db.get(
        `SELECT id, employee_id, status, punch_type, hourly_rate_snapshot
         FROM attendance_interpreted_punches WHERE id = ?`,
        [row.id]
      );
      if (
        !current ||
        Number(current.employee_id) !== preview.employee_id ||
        current.status !== "active" ||
        current.punch_type !== "in" ||
        !snapshotMissing(current.hourly_rate_snapshot)
      ) {
        throw conflict("تغيّرت الجلسات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
      }
      const updated = await db.run(
        `UPDATE attendance_interpreted_punches
         SET hourly_rate_snapshot = ?
         WHERE id = ? AND employee_id = ? AND status = 'active' AND punch_type = 'in'
           AND (hourly_rate_snapshot IS NULL OR hourly_rate_snapshot <= 0)`,
        [preview.hourly_rate, row.id, preview.employee_id]
      );
      if (!updated.changes) {
        throw conflict("تغيّرت الجلسات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
      }
      ids.push(row.id);
    }
    await logAudit(
      db,
      req,
      AUDIT_ACTIONS.ATTENDANCE_RATE_CORRECTION,
      "employees",
      preview.employee_id,
      { punch_ids: ids, hourly_rate_snapshot: null },
      {
        punch_ids: ids,
        hourly_rate_snapshot: preview.hourly_rate,
        from: preview.from,
        to: preview.to,
        note: preview.note,
        preserved_ids: preview.preserved.map((row) => row.id),
        blocked_ids: preview.blocked.map((row) => row.id),
      }
    );
    return { ...stripToken(preview), applied_count: ids.length, unchanged: false };
  });
}

function stripToken(preview) {
  const { token_payload: _token, ...rest } = preview;
  return rest;
}

const EMPLOYEE_HISTORY = [
  ["attendance_interpreted_punches", "employee_id", "بصمات مفسّرة"],
  ["employee_device_mappings", "employee_id", "ربط جهاز"],
  ["employee_salary_periods", "employee_id", "فترات راتب"],
  ["employee_ledger_entries", "employee_id", "دفتر الموظف"],
  ["employee_settlements", "employee_id", "تسويات"],
  ["advance_requests", "employee_id", "سلف على سجل الموظف"],
  ["employee_compensation", "employee_id", "سجل معدلات"],
  ["employee_salary_entitlements", "employee_id", "استحقاقات"],
  ["employee_opening_balances", "employee_id", "أرصدة افتتاحية"],
  ["employee_events", "employee_id", "حركات الموظف"],
  ["attendance_sessions", "employee_id", "جلسات حضور الكشك"],
  ["employee_period_device_sessions", "employee_id", "جلسات مرحلة للراتب"],
  ["employee_payroll_payouts", "employee_id", "دفعات راتب"],
  ["transactions", "employee_id", "مبيعات على سجل الموظف"],
  ["on_account_requests", "employee_id", "طلبات ذمة"],
];

const USER_HISTORY = [
  ["cashier_shifts", "cashier_id", "ورديات نقطة البيع"],
  ["attendance_sessions", "user_id", "جلسات حضور الكشك"],
  ["attendance_punches", "user_id", "بصمات الكشك"],
  ["advance_requests", "cashier_id", "سلف على الحساب"],
];

async function historyCounts(db, specs, id) {
  const counts = {};
  for (const [table, column, label] of specs) {
    counts[table + "." + column] = {
      label,
      count: await countOf(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [id]),
    };
  }
  return counts;
}

function blockingEntries(counts) {
  return Object.entries(counts)
    .filter(([, row]) => row.count > 0)
    .map(([key, row]) => ({ key, label: row.label, count: row.count }));
}

async function loadAccountRelink(db, targetEmployeeId, body) {
  const note = requireNote(body?.note);
  const sourceId = Number(body?.source_employee_id);
  const targetId = Number(targetEmployeeId);
  if (!sourceId || !targetId) throw badRequest("حدد سجل الموظف الفارغ والسجل المراد الإبقاء عليه");
  if (sourceId === targetId) throw badRequest("لا يمكن نقل الحساب إلى نفس السجل");

  const target = await db.get(
    `SELECT e.*, u.username AS user_username, u.role AS user_role, u.hourly_rate AS linked_user_hourly_rate
     FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
    [targetId]
  );
  const source = await db.get(
    `SELECT e.*, u.username AS user_username, u.role AS user_role, u.hourly_rate AS linked_user_hourly_rate
     FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
    [sourceId]
  );
  if (!target) throw notFound("الموظف المراد الإبقاء عليه غير موجود");
  if (!source) throw notFound("سجل الموظف المصدر غير موجود");

  const blocks = [];
  if (!source.user_id) {
    blocks.push({ code: "SOURCE_HAS_NO_LOGIN", message: "السجل المصدر بلا حساب دخول" });
  }
  if (target.user_id && Number(target.user_id) !== Number(source.user_id)) {
    blocks.push({ code: "TARGET_HAS_LOGIN", message: "السجل المراد الإبقاء عليه مربوط بحساب آخر" });
  }
  if (source.user_id && source.user_role && !ATTENDANCE_ROLES.includes(source.user_role)) {
    blocks.push({
      code: "USER_NOT_LINKABLE",
      message: "يُنقل حساب الكاشير أو المخبز أو الرفوف فقط",
    });
  }
  const other = source.user_id
    ? await db.get("SELECT id FROM employees WHERE user_id = ? AND id != ? AND id != ?", [
        source.user_id,
        source.id,
        target.id,
      ])
    : null;
  if (other) {
    blocks.push({ code: "AMBIGUOUS_LOGIN", message: "هذا الحساب مربوط بأكثر من سجل" });
  }

  const sourceHistory = await historyCounts(db, EMPLOYEE_HISTORY, source.id);
  const intended = await countOf(
    db,
    "SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE intended_employee_id = ?",
    [source.id]
  );
  if (intended) sourceHistory["employee_ledger_entries.intended_employee_id"] = { label: "دفتر موجّه للسجل", count: intended };
  for (const row of blockingEntries(sourceHistory)) {
    blocks.push({
      code: "SOURCE_EMPLOYEE_HISTORY",
      message: `السجل المصدر فيه ${row.label} (${row.count}) ويحتاج مراجعة مالية`,
      ...row,
    });
  }
  if (source.customer_id) {
    blocks.push({ code: "SOURCE_DEBT_ACCOUNT", message: "السجل المصدر مربوط بحساب ذمة" });
  }
  if (source.wage_basis || (source.hourly_rate != null && Number(source.hourly_rate) > 0) || (source.daily_rate != null && Number(source.daily_rate) > 0)) {
    blocks.push({ code: "SOURCE_WAGE", message: "السجل المصدر فيه إعداد أجر. لا يُنقل الحساب تلقائياً" });
  }

  const userHistory = source.user_id ? await historyCounts(db, USER_HISTORY, source.user_id) : {};
  for (const row of blockingEntries(userHistory)) {
    blocks.push({
      code: "SOURCE_USER_HISTORY",
      message: `الحساب فيه ${row.label} (${row.count}) ويحتاج مراجعة`,
      ...row,
    });
  }

  const sales = source.user_id
    ? await countOf(db, "SELECT COUNT(*) AS n FROM transactions WHERE cashier_id = ?", [source.user_id])
    : 0;
  const faces = source.user_id
    ? await countOf(db, "SELECT COUNT(*) AS n FROM face_descriptors WHERE user_id = ?", [source.user_id])
    : 0;

  const mirrorRate = target.wage_basis === "daily" ? null : target.hourly_rate == null ? null : Number(target.hourly_rate);
  const tokenPayload = {
    kind: "account_relink",
    target_id: target.id,
    source_id: source.id,
    user_id: source.user_id ?? null,
    target_user_id: target.user_id ?? null,
    target_hourly_rate: target.hourly_rate == null ? null : Number(target.hourly_rate),
    target_wage_basis: target.wage_basis || null,
    note,
    blocks: blocks.map((row) => row.code).sort(),
    source_counts: Object.fromEntries(Object.entries(sourceHistory).map(([key, row]) => [key, row.count])),
    user_counts: Object.fromEntries(Object.entries(userHistory).map(([key, row]) => [key, row.count])),
  };

  return {
    blocked: blocks.length > 0,
    blocks,
    note,
    preview_token: previewToken(tokenPayload),
    token_payload: tokenPayload,
    source: {
      id: source.id,
      name: source.name,
      user_id: source.user_id ?? null,
      username: source.user_username || null,
      role: source.user_role || null,
    },
    target: {
      id: target.id,
      name: target.name,
      user_id: target.user_id ?? null,
      username: target.user_username || null,
      wage_basis: target.wage_basis || null,
      hourly_rate: target.hourly_rate == null ? null : Number(target.hourly_rate),
    },
    proposed: blocks.length
      ? null
      : {
          move_user_id: source.user_id,
          from_employee_id: source.id,
          to_employee_id: target.id,
          login_hourly_rate: mirrorRate,
          keeps_target_id: true,
          leaves_source_row: true,
          rewrites_snapshots: false,
        },
    informational: {
      cashier_sales: sales,
      face_descriptors: faces,
    },
  };
}

export async function previewAccountRelink(db, targetEmployeeId, body) {
  const preview = await loadAccountRelink(db, targetEmployeeId, body);
  return stripToken(preview);
}

export async function applyAccountRelink(db, targetEmployeeId, body, req) {
  const token = String(body?.preview_token || "").trim();
  if (!token) throw badRequest("معاينة نقل الحساب مطلوبة قبل التطبيق", "PREVIEW_REQUIRED");
  return withTransaction(db, async () => {
    const preview = await loadAccountRelink(db, targetEmployeeId, body);
    if (preview.preview_token !== token) {
      throw conflict("تغيّرت السجلات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
    }
    if (preview.blocked) {
      throw conflict(preview.blocks[0]?.message || "لا يمكن نقل الحساب", preview.blocks[0]?.code || "RELINK_BLOCKED");
    }
    const userId = preview.proposed.move_user_id;
    const cleared = await db.run(
      "UPDATE employees SET user_id = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      [preview.source.id, userId]
    );
    if (!cleared.changes) {
      throw conflict("تغيّرت السجلات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
    }
    const linked = await db.run(
      "UPDATE employees SET user_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id IS NULL",
      [userId, preview.target.id]
    );
    if (!linked.changes) {
      throw conflict("تغيّرت السجلات منذ المعاينة. أعد المعاينة قبل التطبيق.", "STALE_PREVIEW");
    }
    await db.run("UPDATE users SET hourly_rate = ? WHERE id = ?", [preview.proposed.login_hourly_rate, userId]);
    await logAudit(
      db,
      req,
      AUDIT_ACTIONS.EMPLOYEE_ACCOUNT_RELINK,
      "employees",
      preview.target.id,
      {
        source_employee_id: preview.source.id,
        source_user_id: userId,
        target_user_id: null,
        target_hourly_rate: preview.target.hourly_rate,
      },
      {
        source_employee_id: preview.source.id,
        target_employee_id: preview.target.id,
        user_id: userId,
        login_hourly_rate: preview.proposed.login_hourly_rate,
        note: preview.note,
        snapshots_rewritten: false,
      }
    );
    return stripToken(preview);
  });
}

async function activeMapping(db, employeeId) {
  return db.get(
    `SELECT device_user_id, device_key
     FROM employee_device_mappings
     WHERE employee_id = ? AND active = 1
     ORDER BY id DESC LIMIT 1`,
    [employeeId]
  );
}

async function nameCandidates(db, employee) {
  const rows = await db.all(
    `SELECT id, name, user_id FROM employees
     WHERE id != ? AND lower(trim(name)) = lower(trim(?))
     ORDER BY id`,
    [employee.id, employee.name]
  );
  const out = [];
  for (const row of rows) {
    const punches = await countOf(
      db,
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ?",
      [row.id]
    );
    const money = await countOf(
      db,
      `SELECT
         (SELECT COUNT(*) FROM employee_ledger_entries WHERE employee_id = ?)
         + (SELECT COUNT(*) FROM employee_salary_periods WHERE employee_id = ?)
         + (SELECT COUNT(*) FROM advance_requests WHERE employee_id = ?)
         + (SELECT COUNT(*) FROM employee_settlements WHERE employee_id = ?) AS n`,
      [row.id, row.id, row.id, row.id]
    );
    out.push({
      id: row.id,
      name: row.name,
      user_id: row.user_id ?? null,
      has_punches: punches > 0,
      has_financial: money > 0,
    });
  }
  return out;
}

export async function attendanceDiagnosticsForEmployee(db, employeeId) {
  const row = await db.get(
    `SELECT e.*, u.username AS user_username, u.role AS user_role, u.hourly_rate AS linked_user_hourly_rate
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [Number(employeeId)]
  );
  if (!row) throw notFound("الموظف غير موجود");
  const live = resolveLiveHourlyRate({
    wage_basis: row.wage_basis,
    hourly_rate: row.hourly_rate,
    linked_user_hourly_rate: row.linked_user_hourly_rate,
  });
  const attendance = await buildPayableAttendance(db, row.id);
  const dailyWage = row.wage_basis === "daily";
  const missing = [];
  if (!dailyWage) {
    for (const session of attendance.sessions || []) {
      if (!session.flags?.includes("missing_snapshot")) continue;
      missing.push({
        in_punch_id: session.in_punch_id,
        shop_start_on: session.shop_start_on,
        check_in_at: session.check_in_at,
        hours: session.hours,
        status: session.status,
      });
    }
  }
  const periods = await savedSalaryPeriods(db, row.id);
  const mapping = await activeMapping(db, row.id);
  const readiness = payrollReadiness({
    id: row.id,
    wage_basis: row.wage_basis,
    hourly_rate: row.hourly_rate,
    linked_user_hourly_rate: row.linked_user_hourly_rate,
    missing_snapshot_count: dailyWage ? 0 : attendance.missing_snapshot_count,
  });
  return {
    employee_id: row.id,
    name: row.name,
    user_id: row.user_id ?? null,
    username: row.user_username || null,
    role: row.user_role || null,
    wage_basis: row.wage_basis || null,
    hourly_rate: live,
    stored_hourly_rate: row.hourly_rate == null ? null : Number(row.hourly_rate),
    daily_rate: row.daily_rate == null ? null : Number(row.daily_rate),
    device_user_id: mapping?.device_user_id || null,
    device_key: mapping?.device_key || null,
    device_mapped: Boolean(mapping),
    recorded_hours: attendance.recorded_hours,
    payable_hours: attendance.posted_hours,
    payable_pay: attendance.posted_pay,
    missing_snapshots: missing,
    missing_snapshot_dates: [...new Set(missing.map((item) => item.shop_start_on).filter(Boolean))],
    salary_periods: periods.map((period) => ({
      id: period.id,
      period_from: period.period_from,
      period_to: period.period_to,
      status: period.status,
      salary_saved: period.salary_before_deductions != null,
    })),
    name_candidates: await nameCandidates(db, row),
    ...readiness,
  };
}

export async function attendanceDiagnostics(db, employeeId = null) {
  if (employeeId) return attendanceDiagnosticsForEmployee(db, employeeId);
  const rows = await db.all("SELECT id FROM employees ORDER BY id");
  const items = [];
  for (const row of rows) items.push(await attendanceDiagnosticsForEmployee(db, row.id));
  return { items };
}
