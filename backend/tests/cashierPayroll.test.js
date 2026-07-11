import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { updateAppSettings } from "../utils/settings.js";
import { SETTING_KEYS } from "../utils/settings.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";

describe("cashier payroll", () => {
  let ctx;
  let adminToken;
  let accountantToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const accountantHash = await bcrypt.hash("acctpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
      ["testaccountant", accountantHash, "accountant"]
    );

    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const accountantLogin = await login(ctx.app, "testaccountant", "acctpass123");
    adminToken = adminLogin.body.token;
    accountantToken = accountantLogin.body.token;

    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierId = cashier.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function insertClosedShift(startIso, endIso, status = "closed") {
    const res = await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, status)
       VALUES (?, ?, ?, 100, ?)`,
      [cashierId, startIso, endIso, status]
    );
    return res.lastID;
  }

  test("shiftHours and shiftPay helpers", () => {
    expect(shiftHours("2026-07-01T08:00:00.000Z", "2026-07-01T16:00:00.000Z")).toBe(8);
    expect(shiftPay(25, 8)).toBe(200);
    expect(shiftPay(null, 8)).toBe(0);
    expect(shiftPay(0, 8)).toBe(0);
  });

  test("PATCH hourly rate for cashier", async () => {
    const res = await request(ctx.app)
      .patch(`/api/v1/payroll/cashiers/${cashierId}`)
      .set(authHeader(adminToken))
      .send({ hourly_rate: 30 });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.hourly_rate).toBe(30);
  });

  test("PATCH hourly rate rejects non-cashier", async () => {
    const admin = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const res = await request(ctx.app)
      .patch(`/api/v1/payroll/cashiers/${admin.id}`)
      .set(authHeader(adminToken))
      .send({ hourly_rate: 20 });
    expect(res.status).toBe(400);
  });

  test("GET cashiers lists cashiers with hourly_rate", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/payroll/cashiers")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = res.body.data ?? res.body;
    expect(Array.isArray(rows)).toBe(true);
    const cashier = rows.find((r) => r.id === cashierId);
    expect(cashier).toBeTruthy();
    expect(cashier.hourly_rate).toBe(30);
  });

  test("report sums hours and pay across closed shifts", async () => {
    await ctx.db.run("DELETE FROM cashier_shifts WHERE cashier_id = ?", [cashierId]);
    await insertClosedShift("2026-07-05T08:00:00.000Z", "2026-07-05T12:00:00.000Z");
    await insertClosedShift("2026-07-06T09:00:00.000Z", "2026-07-06T13:00:00.000Z");

    const res = await request(ctx.app)
      .get("/api/v1/payroll/report")
      .query({ date_from: "2026-07-01", date_to: "2026-07-31" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const report = res.body.data ?? res.body;
    expect(report.employees).toHaveLength(1);
    const emp = report.employees[0];
    expect(emp.total_hours).toBe(8);
    expect(emp.total_pay).toBe(240);
    expect(emp.shifts).toHaveLength(2);
    expect(report.grand_total_hours).toBe(8);
    expect(report.grand_total_pay).toBe(240);
  });

  test("open shifts are excluded from report", async () => {
    await ctx.db.run("DELETE FROM cashier_shifts WHERE cashier_id = ?", [cashierId]);
    await ctx.db.run(
      `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, status)
       VALUES (?, '2026-07-10T08:00:00.000Z', NULL, 100, 'open')`,
      [cashierId]
    );
    await insertClosedShift("2026-07-11T08:00:00.000Z", "2026-07-11T10:00:00.000Z");

    const res = await request(ctx.app)
      .get("/api/v1/payroll/report")
      .query({ date_from: "2026-07-01", date_to: "2026-07-31" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const report = res.body.data ?? res.body;
    expect(report.employees[0].shifts).toHaveLength(1);
    expect(report.employees[0].total_hours).toBe(2);
  });

  test("pending_count shifts with end_time are included", async () => {
    await ctx.db.run("DELETE FROM cashier_shifts WHERE cashier_id = ?", [cashierId]);
    await insertClosedShift(
      "2026-07-12T08:00:00.000Z",
      "2026-07-12T12:00:00.000Z",
      "pending_count"
    );

    const res = await request(ctx.app)
      .get("/api/v1/payroll/report")
      .query({ date_from: "2026-07-01", date_to: "2026-07-31" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const report = res.body.data ?? res.body;
    expect(report.employees[0].shifts[0].status).toBe("pending_count");
    expect(report.employees[0].total_hours).toBe(4);
  });

  test("null hourly_rate yields zero pay but counts hours", async () => {
    await ctx.db.run("UPDATE users SET hourly_rate = NULL WHERE id = ?", [cashierId]);
    await ctx.db.run("DELETE FROM cashier_shifts WHERE cashier_id = ?", [cashierId]);
    await insertClosedShift("2026-07-15T08:00:00.000Z", "2026-07-15T10:00:00.000Z");

    const res = await request(ctx.app)
      .get("/api/v1/payroll/report")
      .query({ date_from: "2026-07-01", date_to: "2026-07-31" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const report = res.body.data ?? res.body;
    expect(report.employees[0].total_hours).toBe(2);
    expect(report.employees[0].total_pay).toBe(0);
    expect(report.employees[0].missing_rate).toBe(true);

    await ctx.db.run("UPDATE users SET hourly_rate = 30 WHERE id = ?", [cashierId]);
  });

  test("accountant without employee_payroll permission gets 403", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        employee_payroll: false,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/payroll/cashiers")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(403);
  });

  test("accountant with employee_payroll permission can access payroll", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        employee_payroll: true,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/payroll/cashiers")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(200);
  });
});
