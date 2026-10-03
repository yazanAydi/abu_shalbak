import request from "supertest";
import bcrypt from "bcrypt";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import { getPayrollPreview, confirmPayrollPayout } from "../services/employeePayrollService.js";
import {
  importAttendanceSnapshot,
  saveDeviceMapping,
  addManualPunch,
  voidInterpretedPunch,
  attendanceEventKey,
} from "../services/attendanceDeviceImport.js";
import { buildPayableAttendance } from "../services/payableAttendance.js";
import { syncZkteco } from "../services/zktecoSync.js";
import {
  assertReadOnlyCommand,
  readDeviceSnapshot,
  readSnapshotFromDevice,
  READ_ONLY_COMMANDS,
} from "../services/zkteco/readOnlyAdapter.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { checkInAttendance, setAttendanceNow } from "../services/attendanceSessionService.js";
import { shopLocalParts, shopLocalToUtcMs, utcMsToSql } from "../utils/shopTime.js";
import { shiftPay } from "../services/cashierPayrollService.js";

const DEVICE = "mb160";

function unwrap(body) {
  return body?.data ?? body;
}

function wall(ymd, hh, mm, ss = 0) {
  return `${ymd} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function tap(deviceUserId, ymd, hh, mm, ss = 0, extra = {}) {
  return {
    deviceUserId: String(deviceUserId),
    wallClock: wall(ymd, hh, mm, ss),
    rawStatus: extra.rawStatus ?? 0,
    rawPunch: extra.rawPunch ?? 0,
    rawRecordId: extra.rawRecordId ?? null,
  };
}

async function preview(db, employeeId, from, to) {
  return getPayrollPreview(db, employeeId, { period_from: from, period_to: to, as_of: to });
}

describe("ZKTeco MB160 attendance payroll", () => {
  let ctx;
  let adminToken;
  let cashierUserId;

  beforeAll(async () => {
    process.env.ZKTECO_ENABLED = "0";
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    cashierUserId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
  });

  afterAll(async () => {
    setAttendanceNow(null);
    delete process.env.ZKTECO_ENABLED;
    await destroyTestContext(ctx);
  });

  async function makeEmployee({ name, role, rate, wageBasis = null }) {
    const hash = await bcrypt.hash("staffpass123", 4);
    const username = `zk-${name}-${Math.floor(Math.random() * 1e6)}`;
    await ctx.db.run(
      `INSERT INTO users (username, password, role, must_change_password, hourly_rate)
       VALUES (?, ?, ?, 0, ?)`,
      [username, hash, role, rate]
    );
    const user = await ctx.db.get("SELECT id FROM users WHERE username = ?", [username]);
    const emp = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis) VALUES (?, 1, ?, ?)",
      [name, user.id, wageBasis]
    );
    return { userId: user.id, employeeId: emp.lastID, name };
  }

  async function mapAndImport(employeeId, deviceUserId, records, users = []) {
    await saveDeviceMapping(ctx.db, {
      deviceKey: DEVICE,
      deviceUserId: String(deviceUserId),
      employeeId,
    });
    return importAttendanceSnapshot(
      ctx.db,
      {
        users: [{ deviceUserId: String(deviceUserId), name: "device-name" }, ...users],
        records,
      },
      { deviceKey: DEVICE }
    );
  }

  test("does not connect when sync is disabled, even if a host is present", async () => {
    const result = await syncZkteco(ctx.db, {
      env: { ZKTECO_ENABLED: "0", ZKTECO_HOST: "100.100.100.201", ZKTECO_PORT: "4370" },
      factory: () => {
        throw new Error("should not connect");
      },
    });
    expect(result).toMatchObject({ ok: false, skipped: true, reason: "disabled" });
  });

  test("reader exposes only read commands", async () => {
    expect(assertReadOnlyCommand(READ_ONLY_COMMANDS.GET_VERSION)).toBe(1100);
    expect(() => assertReadOnlyCommand(202)).toThrow(/كتابة/);
    expect(() => assertReadOnlyCommand(15)).toThrow(/كتابة/);
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../services/zkteco/readOnlyAdapter.js"),
      "utf8"
    );
    expect(src).not.toMatch(/clearAttendanceLog|disableDevice|enableDevice|CMD_SET_TIME|CMD_CLEAR_ATTLOG|CMD_DELETE_USER/);
    const calls = [];
    const zk = {
      async createSocket() {
        calls.push("createSocket");
      },
      async getInfo() {
        calls.push("getInfo");
        return { logCounts: 2 };
      },
      async getUsers() {
        calls.push("getUsers");
        return { data: [{ userId: "2", name: "Mohammad Abu Shalbak", password: "secret" }] };
      },
      async getAttendances() {
        calls.push("getAttendances");
        return {
          data: [{ deviceUserId: "2", userSn: 4, recordTime: new Date(2026, 9, 3, 16, 31, 4), state: 1, punch: 255 }],
        };
      },
      async disconnect() {
        calls.push("disconnect");
      },
      async clearAttendanceLog() {
        calls.push("clearAttendanceLog");
      },
      async disableDevice() {
        calls.push("disableDevice");
      },
      zklibTcp: {
        sessionId: 3,
        async executeCmd(command) {
          calls.push(`cmd:${command}`);
          return Buffer.from("Ver 6.60 Sep 19 2019");
        },
      },
    };
    const snapshot = await readDeviceSnapshot(
      { host: "10.0.0.8", port: 4370, commKey: 0, timeoutMs: 1000 },
      async () => zk
    );
    expect(calls).toContain("disconnect");
    expect(calls).not.toContain("clearAttendanceLog");
    expect(calls).not.toContain("disableDevice");
    expect(snapshot.users).toEqual([{ deviceUserId: "2", name: "Mohammad Abu Shalbak" }]);
    expect(snapshot.records[0]).toMatchObject({
      wallClock: "2026-10-03 16:31:04",
      rawStatus: 1,
      rawPunch: 255,
      rawRecordId: "4",
    });
    expect(snapshot.firmware).toContain("6.60");
    const direct = await readSnapshotFromDevice(zk, { commKey: 0 });
    expect(direct.users[0].password).toBeUndefined();
  });

  test("maps a device user to the system employee and ignores the device name", async () => {
    const linked = await makeEmployee({ name: "Mohammad Abu Shalbak", role: "cashier", rate: 20 });
    const sameName = await makeEmployee({ name: "Mohammad Abu Shalbak", role: "cashier", rate: 99 });
    await mapAndImport(linked.employeeId, "2", [tap("2", "2026-06-02", 8, 0), tap("2", "2026-06-02", 16, 0)], [
      { deviceUserId: "2", name: "Someone Else" },
    ]);
    const punches = await ctx.db.all(
      "SELECT employee_id FROM attendance_interpreted_punches WHERE employee_id IN (?, ?)",
      [linked.employeeId, sameName.employeeId]
    );
    expect(punches.every((row) => row.employee_id === linked.employeeId)).toBe(true);
    expect(punches.length).toBeGreaterThan(0);
    const cols = await ctx.db.all("PRAGMA table_info(attendance_device_events)");
    expect(cols.map((col) => col.name).join(" ")).not.toMatch(/template|fingerprint|face|image/i);
  });

  test("stores an unmapped user without creating a punch, then links it later", async () => {
    await importAttendanceSnapshot(
      ctx.db,
      { users: [{ deviceUserId: "44", name: "Unmapped Person" }], records: [tap("44", "2026-06-03", 9, 0)] },
      { deviceKey: DEVICE }
    );
    const raw = await ctx.db.get(
      "SELECT ignored_reason, employee_id, interpreted_punch_id FROM attendance_device_events WHERE device_user_id = '44'"
    );
    expect(raw.ignored_reason).toBe("unmapped");
    expect(raw.employee_id).toBeNull();
    expect(raw.interpreted_punch_id).toBeNull();
    const emp = await makeEmployee({ name: "Later Linked", role: "bakery_employee", rate: 12, wageBasis: "hourly" });
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "44", employeeId: emp.employeeId });
    const punch = await ctx.db.get(
      "SELECT employee_id, status FROM attendance_interpreted_punches WHERE employee_id = ?",
      [emp.employeeId]
    );
    expect(punch.employee_id).toBe(emp.employeeId);
    expect(punch.status).toBe("active");
  });

  test("four taps in nine seconds stay four raw events and one interpreted punch", async () => {
    const emp = await makeEmployee({ name: "Burst", role: "cashier", rate: 18 });
    const records = [4, 7, 11, 13].map((second) => tap("70", "2026-06-04", 16, 31, second));
    const first = await mapAndImport(emp.employeeId, "70", records);
    expect(first.inserted_events).toBe(4);
    const raw = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = '70'"
    );
    const bursts = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = '70' AND ignored_reason = 'duplicate_burst'"
    );
    const punches = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active'",
      [emp.employeeId]
    );
    expect(raw.n).toBe(4);
    expect(bursts.n).toBe(3);
    expect(punches.n).toBe(1);
    const again = await importAttendanceSnapshot(ctx.db, { users: [], records }, { deviceKey: DEVICE });
    expect(again.inserted_events).toBe(0);
    const rawAfter = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = '70'"
    );
    const punchesAfter = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ?",
      [emp.employeeId]
    );
    expect(rawAfter.n).toBe(4);
    expect(punchesAfter.n).toBe(1);
    const kept = await ctx.db.get(
      "SELECT wall_clock FROM attendance_device_events WHERE device_user_id = '70' AND interpreted_punch_id IS NOT NULL"
    );
    expect(kept.wall_clock).toBe("2026-06-04 16:31:04");
  });

  test("a tap 30 seconds later is a burst and 31 seconds later is kept", async () => {
    const within = await makeEmployee({ name: "Burst30", role: "cashier", rate: 10 });
    await mapAndImport(within.employeeId, "71", [tap("71", "2026-06-05", 10, 0, 0), tap("71", "2026-06-05", 10, 0, 30)]);
    const withinCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active'",
      [within.employeeId]
    );
    expect(withinCount.n).toBe(1);
    const beyond = await makeEmployee({ name: "Burst31", role: "cashier", rate: 10 });
    await mapAndImport(beyond.employeeId, "72", [tap("72", "2026-06-05", 11, 0, 0), tap("72", "2026-06-05", 11, 0, 31)]);
    const beyondCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ? AND status = 'active'",
      [beyond.employeeId]
    );
    expect(beyondCount.n).toBe(2);
  });

  test("normal IN/OUT pays the gap and an overnight pair within 16 hours pays 8", async () => {
    const emp = await makeEmployee({ name: "Day", role: "cashier", rate: 20 });
    await mapAndImport(emp.employeeId, "80", [tap("80", "2026-06-10", 8, 0), tap("80", "2026-06-10", 16, 0)]);
    const day = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-10",
      to: "2026-06-10",
      nowMs: shopLocalToUtcMs("2026-06-11", 12, 0, 0),
    });
    expect(day.sessions).toHaveLength(1);
    expect(day.sessions[0]).toMatchObject({ status: "closed", hours: 8, pay: 160 });

    const night = await makeEmployee({ name: "Night", role: "bakery_employee", rate: 15, wageBasis: "hourly" });
    await mapAndImport(night.employeeId, "81", [tap("81", "2026-06-11", 22, 0), tap("81", "2026-06-12", 6, 0)]);
    const overnight = await buildPayableAttendance(ctx.db, night.employeeId, {
      from: "2026-06-11",
      to: "2026-06-12",
      nowMs: shopLocalToUtcMs("2026-06-12", 12, 0, 0),
    });
    expect(overnight.sessions.filter((row) => row.shop_start_on === "2026-06-11")).toEqual([
      expect.objectContaining({ status: "closed", hours: 8, pay: shiftPay(15, 8) }),
    ]);
    const february = await buildPayableAttendance(ctx.db, night.employeeId, {
      from: "2026-06-12",
      to: "2026-06-12",
      nowMs: shopLocalToUtcMs("2026-06-13", 12, 0, 0),
    });
    expect(february.posted_pay).toBe(0);
  });

  test("a gap over 16 hours is missing checkout and pays nothing", async () => {
    const emp = await makeEmployee({ name: "Missing", role: "cashier", rate: 25 });
    await mapAndImport(emp.employeeId, "82", [tap("82", "2026-06-01", 8, 0), tap("82", "2026-06-02", 0, 0, 1)]);
    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-01",
      to: "2026-06-02",
      nowMs: shopLocalToUtcMs("2026-06-02", 0, 5, 0),
    });
    const first = built.sessions.find((row) => row.shop_start_on === "2026-06-01");
    expect(first).toMatchObject({ status: "missing_checkout", hours: 0, pay: 0 });
    expect(built.posted_pay).toBe(0);
    expect(built.warnings).toContain("missing_checkout");
    expect(built.sessions.some((row) => row.hours >= 16)).toBe(false);
  });

  test("exactly 16 hours still closes and pays", async () => {
    const emp = await makeEmployee({ name: "Edge16", role: "cashier", rate: 10 });
    await mapAndImport(emp.employeeId, "83", [tap("83", "2026-06-06", 8, 0), tap("83", "2026-06-07", 0, 0)]);
    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-06",
      to: "2026-06-07",
      nowMs: shopLocalToUtcMs("2026-06-07", 8, 0, 0),
    });
    expect(built.sessions[0]).toMatchObject({ status: "closed", hours: 16, pay: 160 });
  });

  test("month boundary keeps the overnight session on the check-in date", async () => {
    const emp = await makeEmployee({ name: "Month", role: "cashier", rate: 10 });
    await mapAndImport(emp.employeeId, "84", [tap("84", "2026-01-31", 22, 0), tap("84", "2026-02-01", 6, 0)]);
    await setPayrollAttendanceCutover(ctx.db, "2026-01-01");
    const january = await preview(ctx.db, emp.employeeId, "2026-01-01", "2026-01-31");
    const february = await preview(ctx.db, emp.employeeId, "2026-02-01", "2026-02-28");
    expect(january.hours.posted_pay).toBe(80);
    expect(january.calculated_salary).toBe(80);
    expect(february.hours.posted_pay).toBe(0);
    expect(february.calculated_salary).toBe(0);
  });

  test("after cutover a cashier is paid from attendance, not from the POS shift", async () => {
    const emp = await makeEmployee({ name: "Cashier After", role: "cashier", rate: 20 });
    await ctx.db.run("UPDATE users SET hourly_rate = 20 WHERE id = ?", [emp.userId]);
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    await mapAndImport(emp.employeeId, "90", [tap("90", "2026-10-03", 8, 0), tap("90", "2026-10-03", 16, 0)]);
    const start = new Date(shopLocalToUtcMs("2026-10-03", 8, 17, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-10-03", 15, 52, 0)).toISOString();
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 100, 'closed', 20)`,
      [emp.userId, start, end]
    );
    const row = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    expect(row.hours.attendance_authoritative).toBe(true);
    expect(row.hours.pos_affects_pay).toBe(false);
    expect(row.hours.attendance_hours).toBe(8);
    expect(row.hours.pos_hours).toBeGreaterThan(0);
    expect(row.hours.pos_hours).not.toBe(8);
    expect(row.hours.posted_pay).toBe(160);
    expect(row.calculated_salary).toBe(160);
    const admin = await ctx.db.get("SELECT id FROM users WHERE username = 'testadmin'");
    const payout = await confirmPayrollPayout(
      ctx.db,
      emp.employeeId,
      {
        period_from: "2026-10-01",
        period_to: "2026-10-31",
        occurred_on: "2026-10-31",
        cash_paid: 160,
        payment_method: "transfer",
        salary_before_deductions: 160,
        idempotency_key: `zk-cashier-${emp.employeeId}`,
      },
      { user: { id: admin.id }, headers: {} }
    );
    expect(payout).toBeTruthy();
    const period = await ctx.db.get(
      "SELECT source FROM employee_salary_periods WHERE employee_id = ? ORDER BY id DESC LIMIT 1",
      [emp.employeeId]
    );
    expect(period.source).toBe("attendance");
  });

  test("a cashier with attendance and no POS shift is still paid", async () => {
    const emp = await makeEmployee({ name: "No Shift", role: "cashier", rate: 12 });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    await mapAndImport(emp.employeeId, "91", [tap("91", "2026-10-04", 9, 0), tap("91", "2026-10-04", 13, 0)]);
    const row = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    expect(row.hours.posted_pay).toBe(shiftPay(12, 4));
    expect(row.hours.pos_hours).toBe(0);
    expect(row.hours.warnings || []).not.toContain("missing_attendance");
  });

  test("a cashier with a POS shift and no attendance gets zero pay and a warning", async () => {
    const emp = await makeEmployee({ name: "Shift Only", role: "cashier", rate: 30 });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    const start = new Date(shopLocalToUtcMs("2026-10-05", 8, 0, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-10-05", 16, 0, 0)).toISOString();
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 50, 'closed', 30)`,
      [emp.userId, start, end]
    );
    const row = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    expect(row.hours.posted_pay).toBe(0);
    expect(row.calculated_salary).toBe(0);
    expect(row.hours.pos_hours).toBe(8);
    expect(row.hours.warnings).toContain("missing_attendance");
  });

  test("before cutover a cashier is still paid from the POS shift only", async () => {
    const emp = await makeEmployee({ name: "Before", role: "cashier", rate: 10 });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    await mapAndImport(emp.employeeId, "92", [tap("92", "2026-09-15", 8, 0), tap("92", "2026-09-15", 12, 0)]);
    const start = new Date(shopLocalToUtcMs("2026-09-15", 8, 0, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-09-15", 16, 0, 0)).toISOString();
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 20, 'closed', 10)`,
      [emp.userId, start, end]
    );
    const row = await preview(ctx.db, emp.employeeId, "2026-09-01", "2026-09-30");
    expect(row.hours.attendance_authoritative).toBeFalsy();
    expect(row.hours.posted_pay).toBe(80);
    expect(row.calculated_salary).toBe(80);
  });

  test("bakery legacy sessions stay in effect before cutover and device hours after it", async () => {
    setAttendanceNow(new Date(shopLocalToUtcMs("2026-10-03", 18, 0, 0)));
    const bakery = await makeEmployee({
      name: "Bakery",
      role: "bakery_employee",
      rate: 15,
      wageBasis: "hourly",
    });
    await checkInAttendance(
      ctx.db,
      { userId: bakery.userId, checkInAt: "2026-09-15T08:00", checkOutAt: "2026-09-15T16:00" },
      null
    );
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    await mapAndImport(bakery.employeeId, "93", [tap("93", "2026-10-02", 8, 0), tap("93", "2026-10-02", 12, 0)]);
    await checkInAttendance(
      ctx.db,
      { userId: bakery.userId, checkInAt: "2026-10-02T13:00", checkOutAt: "2026-10-02T15:00" },
      null
    );
    const september = await preview(ctx.db, bakery.employeeId, "2026-09-01", "2026-09-30");
    const october = await preview(ctx.db, bakery.employeeId, "2026-10-01", "2026-10-31");
    const both = await preview(ctx.db, bakery.employeeId, "2026-09-01", "2026-10-31");
    expect(september.hours.attendance_authoritative).toBeFalsy();
    expect(september.hours.posted_pay).toBe(120);
    expect(october.hours.payroll_source).toBe("attendance");
    expect(october.hours.posted_pay).toBe(60);
    expect(both.hours.payroll_source).toBe("split");
    expect(both.hours.posted_pay).toBe(180);

    const shelves = await makeEmployee({
      name: "Shelves",
      role: "shelves_employee",
      rate: 11,
      wageBasis: "hourly",
    });
    await mapAndImport(shelves.employeeId, "94", [tap("94", "2026-10-06", 8, 0), tap("94", "2026-10-06", 10, 0)]);
    const shelvesPreview = await preview(ctx.db, shelves.employeeId, "2026-10-01", "2026-10-31");
    expect(shelvesPreview.hours.posted_pay).toBe(shiftPay(11, 2));
    setAttendanceNow(null);
  });

  test("manual OUT fills a missing checkout and a voided device punch is not recreated", async () => {
    const emp = await makeEmployee({ name: "Correct", role: "cashier", rate: 20 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "95", [tap("95", "2026-06-20", 8, 0, 0, { rawRecordId: "keep" })]);
    await addManualPunch(ctx.db, {
      employeeId: emp.employeeId,
      punchType: "out",
      punchedAt: "2026-06-20T16:00",
      note: "نسي الانصراف",
    });
    const paid = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-20",
      to: "2026-06-20",
      nowMs: shopLocalToUtcMs("2026-06-21", 12, 0, 0),
    });
    expect(paid.sessions[0]).toMatchObject({ status: "closed", hours: 8, pay: 160, manual: true });
    const devicePunch = await ctx.db.get(
      `SELECT p.id FROM attendance_interpreted_punches p
       JOIN attendance_device_events e ON e.interpreted_punch_id = p.id
       WHERE e.device_user_id = '95' AND p.source = 'device'`
    );
    await voidInterpretedPunch(ctx.db, devicePunch.id, { reason: "بصمة خاطئة" });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("95", "2026-06-20", 8, 0, 0, { rawRecordId: "keep" })] },
      { deviceKey: DEVICE }
    );
    const punches = await ctx.db.all(
      `SELECT p.status, p.source FROM attendance_interpreted_punches p
       WHERE p.employee_id = ? ORDER BY p.id`,
      [emp.employeeId]
    );
    const deviceRows = punches.filter((row) => row.source === "device");
    expect(deviceRows).toEqual([{ status: "void", source: "device" }]);
    const rawLeft = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = '95'"
    );
    expect(rawLeft.n).toBe(1);
  });

  test("device offline is recorded and payroll still reads the local database", async () => {
    const emp = await makeEmployee({ name: "Offline", role: "cashier", rate: 10 });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await mapAndImport(emp.employeeId, "96", [tap("96", "2026-06-21", 8, 0), tap("96", "2026-06-21", 12, 0)]);
    let calls = 0;
    const failed = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 3,
      timeoutMs: 1000,
      readSnapshot: async () => {
        calls += 1;
        throw new Error("device offline");
      },
    });
    expect(calls).toBe(3);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/offline/);
    const row = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(row.calculated_salary).toBe(40);
    const status = await request(ctx.app)
      .get("/api/v1/attendance/device/status")
      .set(authHeader(adminToken));
    expect(status.status).toBe(200);
    expect(unwrap(status.body).last_error).toMatch(/offline/);
  });

  test("reconnect imports only the taps that were missed", async () => {
    const emp = await makeEmployee({ name: "Reconnect", role: "cashier", rate: 10 });
    const first = [tap("97", "2026-06-22", 8, 0)];
    const second = [tap("97", "2026-06-22", 8, 0), tap("97", "2026-06-22", 16, 0, 0, { rawRecordId: "later" })];
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "97", employeeId: emp.employeeId });
    await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      readSnapshot: async () => ({ users: [{ deviceUserId: "97", name: "R" }], records: first }),
    });
    const again = await syncZkteco(ctx.db, {
      deviceKey: DEVICE,
      attempts: 1,
      timeoutMs: 1000,
      readSnapshot: async () => ({ users: [{ deviceUserId: "97", name: "R" }], records: second }),
    });
    expect(again.ok).toBe(true);
    expect(again.inserted_events).toBe(1);
    const raw = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance_device_events WHERE device_user_id = '97'"
    );
    expect(raw.n).toBe(2);
    const built = await buildPayableAttendance(ctx.db, emp.employeeId, {
      from: "2026-06-22",
      to: "2026-06-22",
      nowMs: shopLocalToUtcMs("2026-06-23", 12, 0, 0),
    });
    expect(built.posted_hours).toBe(8);
  });

  test("Asia/Hebron wall clocks use winter and summer offsets", async () => {
    const winterWall = "2026-01-15 12:00:00";
    const summerWall = "2026-07-15 12:00:00";
    const winterSql = utcMsToSql(shopLocalToUtcMs("2026-01-15", 12, 0, 0));
    const summerSql = utcMsToSql(shopLocalToUtcMs("2026-07-15", 12, 0, 0));
    expect(winterSql).toBe("2026-01-15 10:00:00");
    expect(summerSql).toBe("2026-07-15 09:00:00");
    expect(Date.parse(`${winterSql.replace(" ", "T")}Z`) - Date.parse("2026-01-15T12:00:00Z")).not.toBe(
      Date.parse(`${summerSql.replace(" ", "T")}Z`) - Date.parse("2026-07-15T12:00:00Z")
    );
    const emp = await makeEmployee({ name: "DST", role: "cashier", rate: 10 });
    await mapAndImport(emp.employeeId, "98", [
      { deviceUserId: "98", wallClock: winterWall, rawStatus: null, rawPunch: null, rawRecordId: "w" },
      { deviceUserId: "98", wallClock: summerWall, rawStatus: null, rawPunch: null, rawRecordId: "s" },
    ]);
    const rows = await ctx.db.all(
      "SELECT wall_clock, punched_at FROM attendance_device_events WHERE device_user_id = '98' ORDER BY wall_clock"
    );
    expect(rows).toEqual([
      { wall_clock: winterWall, punched_at: winterSql },
      { wall_clock: summerWall, punched_at: summerSql },
    ]);
    const parts = shopLocalParts(summerSql);
    expect(parts).toMatchObject({ ymd: "2026-07-15", hour: 12, minute: 0 });
  });

  test("advances and employee debts stay on the system employee", async () => {
    const emp = await makeEmployee({ name: "Ledger", role: "cashier", rate: 10 });
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "99", employeeId: emp.employeeId });
    await ctx.db.run(
      `INSERT INTO employee_ledger_entries
         (employee_id, entry_type, purpose, occurred_on, amount, event_seq)
       VALUES (?, 'salary_payment', 'salary_advance', '2026-06-01', 35, 1)`,
      [emp.employeeId]
    );
    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('ذمة موظف جهاز', 'ZK-DEBT', 40, 0, 500)`
    );
    await ctx.db.run("UPDATE employees SET customer_id = ? WHERE id = ?", [customer.lastID, emp.employeeId]);
    const tx = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number)
       VALUES (?, '[]', 40, 0, 40, 'on_account', ?, ?, 'completed', '2026-06-02 10:00:00', 'ZK-R-1')`,
      [cashierUserId, customer.lastID, emp.employeeId]
    );
    await ctx.db.run(
      "INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', 40)",
      [tx.lastID]
    );
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const row = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(row.advances_outstanding_total).toBe(35);
    expect(row.advances.map((item) => item.amount)).toEqual([35]);
    expect(row.debts.some((item) => item.employee_id === emp.employeeId && item.remaining > 0)).toBe(true);
    const ledgerCols = await ctx.db.all("PRAGMA table_info(employee_ledger_entries)");
    expect(ledgerCols.map((col) => col.name)).not.toContain("device_user_id");
  });

  test("event keys are deterministic and the mapping API is explicit", async () => {
    const keyA = attendanceEventKey({
      deviceKey: DEVICE,
      deviceUserId: "2",
      wallClock: "2026-10-03 16:31:04",
      rawStatus: 0,
      rawPunch: 1,
      rawRecordId: "9",
    });
    const keyB = attendanceEventKey({
      deviceKey: DEVICE,
      deviceUserId: "2",
      wallClock: "2026-10-03 16:31:04",
      rawStatus: 0,
      rawPunch: 1,
      rawRecordId: "9",
    });
    expect(keyA).toBe(keyB);
    const emp = await makeEmployee({ name: "Api Map", role: "cashier", rate: 8 });
    const res = await request(ctx.app)
      .put("/api/v1/attendance/device/mappings")
      .set(authHeader(adminToken))
      .send({ device_user_id: "123", employee_id: emp.employeeId });
    expect(res.status).toBe(201);
    const status = await request(ctx.app)
      .get("/api/v1/attendance/device/status")
      .set(authHeader(adminToken));
    const body = unwrap(status.body);
    const listed = (body.users || []).find((row) => row.device_user_id === "123");
    expect(listed.employee_id).toBe(emp.employeeId);
    expect(listed.employee_name).toBe("Api Map");
  });
});
