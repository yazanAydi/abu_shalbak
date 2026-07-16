import { HttpError } from "../utils/httpError.js";
import { ATTENDANCE_ROLES, PUNCH_ROLES } from "../utils/roles.js";
import {
  addShopDays,
  shopYmdInRange,
  shopYmdRangeToUtcBounds,
} from "../utils/shopTime.js";
import {
  round2,
  shiftHours,
  shiftPay,
  parseTimestampMs,
} from "./cashierPayrollService.js";
const ROLE_LABELS_AR = {
  cashier: "كاشير",
  bakery_employee: "موظف مخبز",
  shelves_employee: "موظف رفوف",
};

/** Minimum seconds between kiosk punches for the same employee */
export const MIN_PUNCH_INTERVAL_SECONDS = 30;

const PUNCH_TYPES = new Set(["in", "out"]);

function parseDateYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

function attendanceRolePlaceholders() {
  return ATTENDANCE_ROLES.map(() => "?").join(", ");
}

function isValidDescriptor(desc) {
  if (!Array.isArray(desc) || desc.length < 64) return false;
  return desc.every((n) => typeof n === "number" && Number.isFinite(n));
}


function normalizePunchTimeInput(value) {
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2].padEnd(8, "0").slice(0, 8);
  return `${m[1]} ${time}`;
}

function utcNowSql() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function secondsSincePunch(punchTime) {
  const ms = parseTimestampMs(punchTime);
  if (Number.isNaN(ms)) return Infinity;
  return (Date.now() - ms) / 1000;
}

async function getPunchEmployee(db, userId) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");

  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "المستخدم غير موجود");
  if (!PUNCH_ROLES.includes(user.role)) {
    throw new HttpError(400, "هذا الموظف لا يستخدم سجل الحضور بالوجه");
  }
  return user;
}

async function getLastPunchRow(db, userId) {
  return db.get(
    `SELECT id, user_id, punch_time, type, source FROM attendance_punches
     WHERE user_id = ?
     ORDER BY datetime(punch_time) DESC, id DESC LIMIT 1`,
    [userId]
  );
}

function nextPunchType(lastType) {
  return lastType === "in" ? "out" : "in";
}

/**
 * Pair sequential in/out punches into work sessions.
 * @param {Array<{ punch_time: string, type: string }>} punches
 */
export function pairPunchesToSessions(punches) {
  const sessions = [];
  let openIn = null;

  for (const p of punches) {
    if (p.type === "in") {
      if (openIn) {
        sessions.push({
          start_time: openIn.punch_time,
          end_time: null,
          hours: 0,
          incomplete: true,
        });
      }
      openIn = p;
    } else if (p.type === "out" && openIn) {
      const hours = shiftHours(openIn.punch_time, p.punch_time);
      sessions.push({
        start_time: openIn.punch_time,
        end_time: p.punch_time,
        hours,
        incomplete: false,
      });
      openIn = null;
    }
  }

  if (openIn) {
    sessions.push({
      start_time: openIn.punch_time,
      end_time: null,
      hours: 0,
      incomplete: true,
    });
  }

  return sessions;
}

/**
 * @param {object} db
 */
export async function listAttendanceEmployees(db) {
  const placeholders = attendanceRolePlaceholders();
  const rows = await db.all(
    `SELECT u.id, u.username, u.role, u.hourly_rate,
            (SELECT COUNT(*) FROM face_descriptors fd WHERE fd.user_id = u.id) AS face_count
     FROM users u
     WHERE u.role IN (${placeholders})
     ORDER BY u.username COLLATE NOCASE`,
    ATTENDANCE_ROLES
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    role_label: ROLE_LABELS_AR[r.role] || r.role,
    hourly_rate: r.hourly_rate,
    face_enrolled: Number(r.face_count) > 0,
    face_count: Number(r.face_count) || 0,
  }));
}

/**
 * @param {object} db
 * @param {number} userId
 */
