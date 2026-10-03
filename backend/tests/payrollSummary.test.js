import bcrypt from "bcrypt";
import { createTestContext, destroyTestContext } from "./helpers.js";
import { getPayrollPreview } from "../services/employeePayrollService.js";
import { importAttendanceSnapshot, saveDeviceMapping } from "../services/attendanceDeviceImport.js";
import { setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import { shopLocalParts, shopLocalToUtcMs } from "../utils/shopTime.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";

const DEVICE = "mb160";

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

async function preview(db, employeeId, from, to) {
  return getPayrollPreview(db, employeeId, { period_from: from, period_to: to, as_of: to });
}

describe("payroll period summary", () => {
  let ctx;
  let cashierUserId;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierUserId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeEmployee({ name, role, rate, wageBasis, dailyRate = null }) {
    const hash = await bcrypt.hash("paypass123", 4);
    const username = `pay-${name}`;
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

  async function addAdvance(employeeId, day, amount, seq) {
    await ctx.db.run(
      `INSERT INTO employee_ledger_entries
         (employee_id, entry_type, purpose, occurred_on, amount, event_seq)
       VALUES (?, 'salary_payment', 'salary_advance', ?, ?, ?)`,
      [employeeId, day, amount, seq]
    );
  }

  async function addDebt(employeeId, day, amount, receipt) {
    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES (?, ?, ?, 0, 500)`,
      [`ذمة ${receipt}`, receipt, amount]
    );
    await ctx.db.run("UPDATE employees SET customer_id = ? WHERE id = ?", [customer.lastID, employeeId]);
    const tx = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, employee_id, status, created_at, receipt_number, business_day)
       VALUES (?, '[]', ?, 0, ?, 'on_account', ?, ?, 'completed', ?, ?, ?)`,
      [cashierUserId, amount, amount, customer.lastID, employeeId, `${day} 10:00:00`, receipt, day]
    );
    await ctx.db.run(
      "INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'on_account', ?)",
      [tx.lastID, amount]
    );
  }

  test("hourly gross pay is attendance hours times the rate, then net of period deductions", async () => {
    const emp = await makeEmployee({ name: "hourly", role: "bakery_employee", rate: 20, wageBasis: "hourly" });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "410", employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("410", "2026-06-10", 8, 0), tap("410", "2026-06-10", 16, 0)] },
      { deviceKey: DEVICE }
    );
    await addAdvance(emp.employeeId, "2026-06-05", 30, 1);
    await addAdvance(emp.employeeId, "2026-07-01", 50, 2);
    await addDebt(emp.employeeId, "2026-06-08", 10, "PAY-D-1");
    const june = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(june.summary.payable_hours).toBe(8);
    expect(june.summary.rate).toBe(20);
    expect(june.summary.gross_salary).toBe(160);
    expect(june.summary.advances_total).toBe(30);
    expect(june.summary.debts_total).toBe(10);
    expect(june.summary.net_payable).toBe(120);
    expect(june.summary.lines[0].amount).toBe(160);
    const july = await preview(ctx.db, emp.employeeId, "2026-07-01", "2026-07-31");
    expect(july.summary.gross_salary).toBe(0);
    expect(july.summary.advances_total).toBe(50);
    expect(july.summary.debts_total).toBe(0);
    expect(july.summary.net_payable).toBe(-50);
  });

  test("cashier pay uses MB160 hours after cutover and POS shifts before it", async () => {
    const emp = await makeEmployee({ name: "cashier-cut", role: "cashier", rate: 20, wageBasis: null });
    await setPayrollAttendanceCutover(ctx.db, "2026-10-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "411", employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      {
        users: [],
        records: [
          tap("411", "2026-09-15", 8, 0),
          tap("411", "2026-09-15", 12, 0),
          tap("411", "2026-10-03", 8, 0),
          tap("411", "2026-10-03", 16, 0),
        ],
      },
      { deviceKey: DEVICE }
    );
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 0, 'closed', 10)`,
      [
        emp.userId,
        new Date(shopLocalToUtcMs("2026-09-15", 8, 0, 0)).toISOString(),
        new Date(shopLocalToUtcMs("2026-09-15", 16, 0, 0)).toISOString(),
      ]
    );
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 0, 'closed', 20)`,
      [
        emp.userId,
        new Date(shopLocalToUtcMs("2026-10-03", 8, 17, 0)).toISOString(),
        new Date(shopLocalToUtcMs("2026-10-03", 15, 52, 0)).toISOString(),
      ]
    );
    const before = await preview(ctx.db, emp.employeeId, "2026-09-01", "2026-09-30");
    expect(before.hours.attendance_authoritative).toBeFalsy();
    expect(before.summary.gross_salary).toBe(80);
    expect(before.summary.pay_from_attendance_hours).toBe(false);

    const after = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    expect(after.summary.gross_salary).toBe(160);
    expect(after.summary.payable_hours).toBe(8);
    expect(after.summary.pos_hours).toBeGreaterThan(0);
    expect(after.summary.pos_hours).not.toBe(8);
    expect(after.summary.pos_affects_gross).toBe(false);
    expect(after.summary.lines.reduce((sum, line) => sum + Number(line.amount || 0), 0)).toBe(160);
  });

  test("daily gross pay is not attendance hours times a rate", async () => {
    const emp = await makeEmployee({
      name: "daily",
      role: "accountant",
      rate: 99,
      wageBasis: "daily",
      dailyRate: 100,
    });
    await setPayrollAttendanceCutover(ctx.db, "2026-06-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "412", employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("412", "2026-06-16", 8, 0), tap("412", "2026-06-16", 16, 0)] },
      { deviceKey: DEVICE }
    );
    const row = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(row.summary.basis).toBe("daily");
    expect(row.summary.rate).toBe(100);
    expect(row.summary.rate_unit).toBe("day");
    expect(row.summary.gross_salary).toBeNull();
    expect(row.summary.pay_from_attendance_hours).toBe(false);
    expect(row.summary.payable_days).toBeNull();
    expect(row.summary.lines[0].hours).toBe(8);
    expect(row.summary.lines[0].amount).toBeNull();
    expect(row.summary.lines[0].payable).toBe(false);
  });

  test("open and missing-checkout sessions do not add pay", async () => {
    const emp = await makeEmployee({ name: "gaps", role: "bakery_employee", rate: 10, wageBasis: "hourly" });
    await setPayrollAttendanceCutover(ctx.db, "2026-01-01");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "413", employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("413", "2026-06-02", 8, 0)] },
      { deviceKey: DEVICE }
    );
    const missing = await preview(ctx.db, emp.employeeId, "2026-06-01", "2026-06-30");
    expect(missing.summary.gross_salary).toBe(0);
    expect(missing.summary.lines.every((line) => line.amount === 0)).toBe(true);
    expect(missing.summary.warnings.join(" ")).toMatch(/انصراف/);

    const parts = shopLocalParts(Date.now() - 2 * 60 * 60 * 1000);
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId: "414", employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      { users: [], records: [tap("414", parts.ymd, parts.hour, parts.minute)] },
      { deviceKey: DEVICE }
    );
    const open = await preview(ctx.db, emp.employeeId, parts.ymd, parts.ymd);
    const openLine = open.summary.lines.find((line) => line.date === parts.ymd && line.status === "open");
    expect(openLine.amount).toBe(0);
    expect(open.summary.warnings.join(" ")).toMatch(/مفتوحة/);
  });

  test("period سلف and ذمم reduce only the net of the 16:33–18:02 session", async () => {
    const emp = await makeEmployee({ name: "oct3-net", role: "cashier", rate: 25, wageBasis: null });
    const other = await makeEmployee({ name: "oct3-other", role: "cashier", rate: 25, wageBasis: null });
    const deviceUserId = "415";
    expect(String(emp.employeeId)).not.toBe(deviceUserId);

    await setPayrollAttendanceCutover(ctx.db, "2026-10-03");
    await saveDeviceMapping(ctx.db, { deviceKey: DEVICE, deviceUserId, employeeId: emp.employeeId });
    await importAttendanceSnapshot(
      ctx.db,
      {
        users: [],
        records: [tap(deviceUserId, "2026-10-03", 16, 33), tap(deviceUserId, "2026-10-03", 18, 2)],
      },
      { deviceKey: DEVICE }
    );
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 0, 'closed', 99)`,
      [
        emp.userId,
        new Date(shopLocalToUtcMs("2026-10-03", 8, 0, 0)).toISOString(),
        new Date(shopLocalToUtcMs("2026-10-03", 16, 0, 0)).toISOString(),
      ]
    );

    const start = new Date(shopLocalToUtcMs("2026-10-03", 16, 33, 0)).toISOString();
    const end = new Date(shopLocalToUtcMs("2026-10-03", 18, 2, 0)).toISOString();
    const hours = shiftHours(start, end);
    const gross = shiftPay(25, hours);
    expect(hours).toBeGreaterThan(1.4);
    expect(hours).toBeLessThan(1.5);
    expect(gross).toBe(37);

    await addAdvance(emp.employeeId, "2026-10-03", 10, 901);
    await addAdvance(emp.employeeId, "2026-09-20", 40, 902);
    await addAdvance(other.employeeId, "2026-10-03", 100, 903);

    const customer = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('ذمة oct3-net', 'PAY-D-OCT3', 0, 0, 500)`
    );
    await ctx.db.run("UPDATE employees SET customer_id = ? WHERE id = ?", [customer.lastID, emp.employeeId]);
    async function addSale(employeeId, customerId, day, amount, receipt) {
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
      return tx.lastID;
    }
    const inPeriodDebtId = await addSale(emp.employeeId, customer.lastID, "2026-10-03", 5, "PAY-D-OCT3-IN");
    await addSale(emp.employeeId, customer.lastID, "2026-09-20", 8, "PAY-D-OCT3-OUT");
    await addDebt(other.employeeId, "2026-10-03", 9, "PAY-D-OCT3-OTHER");

    const advanceRow = await ctx.db.get(
      `SELECT employee_id, amount FROM employee_ledger_entries
       WHERE employee_id = ? AND purpose = 'salary_advance' AND amount = 10`,
      [emp.employeeId]
    );
    const debtRow = await ctx.db.get("SELECT employee_id, customer_id, total FROM transactions WHERE id = ?", [
      inPeriodDebtId,
    ]);
    expect(advanceRow.employee_id).toBe(emp.employeeId);
    expect(String(advanceRow.employee_id)).not.toBe(deviceUserId);
    expect(debtRow.employee_id).toBe(emp.employeeId);
    expect(debtRow.customer_id).toBe(customer.lastID);
    expect(Number(debtRow.total)).toBe(5);

    async function snapshot() {
      const ledger = await ctx.db.get(
        "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM employee_ledger_entries WHERE employee_id = ?",
        [emp.employeeId]
      );
      const sales = await ctx.db.get(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM transactions WHERE employee_id = ?",
        [emp.employeeId]
      );
      return { ledgerCount: ledger.n, ledgerTotal: ledger.total, saleCount: sales.n, saleTotal: sales.total };
    }

    const before = await snapshot();
    const first = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    const second = await preview(ctx.db, emp.employeeId, "2026-10-01", "2026-10-31");
    const after = await snapshot();

    expect(first.summary.payable_hours).toBe(hours);
    expect(first.summary.rate).toBe(25);
    expect(first.summary.gross_salary).toBe(37);
    expect(first.summary.advances_total).toBe(10);
    expect(first.summary.debts_total).toBe(5);
    expect(first.summary.net_payable).toBe(22);
    expect(first.summary.pos_affects_gross).toBe(false);
    expect(first.summary.pos_hours).toBeGreaterThan(first.summary.payable_hours);
    expect(first.summary.payable_hours).toBeLessThan(2);

    expect(second.summary).toEqual(first.summary);
    expect(after).toEqual(before);
  });
});
