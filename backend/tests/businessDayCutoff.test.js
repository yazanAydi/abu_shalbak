/**
 * Business-day cutoff. New shifts store the day at open. Historical rows with
 * no stored day keep the Asia/Hebron calendar date and ignore the cutoff.
 * Disposable database only.
 */
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import {
  businessDayFromTimestamp,
  fetchTransactionsForShopDate,
  normalizeCutoffHour,
  shopBusinessDayYmd,
} from "../utils/businessDay.js";
import { previousCalendarYmd, shopLocalParts, SHOP_TZ } from "../utils/shopTime.js";
import { updateAppSettings } from "../utils/settings.js";
import { buildPayrollReport } from "../services/cashierPayrollService.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

function instantAt(ymd, hour, minute = 0) {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const end = Date.UTC(y, m - 1, d + 1, 23, 59, 0);
  for (let ms = start; ms <= end; ms += 60_000) {
    const parts = shopLocalParts(ms);
    if (parts && parts.ymd === ymd && parts.hour === hour && parts.minute === minute) {
      return new Date(ms).toISOString();
    }
  }
  throw new Error(`No ${SHOP_TZ} instant for ${ymd} ${hour}:${String(minute).padStart(2, "0")}`);
}

function dayBefore(ymd) {
  return previousCalendarYmd(ymd);
}

