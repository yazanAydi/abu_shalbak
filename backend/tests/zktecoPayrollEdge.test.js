import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import { getPayrollPreview } from "../services/employeePayrollService.js";
import {
  importAttendanceSnapshot,
  saveDeviceMapping,
  addManualPunch,
  voidInterpretedPunch,
} from "../services/attendanceDeviceImport.js";
import { buildPayableAttendance, SESSION_LIMIT_MS } from "../services/payableAttendance.js";
import { syncZkteco, getDeviceAttendanceStatus } from "../services/zktecoSync.js";
import { hebronWallToUtcMs } from "../services/zkteco/readOnlyAdapter.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { shopLocalParts, shopLocalToUtcMs, shopYmdFromTimestamp, utcMsToSql } from "../utils/shopTime.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";

const DEVICE = "mb160";
const FAKE_HOST = "10.0.0.8";

function pad(n) {
  return String(n).padStart(2, "0");
}

function tap(deviceUserId, ymd, hh, mm, ss = 0, extra = {}) {
  return {
    deviceUserId: String(deviceUserId),
    wallClock: `${ymd} ${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    rawStatus: extra.rawStatus ?? 0,
    rawPunch: extra.rawPunch ?? 0,
    rawRecordId: extra.rawRecordId ?? `${deviceUserId}-${ymd}-${hh}${mm}${ss}`,
  };
}

function hostDate(wallClock) {
  const [date, time] = wallClock.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

function fakeZk(records) {
  return {
    async createSocket() {},
    async getInfo() {
      return { logCounts: records.length, userCounts: 1 };
    },
    async getUsers() {
      const ids = [...new Set(records.map((row) => row.deviceUserId))];
      return { data: ids.map((id) => ({ userId: id, name: `device-${id}` })) };
    },
    async getAttendances() {
      return {
        data: records.map((row, index) => ({
          deviceUserId: row.deviceUserId,
          userSn: index + 1,
          recordTime: hostDate(row.wallClock),
          state: row.rawStatus,
          punch: row.rawPunch,
        })),
      };
    },
    async disconnect() {},
    zklibTcp: {
      sessionId: 1,
      async executeCmd() {
        return Buffer.from("Ver 6.60");
      },
    },
  };
}

function fakeSyncConfig() {
  return {
    enabled: true,
    host: FAKE_HOST,
    port: 4370,
    commKey: 0,
    timeoutMs: 1000,
    deviceKey: DEVICE,
    attempts: 1,
    includeDirectory: true,
  };
}

async function preview(db, employeeId, from, to) {
  return getPayrollPreview(db, employeeId, { period_from: from, period_to: to, as_of: to });
}

describe("ZKTeco attendance payroll edge cases", () => {
  let ctx;
  let adminToken;
  let adminUserId;
  let cashierUserId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    adminUserId = adminLogin.body.user.id;
    cashierUserId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeEmployee({ name, role, rate, wageBasis = null, dailyRate = null }) {
    const hash = await bcrypt.hash("edgepass123", 4);
    const username = `edge-${name}-${Math.floor(Math.random() * 1e9)}`;
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, ?, 0, ?)",
      [username, hash, role, rate]
    );
    const user = await ctx.db.get("SELECT id FROM users WHERE username = ?", [username]);
    const emp = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis, daily_rate) VALUES (?, 1, ?, ?, ?)",
      [name, user.id, wageBasis, dailyRate]
    );
    return { userId: user.id, employeeId: emp.lastID };
  }

  async function mapAndImport(employeeId, deviceUserId, records) {
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: String(deviceUserId), employeeId });
    return importAttendanceSnapshot(
      ctx.db,
      { users: [{ deviceUserId: String(deviceUserId), name: "device" }], records },
      { deviceKey: DEVICE }
    );
  }

  const adminReq = () => ({
    user: { id: adminUserId, username: "testadmin", role: "admin" },
    headers: {},
  });

  test("1. a missing checkout stays unpaid and the next punch is a new IN", async () => {
    const emp = await makeEmployee({ name: "missing", role: "cashier", rate: 25 });
    await setPayrollAttendanceCutover(ctx.db, "2026-05-01");
    await mapAndImport(emp.employeeId, "e01", [tap("e01", "2026-05-01", 8, 0)]);
    const startMs = shopLocalToUtcMs("2026-05-01", 8, 0, 0);

    const open = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-05-01",
      to: "2026-05-02",
      nowMs: startMs + SESSION_LIMIT_MS,
    });
    expect(open.sessions).toEqual([
      expect.objectContaining({ status: "open", hours: 0, pay: 0, check_out_at: null }),
    ]);

    const missing = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-05-01",
      to: "2026-05-02",
      nowMs: startMs + SESSION_LIMIT_MS + 1,
    });
    expect(missing.sessions).toEqual([
      expect.objectContaining({ status: "missing_checkout", hours: 0, pay: 0, check_out_at: null }),
    ]);
    expect(missing.posted_pay).toBe(0);
    expect(missing.sessions.some((row) => row.hours >= 16)).toBe(false);

    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("e01", "2026-05-02", 8, 0)] },
      { deviceKey: DEVICE }
    );
    const types = await ctx.db.all(
      "SELECT punch_type, source FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active' ORDER BY datetime(punched_at)",
      [emp.employeeId]
    );
    expect(types).toEqual([
      { punch_type: "in", source: "device" },
      { punch_type: "in", source: "device" },
    ]);
    const after = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-05-01",
      to: "2026-05-02",
      nowMs: shopLocalToUtcMs("2026-05-02", 9, 0, 0),
    });
    expect(after.sessions.map((row) => row.status)).toEqual(["missing_checkout", "open"]);
    expect(after.posted_pay).toBe(0);
    expect(after.sessions.every((row) => row.check_out_at == null && row.pay === 0)).toBe(true);

    const payroll = await preview(ctx.db, emp.employeeId, "2026-05-01", "2026-05-02");
    expect(payroll.summary.gross_salary).toBe(0);
    expect(payroll.summary.payable_hours).toBe(0);
  });

  test("2. a real overnight shift pays 8 hours on the check-in shop date", async () => {
    const emp = await makeEmployee({ name: "overnight", role: "cashier", rate: 20 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "e02", [
      tap("e02", "2026-06-11", 22, 0),
      tap("e02", "2026-06-12", 6, 0),
    ]);
    const start = new Date(shopLocalToUtcMs("2026-06-11", 22, 0, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-06-12", 6, 0, 0)).toISOString();
    expect(shiftHours(start, end)).toBe(8);

    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-11",
      to: "2026-06-12",
      nowMs: shopLocalToUtcMs("2026-06-12", 12, 0, 0),
    });
    expect(built.sessions).toEqual([
      expect.objectContaining({
        status: "closed",
        hours: 8,
        pay: shiftPay(20, 8),
        shop_start_on: "2026-06-11",
      }),
    ]);
    const nextDay = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-12",
      to: "2026-06-12",
      nowMs: shopLocalToUtcMs("2026-06-13", 12, 0, 0),
    });
    expect(nextDay.posted_pay).toBe(0);
    const payroll = await preview(ctx.db, emp.employeeId, "2026-06-11", "2026-06-11");
    expect(payroll.summary.payable_hours).toBe(8);
    expect(payroll.summary.gross_salary).toBe(160);
  });

  test("3. four taps inside nine seconds collapse to one punch", async () => {
    const emp = await makeEmployee({ name: "burst", role: "cashier", rate: 25 });
    const records = [4, 7, 11, 13].map((second) => tap("e03", "2026-06-04", 16, 31, second));
    const imported = await mapAndImport(emp.employeeId, "e03", records);
    expect(imported.inserted_events).toBe(4);
    const raw = await ctx.db.get("SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = 'e03'");
    const bursts = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = 'e03' AND ignored_reason = 'duplicate_burst'"
    );
    const punches = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active'",
      [emp.employeeId]
    );
    expect(raw.n).toBe(4);
    expect(bursts.n).toBe(3);
    expect(punches.n).toBe(1);
    const kept = await ctx.db.get(
      "SELECT wall_clock FROM attendance_device_events WHERE device_user_id = 'e03' AND interpreted_punch_id IS NOT NULL"
    );
    expect(kept.wall_clock).toBe("2026-06-04 16:31:04");
    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-04",
      to: "2026-06-04",
      nowMs: shopLocalToUtcMs("2026-06-04", 18, 0, 0),
    });
    expect(built.sessions).toHaveLength(1);
    expect(built.posted_pay).toBe(0);
    expect(built.posted_hours).toBe(0);
  });

  test("4. importing the same payload twice does not duplicate rows or pay", async () => {
    const emp = await makeEmployee({ name: "reimport", role: "cashier", rate: 25 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const records = [tap("e04", "2026-06-05", 8, 0), tap("e04", "2026-06-05", 16, 0)];
    await mapAndImport(emp.employeeId, "e04", records);
    const first = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    const again = await importAttendanceSnapshot(ctx.db, { users: [], records }, { deviceKey: DEVICE });
    expect(again.inserted_events).toBe(0);
    const raw = await ctx.db.get("SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = 'e04'");
    const punches = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ?",
      [emp.employeeId]
    );
    expect(raw.n).toBe(2);
    expect(punches.n).toBe(2);
    const second = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(second.summary.gross_salary).toBe(first.summary.gross_salary);
    expect(second.summary.gross_salary).toBe(200);
    expect(second.summary.payable_hours).toBe(8);
  });

  test("5. an unmapped device user is stored and does not affect payroll", async () => {
    const emp = await makeEmployee({ name: "bystander", role: "cashier", rate: 25 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "e05b", [tap("e05b", "2026-06-06", 8, 0), tap("e05b", "2026-06-06", 12, 0)]);
    const before = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");

    await importAttendanceSnapshot(
      ctx.db,
      { users: [{ deviceUserId: "e05", name: "Unmapped" }], records: [tap("e05", "2026-06-06", 9, 0)] },
      { deviceKey: DEVICE }
    );
    const raw = await ctx.db.get(
      "SELECT ignored_reason, employee_id, interpreted_punch_id FROM attendance_device_events WHERE device_user_id = 'e05'"
    );
    expect(raw.ignored_reason).toBe("unmapped");
    expect(raw.employee_id).toBeNull();
    expect(raw.interpreted_punch_id).toBeNull();
    const punches = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id IS NULL OR employee_id = 0"
    );
    expect(punches.n).toBe(0);
    const listed = await ctx.db.get(
      `SELECT u.device_user_id,
              (SELECT m.employee_id FROM employee_device_mappings m
                WHERE m.device_key = u.device_key AND m.device_user_id = u.device_user_id AND m.active = 1) AS employee_id
       FROM attendance_device_users u
       WHERE u.device_key = ? AND u.device_user_id = 'e05'`,
      [DEVICE]
    );
    expect(listed.device_user_id).toBe("e05");
    expect(listed.employee_id).toBeNull();
    const after = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(after.summary.gross_salary).toBe(before.summary.gross_salary);
    expect(after.summary.payable_hours).toBe(before.summary.payable_hours);
  });

  test("6. a failing adapter leaves local payroll readable and records the sync error", async () => {
    const emp = await makeEmployee({ name: "offline", role: "cashier", rate: 10 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "e06", [tap("e06", "2026-06-07", 8, 0), tap("e06", "2026-06-07", 12, 0)]);
    let calls = 0;
    const failed = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      config: fakeSyncConfig(),
      factory: async () => {
        calls += 1;
        throw new Error("device offline");
      },
    });
    expect(calls).toBe(1);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/offline/);
    const sync = await getDeviceAttendanceStatus(ctx.db, DEVICE);
    expect(sync.last_error).toMatch(/offline/);
    const payroll = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(payroll.summary.gross_salary).toBe(40);
    expect(payroll.summary.payable_hours).toBe(4);
  });

  test("7. a failed sync then a successful sync imports each missed record once", async () => {
    const emp = await makeEmployee({ name: "reconnect", role: "cashier", rate: 10 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "e07", employeeId: emp.employeeId });
    const records = [tap("e07", "2026-06-08", 8, 0), tap("e07", "2026-06-08", 16, 0)];
    const failed = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      config: fakeSyncConfig(),
      factory: async () => {
        throw new Error("device offline");
      },
    });
    expect(failed.ok).toBe(false);
    const recovered = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      config: fakeSyncConfig(),
      factory: async () => fakeZk(records),
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.inserted_events).toBe(2);
    const repeat = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      config: fakeSyncConfig(),
      factory: async () => fakeZk(records),
    });
    expect(repeat.ok).toBe(true);
    expect(repeat.inserted_events).toBe(0);
    const raw = await ctx.db.get("SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = 'e07'");
    const punches = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active'",
      [emp.employeeId]
    );
    expect(raw.n).toBe(2);
    expect(punches.n).toBe(2);
    const payroll = await preview(ctx.db, emp.employeeId, "2026-06-08", "2026-06-08");
    expect(payroll.summary.payable_hours).toBe(8);
    expect(payroll.summary.gross_salary).toBe(80);
    const sync = await getDeviceAttendanceStatus(ctx.db, DEVICE);
    expect(sync.last_error).toBeNull();
  });

  test("8. a manual OUT makes the session payable and leaves the raw event unchanged", async () => {
    const emp = await makeEmployee({ name: "manual", role: "cashier", rate: 20 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "e08", [tap("e08", "2026-06-20", 8, 0)]);
    const rawBefore = await ctx.db.get(
      "SELECT wall_clock, punched_at, raw_status, raw_punch, event_key FROM attendance_device_events WHERE device_user_id = 'e08'"
    );
    const manual = await addManualPunch(
      ctx.db,
      {
        employeeId: emp.employeeId,
        punchType: "out",
        punchedAt: "2026-06-20T16:00",
        note: "نسي الانصراف",
        userId: adminUserId,
      },
      adminReq()
    );
    const rawAfter = await ctx.db.get(
      "SELECT wall_clock, punched_at, raw_status, raw_punch, event_key FROM attendance_device_events WHERE device_user_id = 'e08'"
    );
    expect(rawAfter).toEqual(rawBefore);
    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-20",
      to: "2026-06-20",
      nowMs: shopLocalToUtcMs("2026-06-21", 12, 0, 0),
    });
    expect(built.sessions[0]).toMatchObject({ status: "closed", hours: 8, pay: 160, manual: true });
    const audit = await ctx.db.get(
      "SELECT action, entity_id FROM audit_logs WHERE action = 'ATTENDANCE_MANUAL_PUNCH' AND entity_id = ?",
      [manual.id]
    );
    expect(audit.action).toBe("ATTENDANCE_MANUAL_PUNCH");
    const payroll = await preview(ctx.db, emp.employeeId, "2026-06-20", "2026-06-20");
    expect(payroll.summary.gross_salary).toBe(160);
  });

  test("9. voiding a device punch keeps the raw row and is not recreated on sync", async () => {
    const emp = await makeEmployee({ name: "void", role: "cashier", rate: 20 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const records = [tap("e09", "2026-06-21", 8, 0), tap("e09", "2026-06-21", 16, 0)];
    await mapAndImport(emp.employeeId, "e09", records);
    const before = await preview(ctx.db, emp.employeeId, "2026-06-21", "2026-06-21");
    expect(before.summary.gross_salary).toBe(160);
    const deviceIn = await ctx.db.get(
      `SELECT p.id, e.wall_clock, e.event_key
       FROM attendance_interpreted_punches p
       JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
       WHERE e.device_user_id = 'e09' AND p.punch_type = 'in' AND p.source = 'device'`
    );
    await voidInterpretedPunch(ctx.db, deviceIn.id, { reason: "بصمة خاطئة", userId: adminUserId }, adminReq());
    const raw = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = 'e09' AND wall_clock = ? AND event_key = ?",
      [deviceIn.wall_clock, deviceIn.event_key]
    );
    expect(raw.n).toBe(1);
    const again = await importAttendanceSnapshot(ctx.db, { users: [], records }, { deviceKey: DEVICE });
    expect(again.inserted_events).toBe(0);
    const linked = await ctx.db.get(
      `SELECT p.status FROM attendance_interpreted_punches p
       JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
       WHERE e.event_key = ?`,
      [deviceIn.event_key]
    );
    expect(linked.status).toBe("void");
    const activeForEvent = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM attendance_interpreted_punches p
       JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
       WHERE e.event_key = ? AND p.status = 'active'`,
      [deviceIn.event_key]
    );
    expect(activeForEvent.n).toBe(0);
    const payroll = await preview(ctx.db, emp.employeeId, "2026-06-21", "2026-06-21");
    expect(payroll.summary.gross_salary).toBe(0);
    expect(payroll.summary.payable_hours).toBe(0);
  });

  test("10. correcting a mapping does not move punches already interpreted", async () => {
    const employeeA = await makeEmployee({ name: "map-a", role: "cashier", rate: 20 });
    const employeeB = await makeEmployee({ name: "map-b", role: "cashier", rate: 30 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(employeeA.employeeId, "e10", [
      tap("e10", "2026-06-15", 8, 0),
      tap("e10", "2026-06-15", 16, 0),
    ]);
    const historical = await ctx.db.all(
      "SELECT id, employee_id FROM attendance_interpreted_punches WHERE employee_id = ? ORDER BY id",
      [employeeA.employeeId]
    );
    expect(historical).toHaveLength(2);

    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "e10", employeeId: employeeB.employeeId });
    const stillA = await ctx.db.all(
      "SELECT id, employee_id FROM attendance_interpreted_punches WHERE id IN (?, ?) ORDER BY id",
      [historical[0].id, historical[1].id]
    );
    expect(stillA).toEqual(historical);

    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("e10", "2026-06-16", 9, 0)] },
      { deviceKey: DEVICE }
    );
    const moved = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND id IN (?, ?)",
      [employeeB.employeeId, historical[0].id, historical[1].id]
    );
    expect(moved.n).toBe(0);
    const fresh = await ctx.db.get(
      `SELECT p.employee_id, e.wall_clock
       FROM attendance_interpreted_punches p
       JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
       WHERE e.device_user_id = 'e10' AND e.wall_clock = '2026-06-16 09:00:00'`
    );
    expect(fresh.employee_id).toBe(employeeB.employeeId);
    const payA = await preview(ctx.db, employeeA.employeeId, "2026-06-01", "2026-06-30");
    const payB = await preview(ctx.db, employeeB.employeeId, "2026-06-01", "2026-06-30");
    expect(payA.summary.gross_salary).toBe(160);
    expect(payB.summary.payable_hours).toBe(0);
    expect(payB.summary.gross_salary).toBe(0);
  });

  test("11. Asia/Hebron summer and winter offsets keep 23:30 on the wall date", async () => {
    const adapter = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../services/zkteco/readOnlyAdapter.js"),
      "utf8"
    );
    expect(adapter).toMatch(/shopLocalToUtcMs/);
    expect(adapter).not.toMatch(/3 \* 60 \* 60 \* 1000|10800000|\+ 3 \* 3600/);

    const winterWall = "2026-01-15 23:30:00";
    const summerWall = "2026-07-15 23:30:00";
    expect(utcMsToSql(hebronWallToUtcMs(winterWall))).toBe("2026-01-15 21:30:00");
    expect(utcMsToSql(hebronWallToUtcMs(summerWall))).toBe("2026-07-15 20:30:00");
    expect(utcMsToSql(hebronWallToUtcMs("2026-01-15 12:00:00"))).toBe("2026-01-15 10:00:00");
    expect(utcMsToSql(hebronWallToUtcMs("2026-07-15 12:00:00"))).toBe("2026-07-15 09:00:00");

    const emp = await makeEmployee({ name: "tz", role: "cashier", rate: 10 });
    await mapAndImport(emp.employeeId, "e11", [
      { deviceUserId: "e11", wallClock: winterWall, rawStatus: 0, rawPunch: 0, rawRecordId: "winter" },
      { deviceUserId: "e11", wallClock: summerWall, rawStatus: 0, rawPunch: 0, rawRecordId: "summer" },
    ]);
    const rows = await ctx.db.all(
      "SELECT wall_clock, punched_at FROM attendance_device_events WHERE device_user_id = 'e11' ORDER BY wall_clock"
    );
    expect(rows).toEqual([
      { wall_clock: winterWall, punched_at: "2026-01-15 21:30:00" },
      { wall_clock: summerWall, punched_at: "2026-07-15 20:30:00" },
    ]);
    expect(shopYmdFromTimestamp(rows[0].punched_at)).toBe("2026-01-15");
    expect(shopYmdFromTimestamp(rows[1].punched_at)).toBe("2026-07-15");
    expect(shopLocalParts(rows[0].punched_at)).toMatchObject({ ymd: "2026-01-15", hour: 23, minute: 30 });
    expect(shopLocalParts(rows[1].punched_at)).toMatchObject({ ymd: "2026-07-15", hour: 23, minute: 30 });
  });

  test("12. cutover uses POS pay only before the date and attendance only on that date", async () => {
    const emp = await makeEmployee({ name: "cutover", role: "cashier", rate: 25 });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-03");
    await mapAndImport(emp.employeeId, "e12", [
      tap("e12", "2026-10-02", 8, 0),
      tap("e12", "2026-10-02", 12, 0),
      tap("e12", "2026-10-03", 8, 0),
      tap("e12", "2026-10-03", 12, 0),
    ]);
    async function shift(ymd) {
      await ctx.db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
         VALUES (?, ?, ?, 0, 'closed', 10)`,
        [
          emp.userId,
          new Date(shopLocalToUtcMs(ymd, 8, 0, 0)).toISOString(),
          new Date(shopLocalToUtcMs(ymd, 16, 0, 0)).toISOString(),
        ]
      );
    }
    await shift("2026-10-02");
    await shift("2026-10-03");

    const dayBefore = await preview(ctx.db, emp.employeeId, "2026-10-02", "2026-10-02");
    expect(dayBefore.summary.gross_salary).toBe(80);
    expect(dayBefore.summary.payable_hours).toBe(8);
    expect(dayBefore.hours.attendance_authoritative).toBeFalsy();

    const cutoverDay = await preview(ctx.db, emp.employeeId, "2026-10-03", "2026-10-03");
    expect(cutoverDay.summary.gross_salary).toBe(100);
    expect(cutoverDay.summary.payable_hours).toBe(4);
    expect(cutoverDay.summary.pos_hours).toBe(8);
    expect(cutoverDay.summary.pos_affects_gross).toBe(false);
    expect(cutoverDay.hours.pos_affects_pay).toBe(false);

    const both = await preview(ctx.db, emp.employeeId, "2026-10-02", "2026-10-03");
    expect(both.summary.gross_salary).toBe(180);
    expect(both.summary.gross_salary).not.toBe(260);
  });

  test("13. hourly office attendance is paid after cutover and daily attendance is display-only", async () => {
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const admin = await makeEmployee({ name: "admin-hourly", role: "admin", rate: 25, wageBasis: null });
    await mapAndImport(admin.employeeId, "e13a", [
      tap("e13a", "2026-06-18", 8, 0),
      tap("e13a", "2026-06-18", 16, 0),
    ]);
    const visible = await buildPayableAttendance(ctx.db, admin.employeeId, {
      from: "2026-06-18",
      to: "2026-06-18",
      nowMs: shopLocalToUtcMs("2026-06-19", 12, 0, 0),
    });
    expect(visible.sessions[0]).toMatchObject({ status: "closed", hours: 8, pay: 200 });
    const adminPay = await preview(ctx.db, admin.employeeId, "2026-06-01", "2026-06-30");
    expect(adminPay.summary.payable_hours).toBe(8);
    expect(adminPay.summary.rate).toBe(25);
    expect(adminPay.summary.gross_salary).toBe(200);

    const accountant = await makeEmployee({
      name: "acct-daily",
      role: "accountant",
      rate: 99,
      wageBasis: "daily",
      dailyRate: 90,
    });
    await mapAndImport(accountant.employeeId, "e13b", [
      tap("e13b", "2026-06-18", 9, 0),
      tap("e13b", "2026-06-18", 17, 0),
    ]);
    const daily = await preview(ctx.db, accountant.employeeId, "2026-06-01", "2026-06-30");
    expect(daily.summary.basis).toBe("daily");
    expect(daily.summary.rate).toBe(90);
    expect(daily.summary.gross_salary).toBeNull();
    expect(daily.summary.net_payable).toBeNull();
    expect(daily.summary.pay_from_attendance_hours).toBe(false);
    expect(daily.summary.lines[0]).toMatchObject({ hours: 8, amount: null, payable: false });
    const stored = await ctx.db.get("SELECT wage_basis, daily_rate FROM employees WHERE id = ?", [
      accountant.employeeId,
    ]);
    expect(stored.wage_basis).toBe("daily");
    expect(Number(stored.daily_rate)).toBe(90);
  });

  test("14. advances and debts change the net only", async () => {
    const emp = await makeEmployee({ name: "deduct", role: "cashier", rate: 25 });
    const other = await makeEmployee({ name: "deduct-other", role: "cashier", rate: 25 });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-03");
    await mapAndImport(emp.employeeId, "e14", [tap("e14", "2026-10-03", 8, 0), tap("e14", "2026-10-03", 16, 0)]);

    async function addAdvance(employeeId, day, amount, seq) {
      await ctx.db.run(
        `INSERT INTO employee_ledger_entries
           (employee_id, entry_type, purpose, occurred_on, amount, event_seq)
         VALUES (?, 'salary_payment', 'salary_advance', ?, ?, ?)`,
        [employeeId, day, amount, seq]
      );
    }
    async function addDebt(employeeId, customerId, day, amount, receipt) {
      const tx = await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number, business_day)
         VALUES (?, '[]', ?, 0, ?, 'on_account', ?, ?, 'completed', ?, ?, ?)`,
        [cashierUserId, amount, amount, customerId, employeeId, `${day} 10:00:00`, receipt, day]
      );
      await ctx.db.run(
        "INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', ?)",
        [tx.lastID, amount]
      );
      await ctx.db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [amount, customerId]);
    }

    await addAdvance(emp.employeeId, "2026-10-03", 10, 1401);
    await addAdvance(emp.employeeId, "2026-09-20", 40, 1402);
    await addAdvance(other.employeeId, "2026-10-03", 100, 1403);
    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('ذمة edge', 'EDGE-DEBT', 0, 0, 500)`
    );
    await ctx.db.run("UPDATE employees SET customer_id = ? WHERE id = ?", [customer.lastID, emp.employeeId]);
    await addDebt(emp.employeeId, customer.lastID, "2026-10-03", 5, "EDGE-IN");
    await addDebt(emp.employeeId, customer.lastID, "2026-09-20", 8, "EDGE-OUT");
    const otherCustomer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('ذمة other', 'EDGE-OTHER', 0, 0, 500)`
    );
    await ctx.db.run("UPDATE employees SET customer_id = ? WHERE id = ?", [otherCustomer.lastID, other.employeeId]);
    await addDebt(other.employeeId, otherCustomer.lastID, "2026-10-03", 9, "EDGE-OTHER-SALE");

    const row = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    expect(row.summary.payable_hours).toBe(8);
    expect(row.summary.rate).toBe(25);
    expect(row.summary.gross_salary).toBe(200);
    expect(row.summary.advances_total).toBe(10);
    expect(row.summary.debts_total).toBe(5);
    expect(row.summary.net_payable).toBe(185);
    const otherRow = await preview(ctx.db, other.employeeId, "2026-10-01", "2026-10-31");
    expect(otherRow.summary.advances_total).toBe(100);
    expect(otherRow.summary.debts_total).toBe(9);
  });

  test("the status endpoint lists the unmapped device user", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/attendance/device/status")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body?.data ?? res.body;
    const row = (body.users || []).find((user) => user.device_user_id === "e05");
    expect(row).toMatchObject({ device_user_id: "e05", mapped: false, employee_id: null });
  });
});
