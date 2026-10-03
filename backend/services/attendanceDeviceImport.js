import { createHash } from "crypto";
import { badRequest, notFound } from "../utils/httpError.js";
import { withTransaction } from "../utils/dbTx.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { parseTimestampMs, round2 } from "./cashierPayrollService.js";
import { parseAttendanceInstant } from "./attendanceSessionService.js";
import { ATTENDANCE_TRACKED_ROLES, isAttendanceTrackableEmployee, isAttendanceTrackedRole } from "../utils/roles.js";
import { hebronWallToUtcMs, normalizeWallClock } from "./zkteco/readOnlyAdapter.js";
import { utcMsToSql } from "../utils/shopTime.js";

export const BURST_WINDOW_MS = 30 * 1000;

function eventKey(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function attendanceEventKey({ deviceKey, deviceUserId, wallClock, rawStatus, rawPunch, rawRecordId }) {
  return eventKey([
    String(deviceKey),
    String(deviceUserId),
    normalizeWallClock(wallClock) || "",
    rawStatus == null ? "" : String(rawStatus),
    rawPunch == null ? "" : String(rawPunch),
    rawRecordId == null ? "" : String(rawRecordId),
  ]);
}

async function hourlySnapshot(db, employeeId) {
  const row = await db.get(
    `SELECT u.hourly_rate
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [employeeId]
  );
  const rate = Number(row?.hourly_rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return round2(rate);
}

async function insertDevicePunch(db, employeeId, eventId, punchedAt) {
  const rate = await hourlySnapshot(db, employeeId);
  const ins = await db.run(
    `INSERT INTO attendance_interpreted_punches
       (employee_id, punched_at, punch_type, source, status, device_event_id, hourly_rate_snapshot)
     VALUES (?, ?, 'in', 'device', 'active', ?, ?)`,
    [employeeId, punchedAt, eventId, rate]
  );
  await db.run(
    `UPDATE attendance_device_events
     SET interpreted_punch_id = ?, ignored_reason = NULL, employee_id = ?
     WHERE id = ?`,
    [ins.lastID, employeeId, eventId]
  );
  return ins.lastID;
}

async function voidPunchRow(db, punchId, reason, userId) {
  const punch = await db.get("SELECT * FROM attendance_interpreted_punches WHERE id = ?", [punchId]);
  if (!punch || punch.status === "void") return punch;
  const now = utcMsToSql(Date.now());
  await db.run(
    `UPDATE attendance_interpreted_punches
     SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ?,
         corrected_by = COALESCE(corrected_by, ?), corrected_at = COALESCE(corrected_at, ?)
     WHERE id = ? AND status = 'active'`,
    [reason, userId ?? null, now, userId ?? null, now, punchId]
  );
  return db.get("SELECT * FROM attendance_interpreted_punches WHERE id = ?", [punchId]);
}

/**
 * Walk active punches and assign IN/OUT for device taps.
 * Manual punches keep the type the admin entered.
 * @param {Array<object>} punches chronological active punches
 */
export function assignPunchTypes(punches) {
  const limit = 16 * 60 * 60 * 1000;
  let openAt = null;
  const assigned = [];
  for (const punch of punches) {
    const at = parseTimestampMs(punch.punched_at);
    if (punch.source === "manual") {
      if (punch.punch_type === "in") {
        if (openAt == null || at - openAt > limit) openAt = at;
      } else if (punch.punch_type === "out" && openAt != null) {
        openAt = null;
      }
      assigned.push({ id: punch.id, punch_type: punch.punch_type, source: punch.source });
      continue;
    }
    let type;
    if (openAt == null) {
      type = "in";
      openAt = at;
    } else if (at - openAt <= limit) {
      type = "out";
      openAt = null;
    } else {
      type = "in";
      openAt = at;
    }
    assigned.push({ id: punch.id, punch_type: type, source: "device" });
  }
  return assigned;
}

export async function recomputePunchTypes(db, employeeId) {
  const punches = await db.all(
    `SELECT id, punched_at, punch_type, source, status
     FROM attendance_interpreted_punches
     WHERE employee_id = ? AND status = 'active'
     ORDER BY datetime(punched_at) ASC, id ASC`,
    [employeeId]
  );
  const assigned = assignPunchTypes(punches);
  for (const row of assigned) {
    if (row.source !== "device") continue;
    await db.run(
      `UPDATE attendance_interpreted_punches SET punch_type = ? WHERE id = ? AND source = 'device' AND status = 'active'`,
      [row.punch_type, row.id]
    );
  }
}

/**
 * Collapse 30-second bursts, then create interpreted punches for kept taps.
 * Events that already point at a punch — including a voided one — are not punched again.
 */
export async function interpretEmployeeEvents(db, employeeId, deviceKey) {
  const events = await db.all(
    `SELECT * FROM attendance_device_events
     WHERE employee_id = ? AND device_key = ?
     ORDER BY datetime(punched_at) ASC, id ASC`,
    [employeeId, deviceKey]
  );
  let lastKeptMs = null;
  for (const event of events) {
    const at = parseTimestampMs(event.punched_at);
    const duplicate = lastKeptMs != null && at - lastKeptMs <= BURST_WINDOW_MS;
    if (duplicate) {
      if (event.ignored_reason !== "duplicate_burst") {
        await db.run("UPDATE attendance_device_events SET ignored_reason = 'duplicate_burst' WHERE id = ?", [
          event.id,
        ]);
      }
      if (event.interpreted_punch_id) {
        await voidPunchRow(db, event.interpreted_punch_id, "duplicate_burst", null);
      }
      continue;
    }
    lastKeptMs = at;
    if (!event.interpreted_punch_id) {
      await insertDevicePunch(db, employeeId, event.id, event.punched_at);
    } else if (event.ignored_reason) {
      await db.run("UPDATE attendance_device_events SET ignored_reason = NULL WHERE id = ?", [event.id]);
    }
  }
  await recomputePunchTypes(db, employeeId);
}

async function applyActiveMappings(db, deviceKey) {
  await db.run(
    `UPDATE attendance_device_events
     SET employee_id = (
       SELECT m.employee_id FROM employee_device_mappings m
       WHERE m.device_key = attendance_device_events.device_key
         AND m.device_user_id = attendance_device_events.device_user_id
         AND m.active = 1
     )
     WHERE device_key = ?
       AND interpreted_punch_id IS NULL
       AND EXISTS (
         SELECT 1 FROM employee_device_mappings m
         WHERE m.device_key = attendance_device_events.device_key
           AND m.device_user_id = attendance_device_events.device_user_id
           AND m.active = 1
       )`,
    [deviceKey]
  );
  await db.run(
    `UPDATE attendance_device_events
     SET ignored_reason = 'unmapped', employee_id = NULL
     WHERE device_key = ?
       AND interpreted_punch_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM employee_device_mappings m
         WHERE m.device_key = attendance_device_events.device_key
           AND m.device_user_id = attendance_device_events.device_user_id
           AND m.active = 1
       )`,
    [deviceKey]
  );
}

export async function refreshDeviceMappings(db, deviceKey) {
  await applyActiveMappings(db, deviceKey);
  const employees = await db.all(
    `SELECT DISTINCT employee_id FROM attendance_device_events
     WHERE device_key = ? AND employee_id IS NOT NULL`,
    [deviceKey]
  );
  for (const row of employees) {
    await interpretEmployeeEvents(db, row.employee_id, deviceKey);
  }
}

/**
 * Append raw taps and interpret newly kept ones. Exact re-imports are no-ops.
 * @param {object} snapshot { users, records }
 */
export async function importAttendanceSnapshot(db, snapshot, { deviceKey }) {
  const key = String(deviceKey || "").trim();
  if (!key) throw badRequest("مفتاح الجهاز مطلوب");
  const users = Array.isArray(snapshot?.users) ? snapshot.users : [];
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const seenAt = utcMsToSql(Date.now());

  return withTransaction(db, async () => {
    for (const user of users) {
      const deviceUserId = String(user.deviceUserId ?? user.userId ?? "").trim();
      if (!deviceUserId) continue;
      const name = String(user.name || "").replace(/\0/g, "").trim();
      await db.run(
        `INSERT INTO attendance_device_users (device_key, device_user_id, display_name, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_key, device_user_id) DO UPDATE SET
           display_name = excluded.display_name,
           last_seen_at = excluded.last_seen_at`,
        [key, deviceUserId, name, seenAt]
      );
    }

    let inserted = 0;
    for (const record of records) {
      const deviceUserId = String(record.deviceUserId ?? "").trim();
      const wallClock = normalizeWallClock(record.wallClock);
      if (!deviceUserId || !wallClock) continue;
      const punchedAtMs = hebronWallToUtcMs(wallClock);
      if (!Number.isFinite(punchedAtMs)) continue;
      const punchedAt = utcMsToSql(punchedAtMs);
      const rawStatus = record.rawStatus == null ? null : String(record.rawStatus);
      const rawPunch = record.rawPunch == null ? null : String(record.rawPunch);
      const rawRecordId = record.rawRecordId == null ? null : String(record.rawRecordId);
      const keyHash = attendanceEventKey({
        deviceKey: key,
        deviceUserId,
        wallClock,
        rawStatus,
        rawPunch,
        rawRecordId,
      });
      const ins = await db.run(
        `INSERT INTO attendance_device_events
           (device_key, device_user_id, punched_at, wall_clock, raw_status, raw_punch, raw_record_id, event_key, ignored_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmapped')
         ON CONFLICT(event_key) DO NOTHING`,
        [key, deviceUserId, punchedAt, wallClock, rawStatus, rawPunch, rawRecordId, keyHash]
      );
      if (ins.changes) inserted += 1;
    }

    await refreshDeviceMappings(db, key);
    const counts = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM attendance_device_events WHERE device_key = ?) AS raw_events,
         (SELECT COUNT(*) FROM attendance_interpreted_punches p
            JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
            WHERE e.device_key = ?) AS interpreted_punches
       `,
      [key, key]
    );
    return {
      device_key: key,
      inserted_events: inserted,
      raw_events: Number(counts?.raw_events) || 0,
      interpreted_punches: Number(counts?.interpreted_punches) || 0,
    };
  });
}

