import request from "supertest";
import bcrypt from "bcrypt";
import { createTestContext, destroyTestContext, login, authHeader, createAccountantUser } from "./helpers.js";
import {
  checkInAttendance,
  setAttendanceNow,
} from "../services/attendanceSessionService.js";
import { updateAppSettings } from "../utils/settings.js";
import { shopLocalToUtcMs } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function makeStaff(db, username, role, { wageBasis = "hourly", active = 1, rate = 20 } = {}) {
  const hash = await bcrypt.hash("staffpass123", 4);
  await db.run(
    "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, ?, 0, ?)",
    [username, hash, role, rate]
  );
  const user = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  const emp = await db.run(
    "INSERT INTO employees (name, active, user_id, wage_basis) VALUES (?, ?, ?, ?)",
    [username, active, user.id, wageBasis]
  );
  return { userId: user.id, employeeId: emp.lastID };
}

describe("daily attendance reminder", () => {
  let ctx;
  let adminToken;
  let adminId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    adminId = adminLogin.body.user.id;
    await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6 });
  });

  afterAll(async () => {
    setAttendanceNow(null);
    await destroyTestContext(ctx);
  });

  afterEach(() => {
    setAttendanceNow(null);
  });

  test("lists only active hourly employees missing attendance for the business day", async () => {
    setAttendanceNow(shopLocalToUtcMs("2026-05-10", 10, 0));
    const missing = await makeStaff(ctx.db, "remind-shelf", "shelves_employee");
    const bakery = await makeStaff(ctx.db, "remind-bakery", "bakery_employee");
    await makeStaff(ctx.db, "remind-daily", "shelves_employee", { wageBasis: "daily" });
    await makeStaff(ctx.db, "remind-inactive", "shelves_employee", { active: 0 });
    const cashier = await makeStaff(ctx.db, "remind-cashier", "cashier", { wageBasis: "hourly" });
    const recorded = await makeStaff(ctx.db, "remind-done", "shelves_employee");
    const stillOpen = await makeStaff(ctx.db, "remind-open", "bakery_employee");

    await checkInAttendance(ctx.db, {
      userId: recorded.userId,
      checkInAt: "2026-05-10 08:00:00",
      checkOutAt: "2026-05-10 09:30:00",
    });
    await checkInAttendance(ctx.db, {
      userId: stillOpen.userId,
      checkInAt: "2026-05-10 02:00:00",
    });

    const before = await ctx.db.get("SELECT COUNT(*) AS c FROM attendance_sessions");
    const res = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = unwrap(res.body);
    expect(body.business_day).toBe("2026-05-10");
    expect(body.dismissed).toBe(false);
    const ids = body.employees.map((row) => row.user_id);
    expect(ids).toEqual(expect.arrayContaining([missing.userId, bakery.userId]));
    expect(ids).not.toContain(cashier.userId);
    expect(ids).not.toContain(recorded.userId);
    expect(ids).not.toContain(stillOpen.userId);
    expect(body.employees.some((row) => row.name === "remind-daily" || row.name === "remind-inactive")).toBe(false);
    const after = await ctx.db.get("SELECT COUNT(*) AS c FROM attendance_sessions");
    expect(after.c).toBe(before.c);
  });

  test("cashier and an accountant without payroll permission cannot read the reminder", async () => {
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const denied = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(cashierLogin.body.token));
    expect(denied.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "remind-no-pay",
      permissions: { employee_payroll: false },
    });
    const acct = await login(ctx.app, "remind-no-pay", "acctpass123");
    const hidden = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(acct.body.token));
    expect(hidden.status).toBe(403);
  });

  test("dismissal is per user and per business day and does not write attendance", async () => {
    setAttendanceNow(shopLocalToUtcMs("2026-05-11", 9, 0));
    await createAccountantUser(ctx.db, { username: "remind-acct", permissions: { employee_payroll: true } });
    const acct = await login(ctx.app, "remind-acct", "acctpass123");
    const sessionsBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM attendance_sessions");

    const dismiss = await request(ctx.app)
      .post("/api/v1/attendance/reminder/dismiss")
      .set(authHeader(adminToken));
    expect(dismiss.status).toBe(200);
    expect(unwrap(dismiss.body).business_day).toBe("2026-05-11");

    const adminAgain = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(adminToken));
    expect(unwrap(adminAgain.body).dismissed).toBe(true);

    const acctView = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(acct.body.token));
    expect(acctView.status).toBe(200);
    expect(unwrap(acctView.body).dismissed).toBe(false);

    setAttendanceNow(shopLocalToUtcMs("2026-05-12", 9, 0));
    const nextDay = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(adminToken));
    expect(unwrap(nextDay.body).business_day).toBe("2026-05-12");
    expect(unwrap(nextDay.body).dismissed).toBe(false);

    const sessionsAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM attendance_sessions");
    expect(sessionsAfter.c).toBe(sessionsBefore.c);
    const payroll = await ctx.db.get("SELECT COUNT(*) AS c FROM employee_period_attendance");
    expect(payroll.c).toBe(0);
  });

  test("a second check-in is refused when attendance was recorded and the list is current", async () => {
    setAttendanceNow(shopLocalToUtcMs("2026-05-13", 11, 0));
    const staff = await makeStaff(ctx.db, "remind-race", "shelves_employee");
    const first = await request(ctx.app)
      .post("/api/v1/attendance/sessions/check-in")
      .set(authHeader(adminToken))
      .send({ user_id: staff.userId, check_in_at: "2026-05-13 08:00:00" });
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post("/api/v1/attendance/sessions/check-in")
      .set(authHeader(adminToken))
      .send({ user_id: staff.userId, check_in_at: "2026-05-13 09:00:00" });
    expect(second.status).toBe(409);

    const reminder = await request(ctx.app)
      .get("/api/v1/attendance/reminder")
      .set(authHeader(adminToken));
    const ids = unwrap(reminder.body).employees.map((row) => row.user_id);
    expect(ids).not.toContain(staff.userId);
    expect(adminId).toEqual(expect.any(Number));
  });
});
