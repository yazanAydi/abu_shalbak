import bcrypt from "bcrypt";
import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import {
  importAttendanceSnapshot,
  saveDeviceMapping,
} from "../services/attendanceDeviceImport.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { migrateEmployeeHourlyRateData, EMPLOYEE_HOURLY_RATE_BACKFILL_KEY } from "../services/employeeHourlyRate.js";
import { shopLocalToUtcMs, utcMsToSql } from "../utils/shopTime.js";
import { zktecoConfig } from "../services/zkteco/config.js";

const DEVICE = "mb160";

function unwrap(body) {
  return body?.data ?? body;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function tap(deviceUserId, ymd, hh, mm, ss = 0) {
  return {
    deviceUserId: String(deviceUserId),
    wallClock: `${ymd} ${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    rawStatus: 0,
    rawPunch: 0,
    rawRecordId: `${deviceUserId}-${ymd}-${hh}${mm}${ss}`,
  };
}

function localSql(ymd, hour, minute = 0) {
  return utcMsToSql(shopLocalToUtcMs(ymd, hour, minute, 0));
}

describe("employee wage, fingerprint payroll, and account relink", () => {
  let ctx;
  let adminToken;
  let adminId;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
    adminId = adminLogin.body.user.id;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await setPayrollAttendanceCutover(ctx.db, "");
  });

  async function mapAndImport(employeeId, deviceUserId, records) {
    await saveDeviceMapping(ctx.db, {
      deviceKey: DEVICE,
      deviceUserId: String(deviceUserId),
      employeeId,
    });
    return importAttendanceSnapshot(
      ctx.db,
      { users: [{ deviceUserId: String(deviceUserId), name: "device" }], records },
      { deviceKey: DEVICE }
    );
  }

  async function createEmployee(name) {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function setHourly(employeeId, rate) {
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${employeeId}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "hourly", hourly_rate: rate });
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function preview(employeeId, from, to) {
    const res = await request(ctx.app)
      .get(`/api/v1/employees/${employeeId}/payroll-preview`)
      .query({ period_from: from, period_to: to })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  async function createStaff(role, extra = {}) {
    const username = extra.username || `wage-${role}-${Math.floor(Math.random() * 1e9)}`;
    const res = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ password: "staffpass1", ...extra, username, role });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function insertShift(cashierId, ymd, startHour, endHour, rate) {
    const ins = await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, closing_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 0, 0, 'closed', ?)`,
      [cashierId, localSql(ymd, startHour), localSql(ymd, endHour), rate]
    );
    return ins.lastID;
  }

  test("a standalone hourly employee is payable from fingerprint hours without a login", async () => {
    const employee = await createEmployee("بصمة بلا حساب");
    await setHourly(employee.id, 20);
    await mapAndImport(employee.id, "solo1", [tap("solo1", "2026-06-02", 8, 0), tap("solo1", "2026-06-02", 16, 0)]);
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");

    const row = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${employee.id}`).set(authHeader(adminToken))).body
    );
    expect(row.user_id).toBeNull();
    expect(row.hourly_rate).toBe(20);

    const payroll = await preview(employee.id, "2026-06-01", "2026-06-30");
    expect(payroll.hours.recorded_hours).toBe(8);
    expect(payroll.hours.posted_hours).toBe(8);
    expect(payroll.hours.posted_pay).toBe(160);
    expect(payroll.summary.gross_known).toBe(true);
    expect(payroll.summary.gross_salary).toBe(160);

    const device = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/attendance/device/employees/${employee.id}`)
          .query({ from: "2026-06-01", to: "2026-06-30" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(device.recorded_hours).toBe(8);
    expect(device.posted_hours).toBe(8);
    expect(device.sessions[0].pay).toBe(160);
  });

  test("creating an account can link an existing employee and does not merge a same name", async () => {
    const standing = await createEmployee("نادر");
    await setHourly(standing.id, 30);
    const before = (await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n;

    const linked = await createStaff("cashier", { employee_id: standing.id });
    expect(linked.employee_id).toBe(standing.id);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(before);
    const userRate = await ctx.db.get("SELECT hourly_rate FROM users WHERE id = ?", [linked.id]);
    expect(Number(userRate.hourly_rate)).toBe(30);
    const employeeRate = await ctx.db.get("SELECT hourly_rate, user_id FROM employees WHERE id = ?", [standing.id]);
    expect(Number(employeeRate.hourly_rate)).toBe(30);
    expect(employeeRate.user_id).toBe(linked.id);

    const twin = await createStaff("bakery_employee", { username: "نادر" });
    expect(twin.employee_id).not.toBe(standing.id);
    expect(twin.employee_name).toBe("نادر");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(before + 1);
    const still = await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [standing.id]);
    expect(still.user_id).toBe(linked.id);

    const empty = await request(ctx.app)
      .post("/api/v1/admin/users/reconcile-employees")
      .set(authHeader(adminToken))
      .send({});
    expect(empty.status).toBe(400);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(before + 1);
  });

  test("an established employee keeps attendance and receives the login from an empty duplicate", async () => {
    const target = await createEmployee("السجل المعتمد");
    await setHourly(target.id, 18);
    await mapAndImport(target.id, "keep1", [tap("keep1", "2026-06-04", 8, 0), tap("keep1", "2026-06-04", 16, 0)]);
    const punchBefore = await ctx.db.get(
      "SELECT id, hourly_rate_snapshot FROM attendance_interpreted_punches WHERE employee_id = ? AND punch_type = 'in'",
      [target.id]
    );
    await ctx.db.run(
      `INSERT INTO employee_ledger_entries
         (employee_id, entry_type, purpose, occurred_on, amount, event_seq, status)
       VALUES (?, 'salary_payment', 'salary_advance', '2026-06-04', 40, 1, 'active')`,
      [target.id]
    );
    await ctx.db.run(
      `INSERT INTO advance_requests (cashier_id, employee_id, employee_name, amount, status)
       VALUES (?, ?, 'السجل المعتمد', 25, 'approved')`,
      [adminId, target.id]
    );
    await ctx.db.run(
      `INSERT INTO employee_salary_periods
         (employee_id, period_from, period_to, source, status)
       VALUES (?, '2026-05-01', '2026-05-31', 'manual', 'active')`,
      [target.id]
    );

    const sourceAccount = await createStaff("shelves_employee");
    const sourceId = sourceAccount.employee_id;
    const note = "نقل الحساب الفارغ إلى السجل المعتمد";
    const previewRes = await request(ctx.app)
      .post(`/api/v1/employees/${target.id}/account-relink/preview`)
      .set(authHeader(adminToken))
      .send({ source_employee_id: sourceId, note });
    expect(previewRes.status).toBe(200);
    const previewBody = unwrap(previewRes.body);
    expect(previewBody.blocked).toBe(false);

    const applyRes = await request(ctx.app)
      .post(`/api/v1/employees/${target.id}/account-relink`)
      .set(authHeader(adminToken))
      .send({ source_employee_id: sourceId, note, preview_token: previewBody.preview_token });
    expect(applyRes.status).toBe(200);

    const targetRow = await ctx.db.get("SELECT user_id, hourly_rate, wage_basis FROM employees WHERE id = ?", [target.id]);
    const sourceRow = await ctx.db.get("SELECT id, user_id FROM employees WHERE id = ?", [sourceId]);
    expect(targetRow.user_id).toBe(sourceAccount.id);
    expect(Number(targetRow.hourly_rate)).toBe(18);
    expect(sourceRow.id).toBe(sourceId);
    expect(sourceRow.user_id).toBeNull();
    const login = await ctx.db.get("SELECT hourly_rate FROM users WHERE id = ?", [sourceAccount.id]);
    expect(Number(login.hourly_rate)).toBe(18);
    const punchAfter = await ctx.db.get("SELECT employee_id, hourly_rate_snapshot FROM attendance_interpreted_punches WHERE id = ?", [
      punchBefore.id,
    ]);
    expect(punchAfter.employee_id).toBe(target.id);
    expect(Number(punchAfter.hourly_rate_snapshot)).toBe(Number(punchBefore.hourly_rate_snapshot));
    expect((await ctx.db.get("SELECT employee_id FROM employee_ledger_entries WHERE employee_id = ?", [target.id])).employee_id).toBe(target.id);
    expect((await ctx.db.get("SELECT employee_id FROM advance_requests WHERE employee_id = ?", [target.id])).employee_id).toBe(target.id);
    expect((await ctx.db.get("SELECT employee_id FROM employee_salary_periods WHERE employee_id = ?", [target.id])).employee_id).toBe(target.id);
  });

  test("relink is rejected when the source login has a shift or the source employee has history", async () => {
    const target = await createEmployee("هدف بلا حساب");
    await setHourly(target.id, 12);
    const shifted = await createStaff("cashier");
    await insertShift(shifted.id, "2026-06-01", 8, 12, 12);
    const note = "محاولة نقل حساب له وردية";
    const blockedShift = await request(ctx.app)
      .post(`/api/v1/employees/${target.id}/account-relink/preview`)
      .set(authHeader(adminToken))
      .send({ source_employee_id: shifted.employee_id, note });
    expect(blockedShift.status).toBe(200);
    expect(unwrap(blockedShift.body).blocked).toBe(true);
    expect(unwrap(blockedShift.body).blocks.some((row) => row.code === "SOURCE_USER_HISTORY")).toBe(true);
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [target.id])).user_id).toBeNull();
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [shifted.employee_id])).user_id).toBe(shifted.id);

    const messy = await createEmployee("مصدر فيه حضور");
    const messyUser = await createStaff("bakery_employee", { employee_id: messy.id });
    await mapAndImport(messy.id, "messy1", [tap("messy1", "2026-06-05", 8, 0), tap("messy1", "2026-06-05", 9, 0)]);
    const targetTwo = await createEmployee("هدف ثاني");
    const blockedHistory = await request(ctx.app)
      .post(`/api/v1/employees/${targetTwo.id}/account-relink/preview`)
      .set(authHeader(adminToken))
      .send({ source_employee_id: messy.id, note: "مصدر فيه بصمات" });
    expect(unwrap(blockedHistory.body).blocked).toBe(true);
    expect(unwrap(blockedHistory.body).blocks.some((row) => row.code === "SOURCE_EMPLOYEE_HISTORY")).toBe(true);
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [messy.id])).user_id).toBe(messyUser.id);
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [targetTwo.id])).user_id).toBeNull();
  });

  test("missing wage setup still shows recorded hours and a later rate does not reprice old punches", async () => {
    const employee = await createEmployee("بلا أجر بعد");
    await mapAndImport(employee.id, "norate", [tap("norate", "2026-06-06", 8, 0), tap("norate", "2026-06-06", 16, 0)]);
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const open = await preview(employee.id, "2026-06-01", "2026-06-30");
    expect(open.hours.recorded_hours).toBe(8);
    expect(open.hours.posted_hours).toBe(0);
    expect(open.hours.posted_pay).toBe(0);
    expect(open.summary.gross_known).toBe(false);
    expect(open.summary.gross_salary).toBeNull();
    expect(open.hours.warning_labels.join(" ")).toContain("أجر الساعة غير محفوظ لجلسة الحضور");
    expect(open.hours.warnings).toContain("missing_hourly_setup");

    await setHourly(employee.id, 22);
    const punch = await ctx.db.get(
      "SELECT hourly_rate_snapshot FROM attendance_interpreted_punches WHERE employee_id = ? AND punch_type = 'in'",
      [employee.id]
    );
    expect(punch.hourly_rate_snapshot).toBeNull();
    const after = await preview(employee.id, "2026-06-01", "2026-06-30");
    expect(after.hours.recorded_hours).toBe(8);
    expect(after.hours.posted_hours).toBe(0);
    expect(after.summary.gross_known).toBe(false);
  });

  test("historical correction repairs missing snapshots, leaves locked and positive rows, and rejects a stale preview", async () => {
    const employee = await createEmployee("تصحيح الأجر");
    await setHourly(employee.id, 20);
    await mapAndImport(employee.id, "fix1", [tap("fix1", "2026-05-02", 8, 0), tap("fix1", "2026-05-02", 16, 0)]);
    await ctx.db.run("UPDATE employees SET hourly_rate = NULL WHERE id = ?", [employee.id]);
    await mapAndImport(employee.id, "fix1", [tap("fix1", "2026-06-08", 8, 0), tap("fix1", "2026-06-08", 12, 0)]);
    await mapAndImport(employee.id, "fix1", [tap("fix1", "2026-07-08", 8, 0), tap("fix1", "2026-07-08", 16, 0)]);

    const punches = await ctx.db.all(
      `SELECT id, hourly_rate_snapshot FROM attendance_interpreted_punches
       WHERE employee_id = ? AND punch_type = 'in' ORDER BY id`,
      [employee.id]
    );
    const [may, june, july] = punches;
    expect(Number(may.hourly_rate_snapshot)).toBe(20);
    expect(june.id).toEqual(expect.any(Number));
    expect(july.id).toEqual(expect.any(Number));

    const period = await ctx.db.run(
      `INSERT INTO employee_salary_periods
         (employee_id, period_from, period_to, salary_before_deductions, source, status)
       VALUES (?, '2026-06-01', '2026-06-30', 500, 'attendance', 'active')`,
      [employee.id]
    );
    await ctx.db.run(
      `INSERT INTO employee_period_device_sessions
         (period_id, in_punch_id, employee_id, shop_start_on, hours, hourly_rate, pay, session_status, included_in_final)
       VALUES (?, ?, ?, '2026-04-01', 4, NULL, 0, 'closed', 1)`,
      [period.lastID, june.id, employee.id]
    );
    const aprilPeriod = await ctx.db.run(
      `INSERT INTO employee_salary_periods
         (employee_id, period_from, period_to, source, status)
       VALUES (?, '2026-04-01', '2026-04-30', 'attendance', 'active')`,
      [employee.id]
    );
    await ctx.db.run("UPDATE attendance_interpreted_punches SET punched_at = ? WHERE id = ?", [
      localSql("2026-04-02", 8),
      june.id,
    ]);
    await ctx.db.run(
      `UPDATE employee_period_device_sessions SET period_id = ?, shop_start_on = '2026-04-02' WHERE in_punch_id = ?`,
      [aprilPeriod.lastID, june.id]
    );

    const note = "حفظ أجر الجلسات الناقصة";
    const first = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${employee.id}/attendance-rate-correction/preview`)
          .set(authHeader(adminToken))
          .send({ from: "2026-04-01", to: "2026-07-31", hourly_rate: 25, note })
      ).body
    );
    expect(first.eligible.map((row) => row.id)).toEqual([july.id]);
    expect(first.preserved.some((row) => row.id === may.id)).toBe(true);
    expect(first.blocked.some((row) => row.id === june.id)).toBe(true);

    const applied = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${employee.id}/attendance-rate-correction`)
          .set(authHeader(adminToken))
          .send({ from: "2026-04-01", to: "2026-07-31", hourly_rate: 25, note, preview_token: first.preview_token })
      ).body
    );
    expect(applied.applied_count).toBe(1);
    expect(Number((await ctx.db.get("SELECT hourly_rate_snapshot AS rate FROM attendance_interpreted_punches WHERE id = ?", [july.id])).rate)).toBe(25);
    expect(Number((await ctx.db.get("SELECT hourly_rate_snapshot AS rate FROM attendance_interpreted_punches WHERE id = ?", [may.id])).rate)).toBe(20);
    expect((await ctx.db.get("SELECT hourly_rate_snapshot AS rate FROM attendance_interpreted_punches WHERE id = ?", [june.id])).rate).toBeNull();

    const audits = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ATTENDANCE_RATE_CORRECTION' AND entity_id = ?",
      [String(employee.id)]
    );
    const again = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${employee.id}/attendance-rate-correction/preview`)
          .set(authHeader(adminToken))
          .send({ from: "2026-04-01", to: "2026-07-31", hourly_rate: 25, note })
      ).body
    );
    const repeat = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${employee.id}/attendance-rate-correction`)
          .set(authHeader(adminToken))
          .send({ from: "2026-04-01", to: "2026-07-31", hourly_rate: 25, note, preview_token: again.preview_token })
      ).body
    );
    expect(repeat.applied_count).toBe(0);
    expect(
      (await ctx.db.get(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ATTENDANCE_RATE_CORRECTION' AND entity_id = ?",
        [String(employee.id)]
      )).n
    ).toBe(audits.n);

    const staleEmployee = await createEmployee("معاينة قديمة");
    await mapAndImport(staleEmployee.id, "stale1", [
      tap("stale1", "2026-07-09", 8, 0),
      tap("stale1", "2026-07-09", 16, 0),
      tap("stale1", "2026-07-10", 8, 0),
      tap("stale1", "2026-07-10", 16, 0),
    ]);
    const staleNote = "تصحيح ثم تغيّر";
    const stalePreview = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${staleEmployee.id}/attendance-rate-correction/preview`)
          .set(authHeader(adminToken))
          .send({ from: "2026-07-01", to: "2026-07-31", hourly_rate: 30, note: staleNote })
      ).body
    );
    const one = stalePreview.eligible[0];
    await ctx.db.run("UPDATE attendance_interpreted_punches SET hourly_rate_snapshot = 5 WHERE id = ?", [one.id]);
    const stale = await request(ctx.app)
      .post(`/api/v1/employees/${staleEmployee.id}/attendance-rate-correction`)
      .set(authHeader(adminToken))
      .send({
        from: "2026-07-01",
        to: "2026-07-31",
        hourly_rate: 30,
        note: staleNote,
        preview_token: stalePreview.preview_token,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE_PREVIEW");
    const snapshots = await ctx.db.all(
      "SELECT hourly_rate_snapshot AS rate FROM attendance_interpreted_punches WHERE employee_id = ? AND punch_type = 'in' ORDER BY id",
      [staleEmployee.id]
    );
    expect(snapshots.map((row) => (row.rate == null ? null : Number(row.rate)))).toEqual(
      expect.arrayContaining([5, null])
    );
    expect(snapshots.some((row) => Number(row.rate) === 30)).toBe(false);
  });

  test("remapping the device keeps interpreted punches on the original employee", async () => {
    const first = await createEmployee("صاحب البصمة");
    const second = await createEmployee("ربط لاحق");
    await setHourly(first.id, 15);
    await mapAndImport(first.id, "remap1", [tap("remap1", "2026-06-11", 8, 0), tap("remap1", "2026-06-11", 16, 0)]);
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "remap1", employeeId: second.id });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [{ deviceUserId: "remap1", name: "device" }], records: [tap("remap1", "2026-06-11", 8, 0), tap("remap1", "2026-06-11", 16, 0)] },
      { deviceKey: DEVICE }
    );
    const original = await ctx.db.get("SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ?", [first.id]);
    const moved = await ctx.db.get("SELECT COUNT(*) AS n FROM attendance_interpreted_punches WHERE employee_id = ?", [second.id]);
    expect(original.n).toBe(2);
    expect(moved.n).toBe(0);
    const active = await ctx.db.get(
      "SELECT employee_id FROM employee_device_mappings WHERE device_key = ? AND device_user_id = ? AND active = 1",
      [DEVICE, "remap1"]
    );
    expect(active.employee_id).toBe(second.id);
  });

  test("daily wage stays daily and does not pay fingerprint hours", async () => {
    const employee = await createEmployee("أجر يومي");
    await setHourly(employee.id, 20);
    const daily = await request(ctx.app)
      .post(`/api/v1/employees/${employee.id}/wage-basis`)
      .set(authHeader(adminToken))
      .send({ wage_basis: "daily", daily_rate: 90 });
    expect(daily.status).toBe(200);
    const stored = await ctx.db.get("SELECT wage_basis, hourly_rate, daily_rate FROM employees WHERE id = ?", [employee.id]);
    expect(stored.wage_basis).toBe("daily");
    expect(Number(stored.hourly_rate)).toBe(20);
    expect(Number(stored.daily_rate)).toBe(90);

    await mapAndImport(employee.id, "daily1", [tap("daily1", "2026-06-12", 8, 0), tap("daily1", "2026-06-12", 16, 0)]);
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const payroll = await preview(employee.id, "2026-06-01", "2026-06-30");
    expect(payroll.hours.wage_basis).toBe("daily");
    expect(payroll.hours.recorded_hours).toBe(8);
    expect(payroll.hours.posted_pay).toBe(0);
    expect(payroll.summary.gross_known).toBe(false);
    expect(payroll.summary.basis).toBe("daily");

    const source = await createStaff("bakery_employee");
    const note = "نقل حساب إلى موظف بأجر يومي";
    const relinkPreview = unwrap(
      (
        await request(ctx.app)
          .post(`/api/v1/employees/${employee.id}/account-relink/preview`)
          .set(authHeader(adminToken))
          .send({ source_employee_id: source.employee_id, note })
      ).body
    );
    expect(relinkPreview.blocked).toBe(false);
    const applied = await request(ctx.app)
      .post(`/api/v1/employees/${employee.id}/account-relink`)
      .set(authHeader(adminToken))
      .send({ source_employee_id: source.employee_id, note, preview_token: relinkPreview.preview_token });
    expect(applied.status).toBe(200);
    const after = await ctx.db.get("SELECT user_id, hourly_rate, wage_basis FROM employees WHERE id = ?", [employee.id]);
    expect(after.user_id).toBe(source.id);
    expect(after.wage_basis).toBe("daily");
    expect(Number(after.hourly_rate)).toBe(20);
    expect((await ctx.db.get("SELECT hourly_rate FROM users WHERE id = ?", [source.id])).hourly_rate).toBeNull();
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [source.employee_id])).user_id).toBeNull();
  });

  test("cashier payroll follows cutover when wage basis is unset", async () => {
    const account = await createStaff("cashier", { hourly_rate: 20 });
    const employee = await ctx.db.get("SELECT id, wage_basis, hourly_rate FROM employees WHERE user_id = ?", [account.id]);
    expect(employee.wage_basis).toBeNull();
    expect(Number(employee.hourly_rate)).toBe(20);
    await insertShift(account.id, "2026-06-01", 8, 12, 20);
    await insertShift(account.id, "2026-06-03", 8, 12, 20);
    await mapAndImport(employee.id, "cash1", [tap("cash1", "2026-06-03", 8, 0), tap("cash1", "2026-06-03", 16, 0)]);

    await setPayrollAttendanceCutover(ctx.db, "2026-07-01");
    const before = await preview(employee.id, "2026-06-01", "2026-06-03");
    expect(before.hours.attendance_authoritative).toBeUndefined();
    expect(before.hours.posted_pay).toBe(160);
    expect(before.hours.posted_hours).toBe(8);

    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    const after = await preview(employee.id, "2026-06-01", "2026-06-03");
    expect(after.hours.pos_affects_pay).toBe(false);
    expect(after.hours.posted_pay).toBe(160);
    expect(after.hours.pos_hours).toBe(8);
    expect(after.hours.payroll_source).toBe("attendance");

    await setPayrollAttendanceCutover(ctx.db, "2026-06-02");
    const crossing = await preview(employee.id, "2026-06-01", "2026-06-03");
    expect(crossing.hours.payroll_source).toBe("split");
    expect(crossing.hours.posted_pay).toBe(240);
    expect(crossing.hours.pos_affects_pay).toBe(false);
    expect(crossing.summary.gross_salary).toBe(240);
  });

  test("a cashier token cannot change links, wage settings, or historical snapshots", async () => {
    const employee = await createEmployee("حماية الكاشير");
    const wage = await request(ctx.app)
      .post(`/api/v1/employees/${employee.id}/wage-basis`)
      .set(authHeader(cashierToken))
      .send({ wage_basis: "hourly", hourly_rate: 10 });
    expect(wage.status).toBe(403);
    const correction = await request(ctx.app)
      .post(`/api/v1/employees/${employee.id}/attendance-rate-correction/preview`)
      .set(authHeader(cashierToken))
      .send({ from: "2026-06-01", to: "2026-06-30", hourly_rate: 10, note: "ممنوع" });
    expect(correction.status).toBe(403);
    const relink = await request(ctx.app)
      .post(`/api/v1/employees/${employee.id}/account-relink/preview`)
      .set(authHeader(cashierToken))
      .send({ source_employee_id: employee.id, note: "ممنوع" });
    expect(relink.status).toBe(403);
    const reconcile = await request(ctx.app)
      .post("/api/v1/admin/users/reconcile-employees")
      .set(authHeader(cashierToken))
      .send({ actions: [{ user_id: 1, mode: "create" }] });
    expect(reconcile.status).toBe(403);
  });

  test("backfill copies only an empty hourly employee rate and does not overwrite later edits", async () => {
    const hash = await bcrypt.hash("backfill1", 4);
    const linked = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, 'cashier', 0, 15)",
      [`backfill-${Date.now()}`, hash]
    );
    const editedUser = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, 'cashier', 0, 15)",
      [`edited-${Date.now()}`, hash]
    );
    const dailyUser = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, 'bakery_employee', 0, 15)",
      [`daily-${Date.now()}`, hash]
    );
    const linkedEmployee = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis) VALUES ('منسوخ', 1, ?, NULL)",
      [linked.lastID]
    );
    const editedEmployee = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis, hourly_rate) VALUES ('معدّل', 1, ?, 'hourly', 9)",
      [editedUser.lastID]
    );
    const dailyEmployee = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis, daily_rate) VALUES ('يومي سابق', 1, ?, 'daily', 80)",
      [dailyUser.lastID]
    );
    const alone = await ctx.db.run("INSERT INTO employees (name, active) VALUES ('بلا حساب', 1)");
    await ctx.db.run(
      `INSERT INTO attendance_interpreted_punches
         (employee_id, punched_at, punch_type, source, status, hourly_rate_snapshot)
       VALUES (?, ?, 'in', 'device', 'active', 11)`,
      [linkedEmployee.lastID, localSql("2026-06-01", 8)]
    );
    const salaryBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n;
    const advanceBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM advance_requests")).n;
    const ledgerBefore = (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n;

    await ctx.db.run("DELETE FROM app_settings WHERE key = ?", [EMPLOYEE_HOURLY_RATE_BACKFILL_KEY]);
    const first = await migrateEmployeeHourlyRateData(ctx.db);
    expect(first.copied).toBe(true);
    expect(Number((await ctx.db.get("SELECT hourly_rate FROM employees WHERE id = ?", [linkedEmployee.lastID])).hourly_rate)).toBe(15);
    expect(Number((await ctx.db.get("SELECT hourly_rate FROM employees WHERE id = ?", [editedEmployee.lastID])).hourly_rate)).toBe(9);
    expect((await ctx.db.get("SELECT hourly_rate, wage_basis FROM employees WHERE id = ?", [dailyEmployee.lastID])).hourly_rate).toBeNull();
    expect((await ctx.db.get("SELECT hourly_rate FROM employees WHERE id = ?", [alone.lastID])).hourly_rate).toBeNull();
    expect(Number((await ctx.db.get("SELECT hourly_rate_snapshot AS rate FROM attendance_interpreted_punches WHERE employee_id = ?", [linkedEmployee.lastID])).rate)).toBe(11);

    await ctx.db.run("UPDATE employees SET hourly_rate = 7 WHERE id = ?", [linkedEmployee.lastID]);
    const second = await migrateEmployeeHourlyRateData(ctx.db);
    expect(second.copied).toBe(false);
    expect(Number((await ctx.db.get("SELECT hourly_rate FROM employees WHERE id = ?", [linkedEmployee.lastID])).hourly_rate)).toBe(7);

    await ctx.db.run("DELETE FROM app_settings WHERE key = ?", [EMPLOYEE_HOURLY_RATE_BACKFILL_KEY]);
    await migrateEmployeeHourlyRateData(ctx.db);
    expect(Number((await ctx.db.get("SELECT hourly_rate FROM employees WHERE id = ?", [linkedEmployee.lastID])).hourly_rate)).toBe(7);
    expect((await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [linkedEmployee.lastID])).user_id).toBe(linked.lastID);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_salary_periods")).n).toBe(salaryBefore);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM advance_requests")).n).toBe(advanceBefore);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(ledgerBefore);
  });

  test("opening a shift snapshots the employee rate and does not fall back when that rate is zero", async () => {
    const account = await createStaff("cashier", { hourly_rate: 10 });
    await ctx.db.run("UPDATE employees SET hourly_rate = 25 WHERE user_id = ?", [account.id]);
    const loginRes = await login(ctx.app, account.username, "staffpass1", "pos");
    expect(loginRes.status).toBe(200);
    const opened = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(loginRes.body.token)).send({});
    expect(opened.status).toBe(201);
    const shift = await ctx.db.get(
      "SELECT hourly_rate_snapshot FROM cashier_shifts WHERE cashier_id = ? ORDER BY id DESC LIMIT 1",
      [account.id]
    );
    expect(Number(shift.hourly_rate_snapshot)).toBe(25);

    const zeroAccount = await createStaff("cashier", { hourly_rate: 10 });
    await ctx.db.run("UPDATE employees SET hourly_rate = 0 WHERE user_id = ?", [zeroAccount.id]);
    const zeroLogin = await login(ctx.app, zeroAccount.username, "staffpass1", "pos");
    const zeroOpen = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(zeroLogin.body.token)).send({});
    expect(zeroOpen.status).toBe(201);
    const zeroShift = await ctx.db.get(
      "SELECT hourly_rate_snapshot FROM cashier_shifts WHERE cashier_id = ? ORDER BY id DESC LIMIT 1",
      [zeroAccount.id]
    );
    expect(Number(zeroShift.hourly_rate_snapshot)).toBe(0);
  });

  test("fingerprint readiness is separate from device mapping", async () => {
    const employee = await createEmployee("جاهزية");
    await saveDeviceMapping(ctx.db, {
      deviceKey: zktecoConfig().deviceKey,
      deviceUserId: "ready1",
      employeeId: employee.id,
    });
    const status = unwrap(
      (await request(ctx.app).get("/api/v1/attendance/device/status").set(authHeader(adminToken))).body
    );
    const person = status.trackable_employees.find((row) => row.employee_id === employee.id);
    expect(person.payroll_readiness_label).toBe("لا يوجد أجر ساعة");
    const directory = status.users.find((row) => String(row.device_user_id) === "ready1");
    expect(directory.mapped).toBe(true);
    expect(directory.payroll_readiness_label).toBe("لا يوجد أجر ساعة");
  });
});