export async function ensureAttendanceEmployee(db, { employeeId = null, userId = null } = {}) {
  const requestedEmployee = Number(employeeId);
  if (requestedEmployee) {
    const emp = await db.get(
      `SELECT e.*, u.role AS user_role
       FROM employees e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.id = ?`,
      [requestedEmployee]
    );
    if (!emp) throw notFound("الموظف غير موجود");
    if (!isAttendanceTrackableEmployee(emp)) {
      throw badRequest("هذا الموظف غير مشمول في حضور الجهاز");
    }
    return emp;
  }
  const requestedUser = Number(userId);
  if (!requestedUser) throw badRequest("الموظف مطلوب");
  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [requestedUser]);
  if (!user || !isAttendanceTrackedRole(user.role)) {
    throw badRequest("هذا الحساب لا يُربَط بحضور الجهاز");
  }
  const existing = await db.get("SELECT * FROM employees WHERE user_id = ?", [user.id]);
  if (existing) return existing;
  const ins = await db.run(
    "INSERT INTO employees (name, active, user_id) VALUES (?, 1, ?)",
    [user.username, user.id]
  );
  return db.get("SELECT * FROM employees WHERE id = ?", [ins.lastID]);
}

export async function listAttendanceTrackablePeople(db) {
  const employees = await db.all(
    `SELECT e.id AS employee_id, e.name, e.active, e.wage_basis, e.daily_rate,
            u.id AS user_id, u.role AS user_role, u.username
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     ORDER BY e.active DESC, e.name COLLATE NOCASE, e.id`
  );
  const people = [];
  const linkedUsers = new Set();
  for (const row of employees) {
    if (!isAttendanceTrackableEmployee(row)) continue;
    if (row.user_id) linkedUsers.add(Number(row.user_id));
    people.push({
      employee_id: row.employee_id,
      user_id: row.user_id ?? null,
      name: row.name,
      role: row.user_role || null,
      username: row.username || null,
      wage_basis: row.wage_basis || null,
      daily_rate: row.daily_rate == null ? null : Number(row.daily_rate),
      active: Number(row.active) === 1,
    });
  }
  const placeholders = ATTENDANCE_TRACKED_ROLES.map(() => "?").join(", ");
  const unlinked = await db.all(
    `SELECT id, username, role FROM users
     WHERE role IN (${placeholders})
     ORDER BY username COLLATE NOCASE, id`,
    ATTENDANCE_TRACKED_ROLES
  );
  for (const user of unlinked) {
    if (linkedUsers.has(Number(user.id)) || !isAttendanceTrackedRole(user.role)) continue;
    people.push({
      employee_id: null,
      user_id: user.id,
      name: user.username,
      role: user.role,
      username: user.username,
      wage_basis: null,
      daily_rate: null,
      active: true,
    });
  }
  return people;
}