export async function recordPunch(db, userId) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");

  const user = await getPunchEmployee(db, id);

  const enrolled = await db.get(
    "SELECT COUNT(*) AS c FROM face_descriptors WHERE user_id = ?",
    [id]
  );
  if (!Number(enrolled?.c)) {
    throw new HttpError(400, "لم يتم تسجيل وجه هذا الموظف بعد");
  }

  const lastPunch = await getLastPunchRow(db, id);
  if (
    lastPunch &&
    secondsSincePunch(lastPunch.punch_time) < MIN_PUNCH_INTERVAL_SECONDS
  ) {
    return {
      punch: lastPunch,
      user: { id: user.id, username: user.username, role: user.role },
      message: "تم التسجيل مسبقاً",
      duplicate: true,
    };
  }

  const type = nextPunchType(lastPunch?.type);
  const ins = await db.run(
    `INSERT INTO attendance_punches (user_id, type, source) VALUES (?, ?, 'kiosk')`,
    [id, type]
  );

  const row = await db.get(
    `SELECT id, user_id, punch_time, type, source FROM attendance_punches WHERE id = ?`,
    [ins.lastID]
  );

  return {
    punch: row,
    user: { id: user.id, username: user.username, role: user.role },
    message: type === "in" ? "تم تسجيل الحضور" : "تم تسجيل الانصراف",
    duplicate: false,
  };
}

/**
 * @param {object} db
 * @param {{ userId: number, punchTime?: string, type: string }} opts
 */
export async function createManualPunch(db, { userId, punchTime, type }) {
  const user = await getPunchEmployee(db, userId);
  const punchType = String(type || "").trim();
  if (!PUNCH_TYPES.has(punchType)) {
    throw new HttpError(400, "نوع التسجيل يجب أن يكون in أو out");
  }

  const when = punchTime ? normalizePunchTimeInput(punchTime) : utcNowSql();
  if (!when) {
    throw new HttpError(400, "وقت التسجيل غير صالح");
  }

  const ins = await db.run(
    `INSERT INTO attendance_punches (user_id, punch_time, type, source) VALUES (?, ?, ?, 'manual')`,
    [user.id, when, punchType]
  );

  const row = await db.get(
    `SELECT id, user_id, punch_time, type, source FROM attendance_punches WHERE id = ?`,
    [ins.lastID]
  );

  return {
    punch: row,
    user: { id: user.id, username: user.username, role: user.role },
    message: punchType === "in" ? "تم إضافة تسجيل حضور" : "تم إضافة تسجيل انصراف",
  };
}

/**
 * @param {object} db
 * @param {number} punchId
 * @param {{ punchTime?: string, type?: string }} updates
 */
export async function updatePunch(db, punchId, { punchTime, type }) {
  const id = Number(punchId);
  if (!id) throw new HttpError(400, "معرّف التسجيل غير صالح");

  const existing = await db.get(
    `SELECT id, user_id, punch_time, type, source FROM attendance_punches WHERE id = ?`,
    [id]
  );
  if (!existing) throw new HttpError(404, "التسجيل غير موجود");

  const nextType = type != null ? String(type).trim() : existing.type;
  if (!PUNCH_TYPES.has(nextType)) {
    throw new HttpError(400, "نوع التسجيل يجب أن يكون in أو out");
  }

  let nextTime = existing.punch_time;
  if (punchTime != null && String(punchTime).trim() !== "") {
    const normalized = normalizePunchTimeInput(punchTime);
    if (!normalized) throw new HttpError(400, "وقت التسجيل غير صالح");
    nextTime = normalized;
  }

  await db.run(
    `UPDATE attendance_punches SET punch_time = ?, type = ? WHERE id = ?`,
    [nextTime, nextType, id]
  );

  const row = await db.get(
    `SELECT id, user_id, punch_time, type, source FROM attendance_punches WHERE id = ?`,
    [id]
  );

  return { punch: row, message: "تم تحديث التسجيل" };
}

