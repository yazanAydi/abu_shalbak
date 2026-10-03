import bcrypt from "bcrypt";
import { createTestContext, destroyTestContext } from "./helpers.js";
import { getPayrollPreview } from "../services/employeePayrollService.js";
import { buildPayableAttendance } from "../services/payableAttendance.js";
import { importAttendanceSnapshot, saveDeviceMapping } from "../services/attendanceDeviceImport.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { shopLocalToUtcMs } from "../utils/shopTime.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";

const DEVICE = "mb160";

function tap(deviceUserId, ymd, hh, mm, ss = 0) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    deviceUserId: String(deviceUserId),
    wallClock: `${ymd} ${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    rawStatus: 0,
    rawPunch: 0,
    rawRecordId: `${deviceUserId}-${hh}${mm}${ss}`,
  };
}

describe("payroll consumes the same closed attendance session", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeEmployee({ name, role, rate, wageBasis = null }) {
    const hash = await bcrypt.hash("sessionpass1", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password, hourly_rate) VALUES (?, ?, ?, 0, ?)",
      [name, hash, role, rate]
    );
    const user = await ctx.db.get("SELECT id FROM users WHERE username = ?", [name]);
    const emp = await ctx.db.run(
      "INSERT INTO employees (name, active, user_id, wage_basis) VALUES (?, 1, ?, ?)",
      [name, user.id, wageBasis]
    );
    return { userId: user.id, employeeId: emp.lastID };
  }

  async function sessionOn(employeeId, deviceUserId) {
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId, employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      {
        users: [],
        records: [tap(deviceUserId, "2026-10-03", 16, 33), tap(deviceUserId, "2026-10-03", 18, 2)],
      },
      { deviceKey: DEVICE }
    );
  }

  test("16:33–18:02 at ₪25 is payable on the payroll summary after cutover", async () => {
    await setPayrollAttendanceCutover(ctx.db, "2026-10-03");
    const start = new Date(shopLocalToUtcMs("2026-10-03", 16, 33, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-10-03", 18, 2, 0)).toISOString();
    const hours = shiftHours(start, end);
    const gross = shiftPay(25, hours);
    expect(hours).toBeGreaterThan(1.4);
    expect(hours).toBeLessThan(1.5);
    expect(gross).toBe(37);

    const cashier = await makeEmployee({ name: "oct3-cashier", role: "cashier", rate: 25 });
    await sessionOn(cashier.employeeId, "501");
    const attendance = await buildPayableAttendance(ctx.db, cashier.employeeId, {
      from: "2026-10-01",
      to: "2026-10-31",
      nowMs: shopLocalToUtcMs("2026-10-04", 12, 0, 0),
    });
    const payroll = await getPayrollPreview(ctx.db, cashier.employeeId, {
      period_from: "2026-10-01",
      period_to: "2026-10-31",
      as_of: "2026-10-31",
    });
    expect(attendance.posted_hours).toBe(hours);
    expect(attendance.posted_pay).toBe(gross);
    expect(payroll.summary.payable_hours).toBe(attendance.posted_hours);
    expect(payroll.summary.gross_salary).toBe(gross);
    expect(payroll.summary.net_payable).toBe(gross);
    expect(payroll.summary.gross_salary).not.toBe(0);
    expect(payroll.summary.gross_salary).not.toBeNull();

    const admin = await makeEmployee({ name: "oct3-admin", role: "admin", rate: 25, wageBasis: null });
    await sessionOn(admin.employeeId, "502");
    const adminPay = await getPayrollPreview(ctx.db, admin.employeeId, {
      period_from: "2026-10-01",
      period_to: "2026-10-31",
      as_of: "2026-10-31",
    });
    expect(adminPay.kind).toBe("regular");
    expect(adminPay.summary.payable_hours).toBe(hours);
    expect(adminPay.summary.rate).toBe(25);
    expect(adminPay.summary.gross_salary).toBe(gross);
    expect(adminPay.summary.net_payable).toBe(gross);
  });
});
