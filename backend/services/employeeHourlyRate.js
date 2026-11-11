import { round2 } from "../utils/money.js";
import { badRequest } from "../utils/httpError.js";

export const EMPLOYEE_HOURLY_RATE_BACKFILL_KEY = "employee_hourly_rate_backfill_v1";

export function positiveRateOrNull(value) {
  if (value == null || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return round2(rate);
}

/**
 * Current clock rate for new snapshots.
 * Daily wage is not an hourly rate.
 * An explicit employee column wins, including zero.
 * A still-null column may read the linked user rate so rows written before
 * the employee column existed stay payable. Writers keep the two columns together.
 */
export function resolveLiveHourlyRate(row) {
  if (!row || row.wage_basis === "daily") return null;
  const own = row.stored_hourly_rate !== undefined ? row.stored_hourly_rate : row.hourly_rate;
  if (own != null && own !== "") {
    const rate = Number(own);
    if (!Number.isFinite(rate) || rate < 0) return null;
    return round2(rate);
  }
  return positiveRateOrNull(row.linked_user_hourly_rate ?? row.user_hourly_rate);
}

export function withLiveHourlyRate(row) {
  if (!row) return row;
  const stored = row.stored_hourly_rate !== undefined ? row.stored_hourly_rate : row.hourly_rate;
  return {
    ...row,
    stored_hourly_rate: stored,
    hourly_rate: resolveLiveHourlyRate({ ...row, stored_hourly_rate: stored }),
  };
}

export function payrollReadiness(row) {
  const employeeId = row?.employee_id ?? row?.id ?? null;
  if (!employeeId) {
    return {
      payroll_ready: false,
      payroll_readiness: "no_employee",
      payroll_readiness_label: "بلا سجل موظف",
    };
  }
  if (row.wage_basis === "daily") {
    return {
      payroll_ready: false,
      payroll_readiness: "daily",
      payroll_readiness_label: "أجر يومي — الحضور للعلم فقط",
    };
  }
  const rate = resolveLiveHourlyRate(row);
  if (!(rate > 0)) {
    return {
      payroll_ready: false,
      payroll_readiness: "missing_rate",
      payroll_readiness_label: "لا يوجد أجر ساعة",
    };
  }
  if (Number(row.missing_snapshot_count) > 0) {
    return {
      payroll_ready: false,
      payroll_readiness: "missing_snapshot",
      payroll_readiness_label: "جلسات بلا أجر محفوظ",
    };
  }
  return {
    payroll_ready: true,
    payroll_readiness: "ready",
    payroll_readiness_label: "جاهز للأجر",
  };
}

/**
 * Write the employee clock rate and, when a login is linked, the same value on the user.
 * Caller must already hold the transaction when this runs beside other writes.
 */
export async function writeEmployeeHourlyRateInTx(db, { employeeId = null, userId = null, rate }) {
  const stored = rate == null || rate === "" ? null : round2(Number(rate));
  if (stored != null && (!Number.isFinite(stored) || stored < 0)) {
    throw badRequest("أجر الساعة يجب أن يكون رقماً موجباً أو صفراً");
  }
  let employee = null;
  if (employeeId) {
    employee = await db.get("SELECT id, user_id FROM employees WHERE id = ?", [employeeId]);
  } else if (userId) {
    employee = await db.get("SELECT id, user_id FROM employees WHERE user_id = ?", [userId]);
  }
  const linkedUserId = Number(userId) || employee?.user_id || null;
  if (employee) {
    await db.run("UPDATE employees SET hourly_rate = ?, updated_at = datetime('now') WHERE id = ?", [
      stored,
      employee.id,
    ]);
  }
  if (linkedUserId) {
    await db.run("UPDATE users SET hourly_rate = ? WHERE id = ?", [stored, linkedUserId]);
  }
  return {
    employee_id: employee?.id ?? null,
    user_id: linkedUserId,
    hourly_rate: stored,
  };
}

/**
 * After an explicit link, copy a stored employee rate onto the login.
 * If the employee rate was never set, copy a positive login rate once.
 * Daily wage is left untouched.
 */
export async function syncLinkedRatesInTx(db, employeeId) {
  const row = await db.get(
    `SELECT e.id, e.user_id, e.hourly_rate, e.wage_basis, u.hourly_rate AS user_rate
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [employeeId]
  );
  if (!row?.user_id || row.wage_basis === "daily") return;
  if (row.hourly_rate != null) {
    await db.run("UPDATE users SET hourly_rate = ? WHERE id = ?", [row.hourly_rate, row.user_id]);
    return;
  }
  const userRate = positiveRateOrNull(row.user_rate);
  if (userRate == null) return;
  await db.run(
    `UPDATE employees
     SET hourly_rate = ?, updated_at = datetime('now')
     WHERE id = ? AND hourly_rate IS NULL AND (wage_basis IS NULL OR wage_basis = 'hourly')`,
    [userRate, row.id]
  );
}

/**
 * One-way copy of a positive login rate onto a linked employee whose rate is still empty.
 * Daily employees and any already saved employee rate are left as they are.
 */
export async function copyLinkedUserHourlyRates(db) {
  await db.run(
    `UPDATE employees
     SET hourly_rate = (
           SELECT u.hourly_rate FROM users u WHERE u.id = employees.user_id
         ),
         updated_at = datetime('now')
     WHERE user_id IS NOT NULL
       AND hourly_rate IS NULL
       AND (wage_basis IS NULL OR wage_basis = 'hourly')
       AND EXISTS (
         SELECT 1 FROM users u
         WHERE u.id = employees.user_id
           AND u.hourly_rate IS NOT NULL
           AND u.hourly_rate > 0
       )`
  );
}

export async function migrateEmployeeHourlyRateData(db) {
  const done = await db.get("SELECT value FROM app_settings WHERE key = ?", [
    EMPLOYEE_HOURLY_RATE_BACKFILL_KEY,
  ]);
  if (done) return { copied: false };
  await copyLinkedUserHourlyRates(db);
  await db.run("INSERT INTO app_settings (key, value) VALUES (?, '1')", [
    EMPLOYEE_HOURLY_RATE_BACKFILL_KEY,
  ]);
  return { copied: true };
}
