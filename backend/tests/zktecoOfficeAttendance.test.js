import request from "supertest";
import bcrypt from "bcrypt";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import { ATTENDANCE_ROLES, ATTENDANCE_TRACKED_ROLES, isAttendanceTrackedRole } from "../utils/roles.js";
import { getPayrollPreview } from "../services/employeePayrollService.js";
import {
  importAttendanceSnapshot,
  saveDeviceMapping,
  addManualPunch,
  listAttendanceTrackablePeople,
} from "../services/attendanceDeviceImport.js";
import { buildPayableAttendance } from "../services/payableAttendance.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { shopLocalToUtcMs } from "../utils/shopTime.js";
import { shiftPay } from "../services/cashierPayrollService.js";

const DEVICE = "mb160";

function unwrap(body) {
  return body?.data ?? body;
}

function tap(deviceUserId, ymd, hh, mm, ss = 0) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    deviceUserId: String(deviceUserId),
    wallClock: `${ymd} ${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    rawStatus: 0,
    rawPunch: 0,
    rawRecordId: null,
  };
}

async function preview(db, employeeId, from, to) {
  return getPayrollPreview(db, employeeId, { period_from: from, period_to: to, as_of: to });
}

describe("office roles on device attendance", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeUser(username, role) {
    const hash = await bcrypt.hash("officepass1", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
      [username, hash, role]
    );
    return ctx.db.get("SELECT id, username, role FROM users WHERE username = ?", [username]);
  }

  test("attendance tracking includes admin and accountant without changing payroll roles", () => {
    expect(isAttendanceTrackedRole("admin")).toBe(true);
    expect(isAttendanceTrackedRole("accountant")).toBe(true);
    expect(ATTENDANCE_TRACKED_ROLES).toEqual(
      expect.arrayContaining(["cashier", "bakery_employee", "shelves_employee", "admin", "accountant"])
    );
    expect(ATTENDANCE_ROLES).not.toContain("admin");
    expect(ATTENDANCE_ROLES).not.toContain("accountant");
  });

  test("admin and accountant can be mapped, including an admin who has no employee row yet", async () => {
    const admin = await makeUser("zk-admin", "admin");
    const before = await listAttendanceTrackablePeople(ctx.db);
    expect(before.some((row) => row.user_id === admin.id && row.employee_id == null && row.role === "admin")).toBe(
      true
    );

    const mapped = await request(ctx.app)
      .put("/api/v1/attendance/device/mappings")
      .set(authHeader(adminToken))
      .send({ device_user_id: "301", user_id: admin.id });
    expect(mapped.status).toBe(201);
    const adminEmp = await ctx.db.get("SELECT id, wage_basis, daily_rate FROM employees WHERE user_id = ?", [
      admin.id,
    ]);
    expect(adminEmp.wage_basis).toBeNull();
    expect(unwrap(mapped.body).employee_id).toBe(adminEmp.id);

    const accountant = await makeUser("zk-accountant", "accountant");
    await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis, daily_rate) VALUES (?, 1, ?, 'daily', 90)",
      ["محاسب يومي", accountant.id]
    );
    const acctEmp = await ctx.db.get("SELECT id FROM employees WHERE user_id = ?", [accountant.id]);
    await saveDeviceMapping(ctx.db, {
      deviceKey: DEVICE,
      deviceUserId: "302",
      employeeId: acctEmp.id,
    });
    const people = await listAttendanceTrackablePeople(ctx.db);
    expect(people.filter((row) => row.user_id === admin.id)).toHaveLength(1);
    expect(people.some((row) => row.employee_id === acctEmp.id && row.role === "accountant")).toBe(true);
  });

  test("admin and accountant IN/OUT sessions are visible and do not change daily pay", async () => {
    const admin = await ctx.db.get("SELECT e.id, e.daily_rate FROM employees e JOIN users u ON u.id = e.user_id WHERE u.username = 'zk-admin'");
    await ctx.db.run("UPDATE employees SET wage_basis = 'daily', daily_rate = 100 WHERE id = ?", [admin.id]);
    const before = await preview(ctx.db, admin.id, "2026-06-01", "2026-06-30");
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("301", "2026-06-10", 8, 0), tap("301", "2026-06-10", 16, 0)] },
      { deviceKey: DEVICE }
    );
    const sessions = await buildPayableAttendance(ctx.db, admin.id, {
      from: "2026-06-10",
      to: "2026-06-10",
      nowMs: shopLocalToUtcMs("2026-06-11", 12, 0, 0),
    });
    expect(sessions.sessions[0]).toMatchObject({ status: "closed", hours: 8 });
    const after = await preview(ctx.db, admin.id, "2026-06-01", "2026-06-30");
    expect(after.calculated_salary).toBe(before.calculated_salary);
    expect(after.hours.daily_rate).toBe(100);
    expect(after.hours.daily_accrual).toBe(false);
    expect(after.hours.pay_from_attendance_hours).toBe(false);
    expect(after.hours.attendance_hours).toBe(8);
    expect(after.hours.applicable).toBe(false);

    const acct = await ctx.db.get(
      "SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id WHERE u.username = 'zk-accountant'"
    );
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("302", "2026-06-11", 9, 0), tap("302", "2026-06-11", 17, 0)] },
      { deviceKey: DEVICE }
    );
    const acctPreview = await preview(ctx.db, acct.id, "2026-06-01", "2026-06-30");
    expect(acctPreview.hours.informational_sessions[0]).toMatchObject({ status: "closed", hours: 8 });
    expect(acctPreview.hours.daily_rate).toBe(90);
    expect(acctPreview.calculated_salary).toBeNull();
    expect(acctPreview.hours.pay_from_attendance_hours).toBe(false);
  });

  test("missing checkout warns for an admin and a manual correction closes an accountant session", async () => {
    const admin = await ctx.db.get(
      "SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id WHERE u.username = 'zk-admin'"
    );
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("301", "2026-06-12", 8, 0, 0)] },
      { deviceKey: DEVICE }
    );
    const missing = await buildPayableAttendance(ctx.db, admin.id, {
      from: "2026-06-12",
      to: "2026-06-12",
      nowMs: shopLocalToUtcMs("2026-06-13", 8, 0, 0),
    });
    expect(missing.sessions.some((row) => row.status === "missing_checkout" && row.pay === 0)).toBe(true);
    expect(missing.warnings).toContain("missing_checkout");
    const adminPay = await preview(ctx.db, admin.id, "2026-06-12", "2026-06-12");
    expect(adminPay.hours.attendance_warnings).toContain("missing_checkout");
    expect(adminPay.calculated_salary).toBeNull();
    expect(adminPay.hours.daily_rate).toBe(100);

    const acct = await ctx.db.get(
      "SELECT e.id, e.daily_rate FROM employees e JOIN users u ON u.id = e.user_id WHERE u.username = 'zk-accountant'"
    );
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "303", employeeId: acct.id });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("303", "2026-06-13", 8, 0)] },
      { deviceKey: DEVICE }
    );
    await addManualPunch(ctx.db, {
      employeeId: acct.id,
      punchType: "out",
      punchedAt: "2026-06-13T16:00",
      note: "تصحيح انصراف المحاسب",
    });
    const corrected = await buildPayableAttendance(ctx.db, acct.id, {
      from: "2026-06-13",
      to: "2026-06-13",
      nowMs: shopLocalToUtcMs("2026-06-14", 12, 0, 0),
    });
    expect(corrected.sessions.some((row) => row.status === "closed" && row.hours === 8 && row.manual)).toBe(true);
    const stillDaily = await ctx.db.get("SELECT wage_basis, daily_rate FROM employees WHERE id = ?", [acct.id]);
    expect(stillDaily.wage_basis).toBe("daily");
    expect(Number(stillDaily.daily_rate)).toBe(90);
    const pay = await preview(ctx.db, acct.id, "2026-06-13", "2026-06-13");
    expect(pay.calculated_salary).toBeNull();
    expect(pay.hours.pay_from_attendance_hours).toBe(false);
  });

  test("hourly payroll still uses attendance hours after cutover", async () => {
    const hash = await bcrypt.hash("hourlypass1", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES ('zk-hourly', ?, 'bakery_employee', 0, 15)",
      [hash]
    );
    const user = await ctx.db.get("SELECT id FROM users WHERE username = 'zk-hourly'");
    const emp = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis) VALUES ('ساعة', 1, ?, 'hourly')",
      [user.id]
    );
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "304", employeeId: emp.lastID });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("304", "2026-06-14", 8, 0), tap("304", "2026-06-14", 16, 0)] },
      { deviceKey: DEVICE }
    );
    const row = await preview(ctx.db, emp.lastID, "2026-06-01", "2026-06-30");
    expect(row.hours.pay_from_attendance_hours).not.toBe(false);
    expect(row.calculated_salary).toBe(shiftPay(15, 8));
    expect(row.hours.posted_pay).toBe(120);
  });
});
