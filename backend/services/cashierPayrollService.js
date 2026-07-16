import { HttpError } from "../utils/httpError.js";
import { ATTENDANCE_ROLES } from "../utils/roles.js";
import {
  addShopDays,
  shopYmdInRange,
  shopYmdRangeToUtcBounds,
} from "../utils/shopTime.js";

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Parse a timestamp to epoch ms. Timestamps in this app come from two sources:
 * SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) and
 * JS `new Date().toISOString()` → "...Z". Without normalizing, Date.parse treats
 * the space-format string as *local* time, creating a phantom offset (e.g. a few
 * seconds reading as ~3 hours on a UTC+3 machine). SQLite emits UTC, so we treat
 * the space-format string as UTC explicitly.
 * @param {string|null|undefined} ts
 * @returns {number} epoch ms, or NaN if unparseable
 */
export function parseTimestampMs(ts) {
  if (typeof ts !== "string") return NaN;
  const trimmed = ts.trim();
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  return Date.parse(trimmed);
}

/**
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number} hours rounded to 2 decimals
 */
export function shiftHours(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const start = parseTimestampMs(startIso);
  const end = parseTimestampMs(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return round2((end - start) / 3_600_000);
}

/**
 * @param {number|null|undefined} hourlyRate
 * @param {number} hours
 * @returns {number}
 */
export function shiftPay(hourlyRate, hours) {
  const rate = Number(hourlyRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return round2(rate * hours);
}

function parseDateYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

/**
 * @param {object} db
 */
export async function listEmployees(db) {
  const placeholders = ATTENDANCE_ROLES.map(() => "?").join(", ");
  return db.all(
    `SELECT id, username, role, hourly_rate
     FROM users
     WHERE role IN (${placeholders})
     ORDER BY username COLLATE NOCASE`,
    ATTENDANCE_ROLES
  );
}

/** @deprecated Use listEmployees */
export async function listCashiers(db) {
  return listEmployees(db);
}

/**
 * @param {object} db
 * @param {number} userId
 * @param {number} hourlyRate
 */
export async function updateEmployeeHourlyRate(db, userId, hourlyRate) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");

  const rate = Number(hourlyRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new HttpError(400, "أجر الساعة يجب أن يكون رقماً موجباً أو صفراً");
  }

  const user = await db.get("SELECT id, username, role, hourly_rate FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "المستخدم غير موجود");
  if (!ATTENDANCE_ROLES.includes(user.role)) {
    throw new HttpError(400, "أجر الساعة يُحدَّد لموظفي المتجر فقط");
  }

  await db.run("UPDATE users SET hourly_rate = ? WHERE id = ?", [round2(rate), id]);
  return db.get(
    "SELECT id, username, role, hourly_rate FROM users WHERE id = ?",
    [id]
  );
}

/** @deprecated Use updateEmployeeHourlyRate */
export async function updateCashierHourlyRate(db, userId, hourlyRate) {
  return updateEmployeeHourlyRate(db, userId, hourlyRate);
}

/**
 * @param {object} db
 */
export async function listCashiersOnly(db) {
  return db.all(
    `SELECT id, username, hourly_rate
     FROM users
     WHERE role = 'cashier'
     ORDER BY username COLLATE NOCASE`
  );
}

/**
 * @param {object} db
 * @param {{ dateFrom: string, dateTo: string, cashierId?: number|null }} opts
 */
export async function buildPayrollReport(db, { dateFrom, dateTo, cashierId = null }) {
  const from = parseDateYmd(dateFrom);
  const to = parseDateYmd(dateTo);
  if (!from || !to) {
    throw new HttpError(400, "تاريخ البداية والنهاية مطلوبان بصيغة YYYY-MM-DD");
  }
  if (from > to) {
    throw new HttpError(400, "تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
  }

  const fetchFrom = addShopDays(from, -1) || from;
  const fetchTo = addShopDays(to, 1) || to;
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fetchFrom, fetchTo);
  const startSql = startIso.replace("T", " ").slice(0, 19);
  const endSql = endIso.replace("T", " ").slice(0, 19);

  let sql = `
    SELECT s.id AS shift_id, s.cashier_id, u.username, u.hourly_rate,
           s.start_time, s.end_time, s.status
    FROM cashier_shifts s
    JOIN users u ON u.id = s.cashier_id
    WHERE u.role = 'cashier'
      AND s.end_time IS NOT NULL
      AND datetime(s.start_time) >= datetime(?)
      AND datetime(s.start_time) <= datetime(?)`;
  const params = [startSql, endSql];

  const cid =
    cashierId != null && String(cashierId).trim() !== "" ? Number(cashierId) : null;
  if (cid && !Number.isNaN(cid)) {
    sql += " AND s.cashier_id = ?";
    params.push(cid);
  }

  sql += " ORDER BY u.username COLLATE NOCASE, datetime(s.start_time) ASC, s.id ASC";

  const rows = (await db.all(sql, params)).filter((row) =>
    shopYmdInRange(row.start_time, from, to)
  );

  /** @type {Map<number, object>} */
  const byCashier = new Map();

  for (const row of rows) {
    const hours = shiftHours(row.start_time, row.end_time);
    const pay = shiftPay(row.hourly_rate, hours);
    const shift = {
      shift_id: row.shift_id,
      start_time: row.start_time,
      end_time: row.end_time,
      status: row.status,
      hours,
      pay,
    };

    let entry = byCashier.get(row.cashier_id);
    if (!entry) {
      entry = {
        cashier_id: row.cashier_id,
        username: row.username,
        hourly_rate: row.hourly_rate,
        total_hours: 0,
        total_pay: 0,
        missing_rate: row.hourly_rate == null || Number(row.hourly_rate) <= 0,
        shifts: [],
      };
      byCashier.set(row.cashier_id, entry);
    }

    entry.shifts.push(shift);
    entry.total_hours = round2(entry.total_hours + hours);
    entry.total_pay = round2(entry.total_pay + pay);
    if (row.hourly_rate == null || Number(row.hourly_rate) <= 0) {
      entry.missing_rate = true;
    }
  }

  const employees = [...byCashier.values()].sort((a, b) =>
    String(a.username).localeCompare(String(b.username), "ar")
  );

  let grandTotalHours = 0;
  let grandTotalPay = 0;
  for (const e of employees) {
    grandTotalHours = round2(grandTotalHours + e.total_hours);
    grandTotalPay = round2(grandTotalPay + e.total_pay);
  }

  return {
    date_from: from,
    date_to: to,
    employees,
    grand_total_hours: grandTotalHours,
    grand_total_pay: grandTotalPay,
  };
}