export async function saveDeviceMapping(db, { deviceKey, deviceUserId, employeeId, linkUserId, userId }, req) {
  const key = String(deviceKey || "").trim();
  const deviceUser = String(deviceUserId || "").trim();
  if (!key || !deviceUser) throw badRequest("معرّف مستخدم الجهاز مطلوب");
  const emp = await ensureAttendanceEmployee(db, { employeeId, userId: linkUserId });
  const employee = emp.id;

  const row = await withTransaction(db, async () => {
    await db.run(
      `UPDATE employee_device_mappings SET active = 0, updated_at = datetime('now')
       WHERE device_key = ? AND active = 1 AND (device_user_id = ? OR employee_id = ?)`,
      [key, deviceUser, employee]
    );
    const ins = await db.run(
      `INSERT INTO employee_device_mappings (employee_id, device_key, device_user_id, active, created_by)
       VALUES (?, ?, ?, 1, ?)`,
      [employee, key, deviceUser, userId ?? null]
    );
    await refreshDeviceMappings(db, key);
    return db.get("SELECT * FROM employee_device_mappings WHERE id = ?", [ins.lastID]);
  });
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_DEVICE_MAP, "employee_device_mappings", row.id, null, {
      employee_id: employee,
      device_key: key,
      device_user_id: deviceUser,
    });
  }
  return row;
}