/**
 * @param {object} db
 * @param {number} punchId
 */
export async function deletePunch(db, punchId) {
  const id = Number(punchId);
  if (!id) throw new HttpError(400, "معرّف التسجيل غير صالح");

  const existing = await db.get(
    `SELECT id FROM attendance_punches WHERE id = ?`,
    [id]
  );
  if (!existing) throw new HttpError(404, "التسجيل غير موجود");

  await db.run("DELETE FROM attendance_punches WHERE id = ?", [id]);
  return { id, deleted: true, message: "تم حذف التسجيل" };
}

/**
 * @param {object} db
 * @param {number} userId
 * @param {number[][]} descriptors
 */
export async function saveFaceDescriptors(db, userId, descriptors) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");

  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "المستخدم غير موجود");
  if (!ATTENDANCE_ROLES.includes(user.role)) {
    throw new HttpError(400, "لا يمكن تسجيل الوجه لهذا الحساب");
  }

  if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 5) {
    throw new HttpError(400, "يجب إرسال من 1 إلى 5 عينات للوجه");
  }

  for (const desc of descriptors) {
    if (!isValidDescriptor(desc)) {
      throw new HttpError(400, "بيانات الوجه غير صالحة");
    }
  }

  await db.run("BEGIN IMMEDIATE");
  try {
    await db.run("DELETE FROM face_descriptors WHERE user_id = ?", [id]);
    for (const desc of descriptors) {
      await db.run(
        `INSERT INTO face_descriptors (user_id, descriptor_json) VALUES (?, ?)`,
        [id, JSON.stringify(desc)]
      );
    }
    await db.run("COMMIT");
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }

  return {
    user_id: id,
    username: user.username,
    descriptor_count: descriptors.length,
  };
}

/**
 * @param {object} db
 * @param {number} userId
 */
export async function deleteFaceDescriptors(db, userId) {
  const id = Number(userId);
  if (!id) throw new HttpError(400, "المعرّف غير صالح");

  const user = await db.get("SELECT id FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "المستخدم غير موجود");

  await db.run("DELETE FROM face_descriptors WHERE user_id = ?", [id]);
  return { user_id: id, deleted: true };
}

/**
 * @param {object} db
 */
export async function listKioskDescriptors(db) {
  const placeholders = attendanceRolePlaceholders();
  const users = await db.all(
    `SELECT u.id, u.username, u.role
     FROM users u
     WHERE u.role IN (${placeholders})
       AND EXISTS (SELECT 1 FROM face_descriptors fd WHERE fd.user_id = u.id)
     ORDER BY u.username COLLATE NOCASE`,
    ATTENDANCE_ROLES
  );

  const result = [];
  for (const u of users) {
    const rows = await db.all(
      `SELECT descriptor_json FROM face_descriptors WHERE user_id = ? ORDER BY id ASC`,
      [u.id]
    );
    const descriptors = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.descriptor_json);
        if (isValidDescriptor(parsed)) descriptors.push(parsed);
      } catch (_) {}
    }
    if (descriptors.length) {
      const lastPunch = await getLastPunchRow(db, u.id);
      result.push({
        user_id: u.id,
        username: u.username,
        role: u.role,
        descriptors,
        last_punch_type: lastPunch?.type || null,
      });
    }
  }
  return result;
}

async function buildCashierShiftSessions(db, userId, from, to) {
  const fetchFrom = addShopDays(from, -1) || from;
  const fetchTo = addShopDays(to, 1) || to;
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fetchFrom, fetchTo);

  let sql = `
    SELECT s.id AS session_id, s.start_time, s.end_time, s.status
    FROM cashier_shifts s
    WHERE s.cashier_id = ?
      AND s.end_time IS NOT NULL
      AND datetime(s.start_time) >= datetime(?)
      AND datetime(s.start_time) <= datetime(?)
    ORDER BY datetime(s.start_time) ASC, s.id ASC`;
  const rows = await db.all(sql, [userId, startIso.replace("T", " ").slice(0, 19), endIso.replace("T", " ").slice(0, 19)]);

  return rows
    .filter((row) => shopYmdInRange(row.start_time, from, to))
    .map((row) => ({
      session_id: row.session_id,
      source: "shift",
      start_time: row.start_time,
      end_time: row.end_time,
      status: row.status,
      hours: shiftHours(row.start_time, row.end_time),
      incomplete: false,
    }));
}

