import { HttpError } from "../utils/httpError.js";
import { ATTENDANCE_ROLES } from "../utils/roles.js";
import {
  addShopDays,
  shopYmdInRange,
  shopYmdRangeToUtcBounds,
} from "../utils/shopTime.js";
import { round2 } from "../utils/money.js";

export { round2 };

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
 * @param {unknown} body
 * @returns {{ provided: boolean, value?: unknown }}
 */
export function readHourlyRateInput(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "hourly_rate")) {
    return { provided: false };
  }
  const raw = body.hourly_rate;
  if (raw === "" || raw === null || raw === undefined) {
    return { provided: false };
  }
  return { provided: true, value: raw };
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
 * Closed shifts without a captured rate stay incomplete. Today's rate is not
 * copied onto them.
 * @param {object} db
 * @param {number} userId
 */
export async function fillMissingClosedShiftSnapshots(db, userId) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");
  const user = await db.get("SELECT id FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "المستخدم غير موجود");
  throw new HttpError(
    409,
    "لا يُنسخ أجر اليوم على وردية قديمة بلا أجر محفوظ. الأجر يبقى غير مكتمل."
  );
}

/**
 * @param {object} db
 */
export async function listCashiersOnly(db) {
  return db.all(
    `SELECT id, username, hourly_rate, role
     FROM users
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
    SELECT s.id AS shift_id, s.cashier_id, u.username,
           s.hourly_rate_snapshot AS hourly_rate,
           s.business_day, s.start_time, s.end_time, s.status
    FROM cashier_shifts s
    JOIN users u ON u.id = s.cashier_id
    WHERE s.end_time IS NOT NULL
      AND (
        (s.business_day IS NOT NULL AND s.business_day >= ? AND s.business_day <= ?)
        OR (
          s.business_day IS NULL
          AND datetime(s.start_time) >= datetime(?)
          AND datetime(s.start_time) <= datetime(?)
        )
      )`;
  const params = [from, to, startSql, endSql];

  const cid =
    cashierId != null && String(cashierId).trim() !== "" ? Number(cashierId) : null;
  if (cid && !Number.isNaN(cid)) {
    sql += " AND s.cashier_id = ?";
    params.push(cid);
  }

  sql += " ORDER BY u.username COLLATE NOCASE, datetime(s.start_time) ASC, s.id ASC";

  const rows = (await db.all(sql, params)).filter((row) => {
    const assigned = typeof row.business_day === "string" ? row.business_day.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(assigned)) return assigned >= from && assigned <= to;
    return shopYmdInRange(row.start_time, from, to);
  });

  /** @type {Map<number, object>} */
  const byCashier = new Map();

  for (const row of rows) {
    const hours = shiftHours(row.start_time, row.end_time);
    const rateKnown = row.hourly_rate != null && Number(row.hourly_rate) > 0;
    const pay = rateKnown ? shiftPay(row.hourly_rate, hours) : null;
    const shift = {
      shift_id: row.shift_id,
      start_time: row.start_time,
      end_time: row.end_time,
      status: row.status,
      hours,
      hourly_rate: rateKnown ? Number(row.hourly_rate) : null,
      pay,
      rate_known: rateKnown,
    };

    let entry = byCashier.get(row.cashier_id);
    if (!entry) {
      entry = {
        cashier_id: row.cashier_id,
        username: row.username,
        hourly_rate: rateKnown ? Number(row.hourly_rate) : null,
        total_hours: 0,
        total_pay: rateKnown ? 0 : null,
        missing_rate: !rateKnown,
        shifts: [],
      };
      byCashier.set(row.cashier_id, entry);
    }

    entry.shifts.push(shift);
    entry.total_hours = round2(entry.total_hours + hours);
    if (!rateKnown) {
      entry.missing_rate = true;
      entry.total_pay = null;
    } else if (entry.total_pay != null) {
      entry.total_pay = round2(entry.total_pay + pay);
      if (entry.hourly_rate == null) entry.hourly_rate = Number(row.hourly_rate);
    }
  }

  const employees = [...byCashier.values()].sort((a, b) =>
    String(a.username).localeCompare(String(b.username), "ar")
  );

  let grandTotalHours = 0;
  let grandTotalPay = 0;
  let payIncomplete = false;
  for (const e of employees) {
    grandTotalHours = round2(grandTotalHours + e.total_hours);
    if (e.missing_rate || e.total_pay == null) payIncomplete = true;
    else grandTotalPay = round2(grandTotalPay + e.total_pay);
  }

  return {
    date_from: from,
    date_to: to,
    employees,
    grand_total_hours: grandTotalHours,
    grand_total_pay: payIncomplete ? null : grandTotalPay,
    pay_incomplete: payIncomplete,
  };
}
