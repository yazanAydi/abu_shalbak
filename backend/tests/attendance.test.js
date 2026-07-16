import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  pairPunchesToSessions,
  recordPunch,
  saveFaceDescriptors,
} from "../services/attendanceService.js";
import { shiftHours } from "../services/cashierPayrollService.js";

process.env.KIOSK_API_KEY = "test-kiosk-key";

function unwrap(body) {
  return body?.data ?? body;
}

describe("attendance", () => {
  let ctx;
  let adminToken;
  let bakeryId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const bakeryHash = await bcrypt.hash("bakerypass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, ?, 0, ?)",
      ["testbakery", bakeryHash, "bakery_employee", 22]
    );
    const bakery = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testbakery"]);
    bakeryId = bakery.id;

    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("pairPunchesToSessions pairs in/out and calculates hours", () => {
    const sessions = pairPunchesToSessions([
      { punch_time: "2026-07-01T08:00:00.000Z", type: "in" },
      { punch_time: "2026-07-01T16:00:00.000Z", type: "out" },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hours).toBe(shiftHours("2026-07-01T08:00:00.000Z", "2026-07-01T16:00:00.000Z"));
    expect(sessions[0].incomplete).toBe(false);
  });

  test("recordPunch toggles in then out", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);
    const desc = Array.from({ length: 128 }, (_, i) => i * 0.01);
    await saveFaceDescriptors(ctx.db, bakeryId, [desc]);

    const first = await recordPunch(ctx.db, bakeryId);
    expect(first.punch.type).toBe("in");
    expect(first.duplicate).toBe(false);

    await ctx.db.run(
      `UPDATE attendance_punches SET punch_time = datetime('now', '-60 seconds') WHERE id = ?`,
      [first.punch.id]
    );

    const second = await recordPunch(ctx.db, bakeryId);
    expect(second.punch.type).toBe("out");
    expect(second.duplicate).toBe(false);
  });

  test("recordPunch rejects rapid double-punch within interval", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);
    const desc = Array.from({ length: 128 }, (_, i) => i * 0.01);
    await saveFaceDescriptors(ctx.db, bakeryId, [desc]);

    const first = await recordPunch(ctx.db, bakeryId);
    expect(first.punch.type).toBe("in");

    const rapid = await recordPunch(ctx.db, bakeryId);
    expect(rapid.duplicate).toBe(true);
    expect(rapid.punch.id).toBe(first.punch.id);
    expect(rapid.punch.type).toBe("in");
    expect(rapid.message).toBe("تم التسجيل مسبقاً");

    const rows = await ctx.db.all(
      "SELECT type FROM attendance_punches WHERE user_id = ? ORDER BY id ASC",
      [bakeryId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("in");
  });

  test("kiosk endpoints reject missing X-Kiosk-Key", async () => {
    const res = await request(ctx.app).get("/api/v1/attendance/kiosk/descriptors");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_KIOSK_KEY");
  });

  test("enrollment saves descriptors via admin API", async () => {
    const desc = Array.from({ length: 128 }, (_, i) => (i + 1) * 0.001);
    const res = await request(ctx.app)
      .post("/api/v1/attendance/enroll")
      .set(authHeader(adminToken))
      .send({ user_id: bakeryId, descriptors: [desc, desc] });
    expect(res.status).toBe(201);
    expect(unwrap(res.body).descriptor_count).toBe(2);

    const rows = await ctx.db.all("SELECT COUNT(*) AS c FROM face_descriptors WHERE user_id = ?", [
      bakeryId,
    ]);
    expect(Number(rows[0].c)).toBe(2);
  });

  test("manual punch endpoints allow admin correction", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);

    const createRes = await request(ctx.app)
      .post("/api/v1/attendance/manual-punch")
      .set(authHeader(adminToken))
      .send({
        user_id: bakeryId,
        punch_time: "2026-07-12 08:00:00",
        type: "in",
      });
    expect(createRes.status).toBe(201);
    const created = unwrap(createRes.body);
    expect(created.punch.type).toBe("in");
    expect(created.punch.source).toBe("manual");

    const patchRes = await request(ctx.app)
      .patch(`/api/v1/attendance/punch/${created.punch.id}`)
      .set(authHeader(adminToken))
      .send({ punch_time: "2026-07-12 08:15:00" });
    expect(patchRes.status).toBe(200);
    expect(unwrap(patchRes.body).punch.punch_time).toContain("08:15");

    const deleteRes = await request(ctx.app)
      .delete(`/api/v1/attendance/punch/${created.punch.id}`)
      .set(authHeader(adminToken));
    expect(deleteRes.status).toBe(200);
    expect(unwrap(deleteRes.body).deleted).toBe(true);
  });

  test("unified report returns punch hours for bakery employee", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);
    await ctx.db.run(
      `INSERT INTO attendance_punches (user_id, punch_time, type, source)
       VALUES (?, '2026-07-10 08:00:00', 'in', 'kiosk'),
              (?, '2026-07-10 12:00:00', 'out', 'kiosk')`,
      [bakeryId, bakeryId]
    );

    const res = await request(ctx.app)
      .get("/api/v1/attendance/report")
      .query({ date_from: "2026-07-10", date_to: "2026-07-10" })
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const report = unwrap(res.body);
    const bakery = report.employees.find((e) => e.user_id === bakeryId);
    expect(bakery).toBeTruthy();
    expect(bakery.hours_source).toBe("punch");
    expect(bakery.total_hours).toBe(4);
    expect(bakery.total_pay).toBe(88);
  });

  test("recordPunch after overnight open in records out not duplicate in", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);
    await ctx.db.run(
      `INSERT INTO attendance_punches (user_id, punch_time, type, source)
       VALUES (?, '2026-07-09 22:00:00', 'in', 'kiosk')`,
      [bakeryId]
    );

    const punch = await recordPunch(ctx.db, bakeryId);
    expect(punch.punch.type).toBe("out");
  });

  test("cross-midnight punch session counts hours on clock-in shop day", async () => {
    await ctx.db.run("DELETE FROM attendance_punches WHERE user_id = ?", [bakeryId]);
    // 22:00 Ramallah = 19:00 UTC on 2026-07-10; out 06:00 Ramallah = 03:00 UTC on 2026-07-11
    await ctx.db.run(
      `INSERT INTO attendance_punches (user_id, punch_time, type, source)
       VALUES (?, '2026-07-10 19:00:00', 'in', 'kiosk'),
              (?, '2026-07-11 03:00:00', 'out', 'kiosk')`,
      [bakeryId, bakeryId]
    );

    const res = await request(ctx.app)
      .get("/api/v1/attendance/report")
      .query({ date_from: "2026-07-10", date_to: "2026-07-10" })
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const report = unwrap(res.body);
    const bakery = report.employees.find((e) => e.user_id === bakeryId);
    expect(bakery?.total_hours).toBe(8);
  });

  test("unified report returns shift hours for cashier", async () => {
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, status)
       VALUES (?, '2026-07-11 09:00:00', '2026-07-11 17:00:00', 100, 'closed')`,
      [cashier.id]
    );
    await ctx.db.run("UPDATE users SET hourly_rate = 30 WHERE id = ?", [cashier.id]);

    const res = await request(ctx.app)
      .get("/api/v1/attendance/report")
      .query({ date_from: "2026-07-11", date_to: "2026-07-11" })
      .set(authHeader(adminToken));

    expect(res.status).toBe(200);
    const report = unwrap(res.body);
    const row = report.employees.find((e) => e.user_id === cashier.id);
    expect(row).toBeTruthy();
    expect(row.hours_source).toBe("shift");
    expect(row.total_hours).toBe(8);
    expect(row.total_pay).toBe(240);
  });

  test("payroll employees endpoint includes bakery role", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/payroll/employees")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const employees = unwrap(res.body);
    const bakery = employees.find((e) => e.username === "testbakery");
    expect(bakery?.role).toBe("bakery_employee");
  });
});
