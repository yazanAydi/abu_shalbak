import request from "supertest";
import bcrypt from "bcrypt";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import {
  attendanceNow,
  checkInAttendance,
  checkOutAttendance,
  closeOverdueAttendanceSessions,
  correctAttendanceCheckout,
  setAttendanceNow,
} from "../services/attendanceSessionService.js";
import { shopLocalToUtcMs, utcMsToSql } from "../utils/shopTime.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function makeStaff(db, username, role, rate) {
  const hash = await bcrypt.hash("staffpass123", 4);
  await db.run(
    "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, ?, 0, ?)",
    [username, hash, role, rate]
  );
  const user = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  const emp = await db.run(
    "INSERT INTO employees (name, active, user_id) VALUES (?, 1, ?)",
    [username, user.id]
  );
  return { userId: user.id, employeeId: emp.lastID };
}

describe("hourly attendance sessions", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    setAttendanceNow(null);
    await destroyTestContext(ctx);
  });

  afterEach(() => {
    setAttendanceNow(null);
  });

  test("cashier creation keeps shift pay and is not auto-closed", async () => {
    const rejected = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: "cashier-wage",
        password: "cashier123",
        role: "cashier",
        hourly_rate: 18,
        wage_basis: "hourly",
      });
    expect(rejected.status).toBe(400);

    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: "cashier-keep", password: "cashier123", role: "cashier", hourly_rate: 18 });
    expect(created.status).toBe(201);
    const userId = unwrap(created.body).id;
    await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, hourly_rate_snapshot, start_time)
       VALUES (?, 0, 'open', 18, ?)`,
      [userId, "2026-01-01 05:00:00"]
    );
    setAttendanceNow("2026-01-02T00:00:00.000Z");
    const job = await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    expect(job.closed).toBe(0);
    const shift = await ctx.db.get("SELECT status, end_time FROM cashier_shifts WHERE cashier_id = ?", [userId]);
    expect(shift.status).toBe("open");
    expect(shift.end_time).toBeNull();
  });

  test("non-cashier wage basis is validated and existing rows stay unset", async () => {
    const legacy = await makeStaff(ctx.db, "legacy-shelf", "shelves_employee", 15);
    const row = await ctx.db.get("SELECT wage_basis, daily_rate FROM employees WHERE id = ?", [legacy.employeeId]);
    expect(row.wage_basis).toBeNull();
    expect(row.daily_rate).toBeNull();

    const bad = await request(ctx.app)
      .post(`/api/v1/employees/${legacy.employeeId}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "weekly", daily_rate: 10 });
    expect(bad.status).toBe(400);

    const daily = await request(ctx.app)
      .post(`/api/v1/employees/${legacy.employeeId}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "daily", daily_rate: 120 });
    expect(daily.status).toBe(200);
    expect(unwrap(daily.body).wage_basis).toBe("daily");
    expect(unwrap(daily.body).daily_rate).toBe(120);

    const hourlyUser = await makeStaff(ctx.db, "hour-shelf", "shelves_employee", 20);
    const hourly = await request(ctx.app)
      .post(`/api/v1/employees/${hourlyUser.employeeId}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "hourly", hourly_rate: 20 });
    expect(hourly.status).toBe(200);
    expect(unwrap(hourly.body).wage_basis).toBe("hourly");

    setAttendanceNow("2026-03-02T10:00:00.000Z");
    await checkInAttendance(ctx.db, { userId: hourlyUser.userId, checkInAt: "2026-03-02 08:00:00" });
    const blocked = await request(ctx.app)
      .post(`/api/v1/employees/${hourlyUser.employeeId}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "daily", daily_rate: 100 });
    expect(blocked.status).toBe(409);
  });

  test("manual 08:00–15:30 at ₪20 earns 7.5 hours and ₪150", async () => {
    const staff = await makeStaff(ctx.db, "pay-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    setAttendanceNow("2026-02-10T20:00:00.000Z");
    const row = await checkInAttendance(ctx.db, {
      userId: staff.userId,
      checkInAt: "2026-02-10 08:00:00",
      checkOutAt: "2026-02-10 15:30:00",
    });
    expect(row.hours).toBe(7.5);
    expect(row.earned_pay).toBe(150);
    expect(row.hourly_rate_snapshot).toBe(20);
    expect(row.recorded_at).toBe(utcMsToSql(attendanceNow().getTime()));
    expect(row.check_in_at).not.toBe(row.recorded_at);
  });

  test("rejects a second open session, checkout before check-in, and overlaps", async () => {
    const staff = await makeStaff(ctx.db, "guard-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    setAttendanceNow("2026-03-01T12:00:00.000Z");
    const earlyOut = await request(ctx.app)
      .post("/api/v1/attendance/sessions/check-out")
      .set(authHeader(adminToken))
      .send({ user_id: staff.userId, check_out_at: "2026-03-01 10:00:00" });
    expect(earlyOut.status).toBe(400);

    await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-03-01 08:00:00" });
    await expect(
      checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-03-01 09:00:00" })
    ).rejects.toMatchObject({ status: 409 });

    await checkOutAttendance(ctx.db, { userId: staff.userId, checkOutAt: "2026-03-01 12:00:00" });
    await expect(
      checkInAttendance(ctx.db, {
        userId: staff.userId,
        checkInAt: "2026-03-01 11:00:00",
        checkOutAt: "2026-03-01 13:00:00",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  test("overnight and daylight-saving boundaries use shop instants", async () => {
    const staff = await makeStaff(ctx.db, "night-shelf", "shelves_employee", 10);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    setAttendanceNow("2026-01-15T20:00:00.000Z");
    const overnight = await checkInAttendance(ctx.db, {
      userId: staff.userId,
      checkInAt: "2026-01-14 22:00:00",
      checkOutAt: "2026-01-15 06:00:00",
    });
    const start = shopLocalToUtcMs("2026-01-14", 22, 0);
    const end = shopLocalToUtcMs("2026-01-15", 6, 0);
    expect(overnight.hours).toBe(shiftHours(utcMsToSql(start), utcMsToSql(end)));
    expect(overnight.hours).toBe(8);

    const springIn = shopLocalToUtcMs("2026-03-28", 1, 30);
    const springOut = shopLocalToUtcMs("2026-03-28", 4, 0);
    expect(shiftHours(utcMsToSql(springIn), utcMsToSql(springOut))).toBe(1.5);
    const fallIn = shopLocalToUtcMs("2026-10-24", 0, 30);
    const fallOut = shopLocalToUtcMs("2026-10-24", 3, 30);
    expect(shiftHours(utcMsToSql(fallIn), utcMsToSql(fallOut))).toBe(4);
  });

  test("auto-close waits until exactly 12 hours and uses check-in plus 12", async () => {
    const staff = await makeStaff(ctx.db, "auto-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-04-01", 8, 0);
    setAttendanceNow(inMs + 11 * 3600000);
    const open = await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-04-01 08:00:00" });
    expect(open.status).toBe("open");
    await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    const stillOpen = await ctx.db.get("SELECT status FROM attendance_sessions WHERE id = ?", [open.id]);
    expect(stillOpen.status).toBe("open");

    const deadline = inMs + 12 * 3600000;
    setAttendanceNow(deadline + 5 * 60000);
    const job = await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    expect(job.closed).toBe(1);
    const again = await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    expect(again.closed).toBe(0);
    const stored = await ctx.db.get("SELECT * FROM attendance_sessions WHERE id = ?", [open.id]);
    expect(stored.check_out_at).toBe(utcMsToSql(deadline));
    expect(stored.close_source).toBe("auto");
    expect(stored.earned_pay).toBe(shiftPay(20, 12));
    expect(stored.recorded_check_out_at).toBe(utcMsToSql(attendanceNow().getTime()));
    expect(stored.check_out_at).not.toBe(stored.recorded_check_out_at);
  });

  test("restart catch-up restores the deadline time", async () => {
    const staff = await makeStaff(ctx.db, "catchup-shelf", "shelves_employee", 10);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-05-01", 6, 0);
    setAttendanceNow(inMs + 3600000);
    const open = await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-05-01 06:00:00" });
    setAttendanceNow(inMs + 20 * 3600000);
    await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    const stored = await ctx.db.get("SELECT check_out_at, close_source FROM attendance_sessions WHERE id = ?", [open.id]);
    expect(stored.close_source).toBe("auto");
    expect(stored.check_out_at).toBe(utcMsToSql(inMs + 12 * 3600000));
  });

  test("concurrent manual and automatic checkout leave one result", async () => {
    const staff = await makeStaff(ctx.db, "race-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-06-01", 7, 0);
    setAttendanceNow(inMs + 12 * 3600000);
    const open = await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-06-01 07:00:00" });
    await Promise.allSettled([
      checkOutAttendance(ctx.db, { userId: staff.userId, checkOutAt: "2026-06-01 18:00:00" }),
      closeOverdueAttendanceSessions(ctx.db, new Date(inMs + 12 * 3600000 + 1000)),
    ]);
    const rows = await ctx.db.all("SELECT status, check_out_at FROM attendance_sessions WHERE user_id = ?", [staff.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("closed");
    expect(rows[0].check_out_at).toBeTruthy();
    expect(open.id).toBeTruthy();
  });

  test("automatic checkout is 12 hours of real time across midnight", async () => {
    const staff = await makeStaff(ctx.db, "midnight-shelf", "shelves_employee", 10);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-09-24", 20, 0);
    setAttendanceNow(inMs + 12 * 3600000);
    const row = await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-09-24 20:00:00" });
    expect(row.status).toBe("closed");
    expect(row.close_source).toBe("auto");
    expect(row.check_out_at).toBe(utcMsToSql(inMs + 12 * 3600000));
    expect(shiftHours(utcMsToSql(inMs), row.check_out_at)).toBe(12);
    expect(shiftPay(10, 12)).toBe(120);
  });

  test("historical overdue check-in closes, and a correction is not overwritten", async () => {
    const staff = await makeStaff(ctx.db, "history-shelf", "shelves_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-06-10", 8, 0);
    setAttendanceNow(inMs + 30 * 3600000);
    const row = await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-06-10 08:00:00" });
    expect(row.status).toBe("closed");
    expect(row.close_source).toBe("auto");
    expect(row.auto_checkout_label).toBe("انصراف تلقائي بعد 12 ساعة");
    expect(row.check_out_at).toBe(utcMsToSql(inMs + 12 * 3600000));

    const corrected = await correctAttendanceCheckout(
      ctx.db,
      row.id,
      { checkOutAt: "2026-06-10 15:30:00", reason: "انصراف فعلي" },
      { user: { id: 1 }, headers: {}, ip: "127.0.0.1" }
    );
    expect(corrected.earned_pay).toBe(150);
    expect(corrected.corrected).toBe(true);
    await closeOverdueAttendanceSessions(ctx.db, attendanceNow());
    const stored = await ctx.db.get("SELECT check_out_at, corrected, close_source FROM attendance_sessions WHERE id = ?", [row.id]);
    expect(stored.corrected).toBe(1);
    expect(stored.close_source).toBe("correction");
    expect(stored.check_out_at).toBe(corrected.check_out_at);
  });

  test("rate changes keep historical session pay", async () => {
    const staff = await makeStaff(ctx.db, "rate-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    setAttendanceNow("2026-07-01T18:00:00.000Z");
    const row = await checkInAttendance(ctx.db, {
      userId: staff.userId,
      checkInAt: "2026-07-01 08:00:00",
      checkOutAt: "2026-07-01 15:30:00",
    });
    await ctx.db.run("UPDATE users SET hourly_rate = 40 WHERE id = ?", [staff.userId]);
    const stored = await ctx.db.get("SELECT earned_pay, hourly_rate_snapshot FROM attendance_sessions WHERE id = ?", [row.id]);
    expect(stored.earned_pay).toBe(150);
    expect(stored.hourly_rate_snapshot).toBe(20);
  });

  test("partial payout is unchanged when attendance is corrected afterward", async () => {
    const staff = await makeStaff(ctx.db, "payout-shelf", "shelves_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    setAttendanceNow("2026-08-02T16:00:00.000Z");
    const session = await checkInAttendance(ctx.db, {
      userId: staff.userId,
      checkInAt: "2026-08-02 08:00:00",
      checkOutAt: "2026-08-02 16:00:00",
    });
    const payout = await request(ctx.app)
      .post(`/api/v1/employees/${staff.employeeId}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-31",
        occurred_on: "2026-08-02",
        salary_before_deductions: session.earned_pay,
        cash_paid: 50,
        payment_method: "cash",
        idempotency_key: `partial-${staff.employeeId}`,
      });
    expect(payout.status).toBe(201);
    expect(unwrap(payout.body).cash_paid).toBe(50);

    await correctAttendanceCheckout(
      ctx.db,
      session.id,
      { checkOutAt: "2026-08-02 12:00:00", reason: "تصحيح بعد الصرف" },
      { user: { id: 1 }, headers: {}, ip: "127.0.0.1" }
    );
    const period = await ctx.db.get(
      "SELECT salary_before_deductions FROM employee_salary_periods WHERE employee_id = ?",
      [staff.employeeId]
    );
    expect(period.salary_before_deductions).toBe(session.earned_pay);
    const flagged = await ctx.db.get("SELECT payroll_discrepancy FROM attendance_sessions WHERE id = ?", [session.id]);
    expect(flagged.payroll_discrepancy).toBe(1);
  });

  test("open-session reads never exceed 12 hours before the job runs", async () => {
    const staff = await makeStaff(ctx.db, "cap-shelf", "bakery_employee", 20);
    await ctx.db.run("UPDATE employees SET wage_basis = 'hourly' WHERE id = ?", [staff.employeeId]);
    const inMs = shopLocalToUtcMs("2026-09-01", 8, 0);
    setAttendanceNow(inMs + 3600000);
    await checkInAttendance(ctx.db, { userId: staff.userId, checkInAt: "2026-09-01 08:00:00" });
    setAttendanceNow(inMs + 15 * 3600000);
    const report = await request(ctx.app)
      .get("/api/v1/attendance/report")
      .query({ date_from: "2026-09-01", date_to: "2026-09-02" })
      .set(authHeader(adminToken));
    expect(report.status).toBe(200);
    const employee = unwrap(report.body).employees.find((e) => e.user_id === staff.userId);
    expect(employee.total_hours).toBe(12);
    expect(employee.total_pay).toBe(shiftPay(20, 12));
    expect(employee.sessions[0].auto_checkout_label).toBe("انصراف تلقائي بعد 12 ساعة");
  });
});