export async function clearDeviceMapping(db, { deviceKey, deviceUserId }, req) {
  const key = String(deviceKey || "").trim();
  const deviceUser = String(deviceUserId || "").trim();
  await withTransaction(db, async () => {
    await db.run(
      `UPDATE employee_device_mappings SET active = 0, updated_at = datetime('now')
       WHERE device_key = ? AND device_user_id = ? AND active = 1`,
      [key, deviceUser]
    );
    await refreshDeviceMappings(db, key);
  });
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_DEVICE_MAP, "employee_device_mappings", null, null, {
      device_key: key,
      device_user_id: deviceUser,
      active: 0,
    });
  }
  return { device_key: key, device_user_id: deviceUser, active: 0 };
}

export async function addManualPunch(db, { employeeId, punchType, punchedAt, note, userId }, req) {
  const employee = Number(employeeId);
  const type = String(punchType || "").trim();
  if (!employee) throw badRequest("الموظف مطلوب");
  if (type !== "in" && type !== "out") throw badRequest("نوع التسجيل يجب أن يكون حضور أو انصراف");
  const reason = String(note || "").trim();
  if (!reason) throw badRequest("ملاحظة التصحيح مطلوبة");
  const emp = await db.get("SELECT id FROM employees WHERE id = ?", [employee]);
  if (!emp) throw notFound("الموظف غير موجود");
  const sqlTime = parseAttendanceInstant(punchedAt);
  if (!sqlTime) throw badRequest("وقت التسجيل غير صالح");
  if (parseTimestampMs(sqlTime) > Date.now() + 60_000) {
    throw badRequest("وقت التسجيل لا يمكن أن يكون في المستقبل");
  }
  const rate = type === "in" ? await hourlySnapshot(db, employee) : null;
  const now = utcMsToSql(Date.now());
  const punch = await withTransaction(db, async () => {
    const ins = await db.run(
      `INSERT INTO attendance_interpreted_punches
         (employee_id, punched_at, punch_type, source, status, hourly_rate_snapshot,
          correction_note, corrected_by, corrected_at)
       VALUES (?, ?, ?, 'manual', 'active', ?, ?, ?, ?)`,
      [employee, sqlTime, type, rate, reason, userId ?? null, now]
    );
    await recomputePunchTypes(db, employee);
    return db.get("SELECT * FROM attendance_interpreted_punches WHERE id = ?", [ins.lastID]);
  });
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_MANUAL_PUNCH, "attendance_interpreted_punches", punch.id, null, {
      employee_id: employee,
      punch_type: type,
      punched_at: sqlTime,
      note: reason,
    });
  }
  return punch;
}

export async function voidInterpretedPunch(db, punchId, { reason, userId }, req) {
  const id = Number(punchId);
  if (!id) throw badRequest("التسجيل غير صالح");
  const note = String(reason || "").trim();
  if (!note) throw badRequest("سبب الإلغاء مطلوب");
  const existing = await db.get("SELECT * FROM attendance_interpreted_punches WHERE id = ?", [id]);
  if (!existing) throw notFound("التسجيل غير موجود");
  if (existing.status === "void") return existing;
  const punch = await withTransaction(db, async () => {
    const voided = await voidPunchRow(db, id, note, userId);
    await db.run(
      `UPDATE attendance_interpreted_punches
       SET correction_note = ?, corrected_by = ?, corrected_at = voided_at
       WHERE id = ?`,
      [note, userId ?? null, id]
    );
    await recomputePunchTypes(db, existing.employee_id);
    return db.get("SELECT * FROM attendance_interpreted_punches WHERE id = ?", [id]);
  });
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_VOID_PUNCH, "attendance_interpreted_punches", id, {
      status: existing.status,
    }, {
      status: "void",
      reason: note,
    });
  }
  return punch || existing;
}