async function buildPunchSessions(db, userId, from, to) {
  const fetchFrom = addShopDays(from, -1) || from;
  const fetchTo = addShopDays(to, 1) || to;
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fetchFrom, fetchTo);
  const startSql = startIso.replace("T", " ").slice(0, 19);
  const endSql = endIso.replace("T", " ").slice(0, 19);

  const punches = await db.all(
    `SELECT id, punch_time, type, source FROM attendance_punches
     WHERE user_id = ?
       AND datetime(punch_time) >= datetime(?)
       AND datetime(punch_time) <= datetime(?)
     ORDER BY datetime(punch_time) ASC, id ASC`,
    [userId, startSql, endSql]
  );

  const sessions = pairPunchesToSessions(punches)
    .filter((s) => shopYmdInRange(s.start_time, from, to))
    .map((s, idx) => ({
      session_id: `punch-${userId}-${idx}`,
      source: "punch",
      start_time: s.start_time,
      end_time: s.end_time,
      status: s.incomplete ? "open" : "closed",
      hours: s.hours,
      incomplete: s.incomplete,
    }));

  return { sessions, punches };
}
/**
 * Unified attendance report for all shop-floor employees.
 * @param {object} db
 * @param {{ dateFrom: string, dateTo: string, userId?: number|null }} opts
 */
export async function buildEmployeeAttendanceReport(db, { dateFrom, dateTo, userId = null }) {
  const from = parseDateYmd(dateFrom);
  const to = parseDateYmd(dateTo);
  if (!from || !to) {
    throw new HttpError(400, "تاريخ البداية والنهاية مطلوبان بصيغة YYYY-MM-DD");
  }
  if (from > to) {
    throw new HttpError(400, "تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
  }

  const placeholders = attendanceRolePlaceholders();
  let userSql = `SELECT id, username, role, hourly_rate FROM users WHERE role IN (${placeholders})`;
  const userParams = [...ATTENDANCE_ROLES];

  const uid =
    userId != null && String(userId).trim() !== "" ? Number(userId) : null;
  if (uid && !Number.isNaN(uid)) {
    userSql += " AND id = ?";
    userParams.push(uid);
  }
  userSql += " ORDER BY username COLLATE NOCASE";

  const users = await db.all(userSql, userParams);
  const employees = [];

  for (const user of users) {
    let sessions = [];
    let punches = [];
    if (user.role === "cashier") {
      sessions = await buildCashierShiftSessions(db, user.id, from, to);
    } else if (PUNCH_ROLES.includes(user.role)) {
      const punchData = await buildPunchSessions(db, user.id, from, to);
      sessions = punchData.sessions;
      punches = punchData.punches;
    }

    let totalHours = 0;
    let totalPay = 0;
    for (const s of sessions) {
      totalHours = round2(totalHours + (s.hours || 0));
      totalPay = round2(totalPay + shiftPay(user.hourly_rate, s.hours || 0));
    }

    employees.push({
      user_id: user.id,
      username: user.username,
      role: user.role,
      role_label: ROLE_LABELS_AR[user.role] || user.role,
      hourly_rate: user.hourly_rate,
      hours_source: user.role === "cashier" ? "shift" : "punch",
      total_hours: totalHours,
      total_pay: totalPay,
      missing_rate: user.hourly_rate == null || Number(user.hourly_rate) <= 0,
      sessions,
      punches,
    });
  }

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