describe("business day cutoff", () => {
  test("before, at, and after the cutoff, including cutoff 0 and calendar edges", () => {
    expect(businessDayFromTimestamp(instantAt("2026-09-23", 4), 6)).toBe("2026-09-22");
    expect(businessDayFromTimestamp(instantAt("2026-09-23", 6), 6)).toBe("2026-09-23");
    expect(businessDayFromTimestamp(instantAt("2026-09-23", 6, 1), 6)).toBe("2026-09-23");
    expect(businessDayFromTimestamp(instantAt("2026-09-24", 0), 6)).toBe("2026-09-23");
    expect(businessDayFromTimestamp(instantAt("2026-09-24", 0), 0)).toBe("2026-09-24");
    expect(businessDayFromTimestamp(instantAt("2026-09-23", 4), 0)).toBe("2026-09-23");
    expect(businessDayFromTimestamp(instantAt("2026-10-01", 4), 6)).toBe("2026-09-30");
    expect(businessDayFromTimestamp(instantAt("2026-01-01", 4), 6)).toBe("2025-12-31");
    expect(businessDayFromTimestamp(instantAt("2026-03-01", 4), 6)).toBe("2026-02-28");
    expect(normalizeCutoffHour(24)).toBeNull();
    expect(normalizeCutoffHour(6.5)).toBeNull();
    expect(normalizeCutoffHour(6)).toBe(6);
  });

  test("daylight-saving boundaries use the local calendar, not a fixed offset or 24 hours", () => {
    const winter = offsetOn("2012-01-15");
    const summer = offsetOn("2012-08-15");
    expect(winter).toBe(120);
    expect(summer).toBe(180);

    const atCutoff = instantAt("2012-08-15", 6);
    const parts = shopLocalParts(atCutoff);
    expect(parts.hour).toBe(6);
    expect(businessDayFromTimestamp(atCutoff, 6)).toBe("2012-08-15");
    const utcHour = new Date(atCutoff).getUTCHours();
    const fixedPlusTwoHour = (utcHour + 2) % 24;
    expect(fixedPlusTwoHour).toBeLessThan(6);
    expect(businessDayFromTimestamp(atCutoff, 6)).not.toBe(dayBefore("2012-08-15"));

    const beforeCutoff = instantAt("2012-08-15", 5);
    expect(businessDayFromTimestamp(beforeCutoff, 6)).toBe("2012-08-14");
    const minus24 = shopLocalParts(Date.parse(beforeCutoff) - 24 * 3_600_000);
    expect(minus24.ymd).toBe("2012-08-14");
    expect(businessDayFromTimestamp(beforeCutoff, 6)).toBe(previousCalendarYmd(shopLocalParts(beforeCutoff).ymd));

    const winterMorning = instantAt("2012-01-15", 4);
    expect(offsetOn("2012-01-15")).not.toBe(offsetOn("2012-08-15"));
    expect(businessDayFromTimestamp(winterMorning, 6)).toBe("2012-01-14");
  });

  describe("persisted assignment", () => {
    let ctx;
    let adminToken;
    let cashierToken;
    let cashierId;

    beforeAll(async () => {
      ctx = await createTestContext();
      const admin = await login(ctx.app, "testadmin", "adminpass123", "office");
      const cashier = await login(ctx.app, "testcashier", "cashpass123", "pos");
      adminToken = admin.body.token;
      cashierToken = cashier.body.token;
      cashierId = cashier.body.user.id;
    });

    afterAll(async () => {
      await destroyTestContext(ctx);
    });

    test("a shift keeps the day assigned at open across midnight and the next cutoff", async () => {
      const openAt = instantAt("2026-09-23", 23);
      const closeAt = instantAt("2026-09-24", 7);
      const saleAt = instantAt("2026-09-24", 7);
      const shift = await ctx.db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, opening_cash, status, start_time, end_time, business_day, hourly_rate_snapshot)
         VALUES (?, 0, 'closed', ?, ?, ?, 25)`,
        [cashierId, openAt, closeAt, "2026-09-23"]
      );
      await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
         VALUES (?, '[]', 10, 0, 10, 0, 'cash', ?, 'completed', ?)`,
        [cashierId, shift.lastID, saleAt]
      );

      const onOpenDay = await fetchTransactionsForShopDate(ctx.db, "2026-09-23");
      const onNextDay = await fetchTransactionsForShopDate(ctx.db, "2026-09-24");
      expect(onOpenDay.map((row) => Number(row.total))).toEqual([10]);
      expect(onNextDay).toHaveLength(0);

      const shiftSales = await ctx.db.get(
        "SELECT ROUND(COALESCE(SUM(total), 0), 2) AS s FROM transactions WHERE shift_id = ?",
        [shift.lastID]
      );
      expect(Number(shiftSales.s)).toBe(10);

      const payroll = await buildPayrollReport(ctx.db, {
        dateFrom: "2026-09-23",
        dateTo: "2026-09-23",
        cashierId,
      });
      const nextPayroll = await buildPayrollReport(ctx.db, {
        dateFrom: "2026-09-24",
        dateTo: "2026-09-24",
        cashierId,
      });
      const hours = payroll.employees?.flatMap((row) => row.shifts || []) || [];
      expect(hours.some((row) => Number(row.shift_id) === Number(shift.lastID))).toBe(true);
      const nextHours = nextPayroll.employees?.flatMap((row) => row.shifts || []) || [];
      expect(nextHours.some((row) => Number(row.shift_id) === Number(shift.lastID))).toBe(false);
    });

    test("a shiftless transaction stores the cutoff day, and a historical one does not move", async () => {
      const early = instantAt("2026-09-23", 4);
      const assigned = businessDayFromTimestamp(early, 6);
      expect(assigned).toBe("2026-09-22");
      await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at, business_day)
         VALUES (?, '[]', 4, 0, 4, 0, 'cash', NULL, 'completed', ?, ?)`,
        [cashierId, early, assigned]
      );
      await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status, created_at)
         VALUES (?, '[]', 7, 0, 7, 0, 'cash', NULL, 'completed', ?)`,
        [cashierId, early]
      );

      const previous = await fetchTransactionsForShopDate(ctx.db, "2026-09-22");
      const same = await fetchTransactionsForShopDate(ctx.db, "2026-09-23");
      expect(previous.some((row) => Number(row.total) === 4)).toBe(true);
      expect(previous.some((row) => Number(row.total) === 7)).toBe(false);
      expect(same.some((row) => Number(row.total) === 7)).toBe(true);
      expect(shopBusinessDayYmd({ created_at: early })).toBe("2026-09-23");
    });

    test("changing the cutoff leaves the open shift and moves only the next one", async () => {
      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 0 });
      const first = await request(ctx.app)
        .post("/api/v1/shifts/start")
        .set(authHeader(cashierToken))
        .send({});
      expect(first.status).toBe(201);
      const firstBody = unwrap(first);
      const stored = await ctx.db.get("SELECT * FROM cashier_shifts WHERE id = ?", [firstBody.shift_id]);
      expect(stored.business_day).toBe(businessDayFromTimestamp(stored.start_time, 0));

      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 23 });
      const still = await ctx.db.get(
        "SELECT business_day FROM cashier_shifts WHERE id = ?",
        [firstBody.shift_id]
      );
      expect(still.business_day).toBe(stored.business_day);

      await ctx.db.run(
        "UPDATE cashier_shifts SET status = 'closed', end_time = start_time WHERE id = ?",
        [firstBody.shift_id]
      );
      const second = await request(ctx.app)
        .post("/api/v1/shifts/start")
        .set(authHeader(cashierToken))
        .send({});
      expect(second.status).toBe(201);
      const secondRow = await ctx.db.get(
        "SELECT * FROM cashier_shifts WHERE id = ?",
        [unwrap(second).shift_id]
      );
      expect(secondRow.business_day).toBe(businessDayFromTimestamp(secondRow.start_time, 23));
      await ctx.db.run(
        "UPDATE cashier_shifts SET status = 'closed', end_time = start_time WHERE id = ?",
        [secondRow.id]
      );
    });

    test("migration does not rewrite an already-open shift", async () => {
      const openAt = instantAt("2026-09-23", 4);
      const legacy = await ctx.db.run(
        `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, start_time)
         VALUES (?, 0, 'open', ?)`,
        [cashierId, openAt]
      );
      const migrated = await initDatabase(ctx.dbPath);
      await closeSqliteConnection(migrated);
      const row = await ctx.db.get("SELECT business_day, start_time, status FROM cashier_shifts WHERE id = ?", [
        legacy.lastID,
      ]);
      expect(row.business_day).toBeNull();
      expect(row.status).toBe("open");
      expect(shopBusinessDayYmd({ start_time: row.start_time })).toBe("2026-09-23");
      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6 });
      const again = await ctx.db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [legacy.lastID]);
      expect(again.business_day).toBeNull();
      expect(shopBusinessDayYmd({ start_time: openAt })).toBe("2026-09-23");
      expect(businessDayFromTimestamp(openAt, 6)).toBe("2026-09-22");
      await ctx.db.run("UPDATE cashier_shifts SET status = 'closed', end_time = start_time WHERE id = ?", [
        legacy.lastID,
      ]);
    });

    test("calendar payment and expense dates stay on the entered day", async () => {
      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6 });
      const category = await ctx.db.get(
        `SELECT id FROM expense_categories
          WHERE lower(name) NOT IN ('salaries', 'salary_advance')
          ORDER BY id LIMIT 1`
      );
      const expense = await request(ctx.app)
        .post("/api/v1/expenses")
        .set(authHeader(adminToken))
        .send({
          category_id: category.id,
          amount: 15,
          paid_on: "2026-09-23",
          payment_method: "cash",
        });
      expect(expense.status).toBe(201);
      expect(unwrap(expense).paid_on).toBe("2026-09-23");

      const supplier = await ctx.db.run(
        "INSERT INTO suppliers (name, balance) VALUES ('مورد يوم التقويم', 0)"
      );
      const payment = await request(ctx.app)
        .post("/api/v1/finance/payments")
        .set(authHeader(adminToken))
        .send({
          supplier_id: supplier.lastID,
          amount: 9,
          paid_on: "2026-09-23",
          payment_method: "cash",
        });
      expect(payment.status).toBe(201);
      const voucher = await ctx.db.get(
        "SELECT voucher_date FROM vouchers ORDER BY id DESC LIMIT 1"
      );
      expect(voucher.voucher_date).toBe("2026-09-23");

      const employee = await ctx.db.run(
        "INSERT INTO employees (name, start_on) VALUES ('موظف تاريخ الراتب', '2026-01-01')"
      );
      await ctx.db.run(
        `INSERT INTO employee_ledger_entries
           (employee_id, entry_type, purpose, occurred_on, amount, event_seq)
         VALUES (?, 'salary_payment', 'salary_payment', '2026-09-23', 100, 1)`,
        [employee.lastID]
      );
      const ledger = await ctx.db.get(
        "SELECT occurred_on FROM employee_ledger_entries WHERE employee_id = ?",
        [employee.lastID]
      );
      expect(ledger.occurred_on).toBe("2026-09-23");
      expect(businessDayFromTimestamp("2026-09-23T00:00:00Z", 6)).not.toBe("2026-09-23");
    });

    test("the cutoff setting rejects a non-integer", async () => {
      await expect(updateAppSettings(ctx.db, { business_day_cutoff_hour: 6.5 })).rejects.toThrow(
        /0 إلى 23/
      );
      await expect(updateAppSettings(ctx.db, { business_day_cutoff_hour: 24 })).rejects.toThrow(
        /0 إلى 23/
      );
    });
  });
});

function offsetOn(ymd) {
  return offsetMinutes(Date.parse(instantAt(ymd, 12)));
}

function offsetMinutes(ms) {
  const parts = shopLocalParts(ms);
  const utc = new Date(ms);
  const localAsUtc = Date.UTC(
    Number(parts.ymd.slice(0, 4)),
    Number(parts.ymd.slice(5, 7)) - 1,
    Number(parts.ymd.slice(8, 10)),
    parts.hour,
    parts.minute,
    utc.getUTCSeconds()
  );
  return Math.round((localAsUtc - ms) / 60000);
}
