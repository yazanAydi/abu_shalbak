import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createTestEmployee,
} from "./helpers.js";
import { buildFinanceOverview } from "../utils/financeOverview.js";
import {
  buildCashierHoursPreviewFromRows,
  firstYmdOfCalendarMonth,
  isCompleteCalendarMonth,
  lastYmdOfCalendarMonth,
  rangesOverlap,
  shiftAssignmentDate,
} from "../services/employeeEntitlementService.js";
import { shopYmdFromTimestamp } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("employee statement and entitlements", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierId = cashier.id;
    await ctx.db.run("UPDATE users SET hourly_rate = 99 WHERE id = ?", [cashierId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createRegular(name = "موظف راتب") {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, start_on: "2026-01-01" });
    expect(res.status).toBe(201);
    return unwrap(res.body);
  }

  async function createLinkedCashier(name = "كاشير كشف") {
    const existing = await ctx.db.get("SELECT id FROM employees WHERE user_id = ?", [cashierId]);
    if (existing) {
      await ctx.db.run("UPDATE employees SET user_id = NULL WHERE id = ?", [existing.id]);
    }
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, user_id: cashierId, start_on: "2026-01-01" });
    expect(res.status).toBe(201);
    const body = unwrap(res.body);
    expect(body.kind).toBe("cashier");
    return body;
  }

  async function addMonthlyRate(employeeId, amount, from = "2026-01-01") {
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${employeeId}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: from, compensation_type: "monthly", amount });
    expect(res.status).toBe(201);
  }

  async function insertShift({ startIso, endIso, status = "closed", snapshot = 20 }) {
    const res = await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, ?, ?, 100, ?, ?)`,
      [cashierId, startIso, endIso, status, snapshot]
    );
    return res.lastID;
  }

  test("calendar month helpers and overlap", () => {
    expect(firstYmdOfCalendarMonth("2026-08-19")).toBe("2026-08-01");
    expect(lastYmdOfCalendarMonth("2026-08-01")).toBe("2026-08-31");
    expect(lastYmdOfCalendarMonth("2026-02-01")).toBe("2026-02-28");
    expect(isCompleteCalendarMonth("2026-08-01", "2026-08-31")).toBe(true);
    expect(isCompleteCalendarMonth("2026-08-01", "2026-08-15")).toBe(false);
    expect(rangesOverlap("2026-08-01", "2026-08-31", "2026-08-15", "2026-09-15")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-14", "2026-08-15", "2026-08-31")).toBe(false);
  });

  test("shift assignment uses shop-local start date and does not split overnight shifts", () => {
    const overnightStart = "2026-08-31T19:00:00.000Z";
    const overnightEnd = "2026-09-01T03:00:00.000Z";
    expect(shopYmdFromTimestamp(overnightStart)).toBe("2026-08-31");
    expect(shopYmdFromTimestamp(overnightEnd)).toBe("2026-09-01");
    expect(shiftAssignmentDate(overnightStart)).toBe("2026-08-31");
    expect(shiftAssignmentDate("2026-08-31T21:30:00.000Z")).toBe("2026-09-01");
  });

  test("regular 3000 − 2000 − 500 = 500 owed; GET does not post entitlement", async () => {
    const emp = await createRegular("راتب كامل");
    await addMonthlyRate(emp.id, 3000);

    const before = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM employee_salary_entitlements WHERE employee_id = ?",
      [emp.id]
    );
    const peek = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/statement`)
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .set(authHeader(adminToken));
    expect(peek.status).toBe(200);
    expect(unwrap(peek.body).period_entitled).toBe(0);
    expect(
      (await ctx.db.get(
        "SELECT COUNT(*) AS n FROM employee_salary_entitlements WHERE employee_id = ?",
        [emp.id]
      )).n
    ).toBe(before.n);

    const opexBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const post = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(post.status).toBe(201);
    expect(unwrap(post.body).amount).toBe(3000);
    expect(unwrap(post.body).source).toBe("configured");
    expect(unwrap(post.body).event_date).toBe("2026-08-31");
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n
    ).toBe(opexBefore.n);

    const pay = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_payment",
        amount: 2000,
        occurred_on: "2026-08-20",
        payment_method: "transfer",
        reference_note: "دفعة آب",
      });
    expect(pay.status).toBe(201);

    const adv = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_advance",
        amount: 500,
        occurred_on: "2026-08-10",
        payment_method: "cash",
      });
    expect(adv.status).toBe(201);

    const stmt = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/statement`)
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .set(authHeader(adminToken));
    const body = unwrap(stmt.body);
    expect(body.opening_balance).toBe(0);
    expect(body.period_entitled).toBe(3000);
    expect(body.period_salary_payments).toBe(2000);
    expect(body.period_advances).toBe(500);
    expect(body.closing_balance).toBe(500);
    expect(body.amount_owed).toBe(500);
    expect(body.excess_prepaid).toBe(0);

    const opex = await ctx.db.all(
      `SELECT o.amount, o.paid_on FROM operating_expenses o
       JOIN employee_ledger_entries e ON e.operating_expense_id = o.id
       WHERE e.employee_id = ?`,
      [emp.id]
    );
    expect(opex).toHaveLength(2);
    expect(opex.reduce((s, r) => s + Number(r.amount), 0)).toBe(2500);
    const finance = await buildFinanceOverview(ctx.db, "2026-08-01", "2026-08-31");
    expect(Number(finance.operating_expense_count)).toBeGreaterThanOrEqual(2);
  });

  test("partial period and mid-period rate change require confirmed amount + reason", async () => {
    const emp = await createRegular("فترة جزئية");
    await addMonthlyRate(emp.id, 3000, "2026-08-01");

    const partial = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-15" });
    expect(partial.status).toBe(400);
    expect(partial.body.code).toBe("MANUAL_AMOUNT_REQUIRED");

    const confirmed = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-01",
        period_to: "2026-08-15",
        amount: 1500,
        confirm_manual: true,
        reason: "نصف آب باتفاق",
      });
    expect(confirmed.status).toBe(201);
    expect(unwrap(confirmed.body).source).toBe("manual");

    const emp2 = await createRegular("تغير سعر");
    await addMonthlyRate(emp2.id, 3000, "2026-08-01");
    await addMonthlyRate(emp2.id, 3200, "2026-08-20");
    const changed = await request(ctx.app)
      .post(`/api/v1/employees/${emp2.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(changed.status).toBe(400);
    expect(changed.body.code).toBe("MANUAL_AMOUNT_REQUIRED");
  });

  test("overlapping active entitlements are rejected; identical period is rejected", async () => {
    const emp = await createRegular("تداخل فترات");
    await addMonthlyRate(emp.id, 3000);
    const first = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(first.status).toBe(201);

    const same = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("PERIOD_OVERLAP");

    const overlap = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-08-15",
        period_to: "2026-09-15",
        amount: 1000,
        confirm_manual: true,
        reason: "تداخل يجب أن يُرفض",
      });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("PERIOD_OVERLAP");
  });

  test("openings appear once: before from in opening balance, inside period as a row", async () => {
    const emp = await createRegular("أرصدة كشف");
    await addMonthlyRate(emp.id, 3000);
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "unpaid_salary",
        amount: 100,
        as_of: "2026-07-31",
        reason: "باقي تموز",
      });
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/opening-balances`)
      .set(authHeader(adminToken))
      .send({
        kind: "prepaid_salary",
        amount: 40,
        as_of: "2026-08-05",
        reason: "سلفة مسجّلة كرصيد",
      });
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });

    const stmt = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/statement`)
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .set(authHeader(adminToken));
    const body = unwrap(stmt.body);
    expect(body.opening_balance).toBe(100);
    const unpaidRows = body.movements.filter((m) => m.kind === "unpaid_salary");
    expect(unpaidRows).toHaveLength(0);
    const prepaidRows = body.movements.filter((m) => m.kind === "prepaid_salary");
    expect(prepaidRows).toHaveLength(1);
    expect(body.closing_balance).toBe(3060);
  });

  test("reverse-and-replace keeps original August row and posts correction on correction date", async () => {
    const emp = await createRegular("تصحيح استحقاق");
    await addMonthlyRate(emp.id, 3000);
    const posted = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    const originalId = unwrap(posted.body).id;

    const replaced = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements/${originalId}/reverse-and-replace`)
      .set(authHeader(adminToken))
      .send({
        amount: 2800,
        confirm_manual: true,
        reason: "تصحيح راتب آب",
        correction_date: "2026-09-05",
      });
    expect(replaced.status).toBe(200);
    expect(unwrap(replaced.body).original.status).toBe("reversed");
    expect(unwrap(replaced.body).reversal.event_date).toBe("2026-09-05");
    expect(unwrap(replaced.body).replacement.event_date).toBe("2026-09-05");
    expect(unwrap(replaced.body).replacement.amount).toBe(2800);
    expect(unwrap(replaced.body).replacement.period_from).toBe("2026-08-01");

    const august = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const augustEarn = august.movements.filter((m) => m.kind === "payroll_earn");
    expect(augustEarn).toHaveLength(1);
    expect(augustEarn[0].debit).toBe(3000);
    expect(august.closing_balance).toBe(3000);

    const september = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-09-01", to: "2026-09-30" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(september.opening_balance).toBe(3000);
    expect(september.movements.some((m) => m.kind === "payroll_earn_reversal" && m.credit === 3000)).toBe(
      true
    );
    expect(september.movements.some((m) => m.kind === "payroll_earn" && m.debit === 2800)).toBe(true);
    expect(september.closing_balance).toBe(2800);

    const again = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(again.status).toBe(409);
  });

  test("cashier 120h × 20 = 2400 − 1500 − 300 = 600; snapshot not live rate; overnight counted once", async () => {
    const emp = await createLinkedCashier("كاشير ساعات");

    for (let day = 1; day <= 14; day += 1) {
      const dd = String(day).padStart(2, "0");
      await insertShift({
        startIso: `2026-08-${dd}T05:00:00.000Z`,
        endIso: `2026-08-${dd}T13:00:00.000Z`,
        snapshot: 20,
      });
    }
    const overnightId = await insertShift({
      startIso: "2026-08-31T19:00:00.000Z",
      endIso: "2026-09-01T03:00:00.000Z",
      snapshot: 20,
    });
    const openId = await insertShift({
      startIso: "2026-08-20T05:00:00.000Z",
      endIso: null,
      status: "open",
      snapshot: 20,
    });

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/hours-preview`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(preview.is_preview).toBe(true);
    expect(preview.uses_live_hourly_rate).toBe(false);
    expect(preview.posted_hours).toBe(120);
    expect(preview.recorded_hours).toBe(120);
    expect(preview.eligible_hours).toBe(120);
    expect(preview.posted_pay).toBe(2400);
    expect(preview.preview_pay_incomplete).toBe(false);
    expect(preview.incomplete).toBe(true);
    expect(preview.open_shift_count).toBe(1);
    expect(preview.shifts.some((s) => s.shift_id === overnightId && s.shop_start_on === "2026-08-31")).toBe(
      true
    );
    expect(preview.shifts.every((s) => s.hourly_rate === 20 || s.flags.includes("open"))).toBe(true);

    const blocked = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("INCOMPLETE_SHIFTS");

    await ctx.db.run("DELETE FROM cashier_shifts WHERE id = ?", [openId]);

    const preview2 = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/hours-preview`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(preview2.incomplete).toBe(false);
    expect(preview2.posted_pay).toBe(2400);

    const posted = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31" });
    expect(posted.status).toBe(201);
    expect(unwrap(posted.body).amount).toBe(2400);
    expect(unwrap(posted.body).source).toBe("cashier_shifts");
    expect(unwrap(posted.body).hours.frozen).toBe(true);
    expect(unwrap(posted.body).hours.is_preview).toBe(false);

    await ctx.db.run("UPDATE users SET hourly_rate = 50 WHERE id = ?", [cashierId]);
    await insertShift({
      startIso: "2026-08-30T05:00:00.000Z",
      endIso: "2026-08-30T07:00:00.000Z",
      snapshot: 20,
    });

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stmt.period_entitled).toBe(2400);
    expect(stmt.cashier_preview.is_preview).toBe(true);
    expect(stmt.cashier_preview.posted_hours).toBeGreaterThan(120);
    const frozen = stmt.entitlements.find((e) => e.status === "active");
    expect(frozen.hours.posted_hours).toBe(120);
    expect(frozen.amount).toBe(2400);

    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_payment",
        amount: 1500,
        occurred_on: "2026-08-25",
        payment_method: "transfer",
      });
    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_advance",
        amount: 300,
        occurred_on: "2026-08-12",
        payment_method: "cash",
      });

    const afterPay = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-08-01", to: "2026-08-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(afterPay.closing_balance).toBe(600);
    expect(afterPay.amount_owed).toBe(600);

    const sepPreview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/hours-preview`)
          .query({ from: "2026-09-01", to: "2026-09-30" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(sepPreview.shifts.some((s) => s.shift_id === overnightId)).toBe(false);
  });

  test("preview keeps recorded hours when snapshot is missing and does not show that as a complete 0 wage", () => {
    const preview = buildCashierHoursPreviewFromRows(
      [
        {
          shift_id: 1,
          start_time: "2026-07-02T05:00:00.000Z",
          end_time: "2026-07-02T13:00:00.000Z",
          status: "closed",
          hourly_rate_snapshot: null,
        },
        {
          shift_id: 2,
          start_time: "2026-07-03T05:00:00.000Z",
          end_time: "2026-07-03T09:00:00.000Z",
          status: "closed",
          hourly_rate_snapshot: 20,
        },
      ],
      { periodFrom: "2026-07-01", periodTo: "2026-07-31" }
    );
    expect(preview.recorded_hours).toBe(12);
    expect(preview.eligible_hours).toBe(4);
    expect(preview.posted_hours).toBe(4);
    expect(preview.posted_pay).toBe(80);
    expect(preview.preview_pay_incomplete).toBe(true);
    expect(preview.automatic_posting_blocked).toBe(true);
    expect(preview.uses_live_hourly_rate).toBe(false);
    expect(preview.incomplete_reasons).toContain("missing_snapshot");
    expect(preview.incomplete_reason_labels).toContain("أجر الساعة غير محفوظ لهذه الوردية");
    expect(preview.shifts[0].flag_labels).toContain("أجر الساعة غير محفوظ لهذه الوردية");
    expect(preview.shifts[0].eligible_for_automatic).toBe(false);
    expect(preview.shifts[1].eligible_for_automatic).toBe(true);
  });

  test("missing snapshot is not filled from today's rate; excess prepaid is reported", async () => {
    const emp = await createLinkedCashier("بدون لقطة");
    const shiftId = await insertShift({
      startIso: "2026-07-02T05:00:00.000Z",
      endIso: "2026-07-02T13:00:00.000Z",
      snapshot: null,
    });
    await ctx.db.run("UPDATE users SET hourly_rate = 99 WHERE id = ?", [cashierId]);
    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/hours-preview`)
          .query({ from: "2026-07-01", to: "2026-07-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(preview.missing_snapshot_count).toBe(1);
    expect(preview.recorded_hours).toBe(8);
    expect(preview.eligible_hours).toBe(0);
    expect(preview.posted_pay).toBe(0);
    expect(preview.preview_pay_incomplete).toBe(true);
    expect(preview.shifts[0].hourly_rate).toBeNull();
    expect(preview.uses_live_hourly_rate).toBe(false);
    expect(preview.incomplete_reason_labels).toContain("أجر الساعة غير محفوظ لهذه الوردية");

    const blocked = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-07-01", period_to: "2026-07-31" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("INCOMPLETE_SHIFTS");

    const missingAmount = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-07-01",
        period_to: "2026-07-31",
        confirm_incomplete: true,
        confirm_manual: true,
        reason: "بدون مبلغ",
      });
    expect(missingAmount.status).toBe(400);

    const manual = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-07-01",
        period_to: "2026-07-31",
        amount: 100,
        confirm_incomplete: true,
        confirm_manual: true,
        reason: "تقدير يدوي لوردية بلا لقطة",
      });
    expect(manual.status).toBe(201);
    expect(unwrap(manual.body).source).toBe("manual");
    expect(unwrap(manual.body).incomplete).toBe(true);
    expect(unwrap(manual.body).hours.preview_pay_incomplete).toBe(true);
    expect(unwrap(manual.body).hours.recorded_hours).toBe(8);

    const shiftAfter = await ctx.db.get(
      "SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?",
      [shiftId]
    );
    expect(shiftAfter.hourly_rate_snapshot).toBeNull();

    const audit = await ctx.db.get(
      `SELECT new_value FROM audit_logs
       WHERE action = 'EMPLOYEE_ENTITLEMENT_POST' AND entity_id = ?
       ORDER BY id DESC LIMIT 1`,
      [unwrap(manual.body).id]
    );
    const audited = JSON.parse(audit.new_value);
    expect(audited.source).toBe("manual");
    expect(audited.incomplete).toBe(true);
    expect(audited.manual_override).toBe(true);
    expect(audited.reason).toBe("تقدير يدوي لوردية بلا لقطة");
    expect(audited.incomplete_reasons).toContain("missing_snapshot");

    await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payments`)
      .set(authHeader(adminToken))
      .send({
        purpose: "salary_payment",
        amount: 250,
        occurred_on: "2026-07-20",
        payment_method: "cash",
      });
    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/statement`)
          .query({ from: "2026-07-01", to: "2026-07-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stmt.closing_balance).toBe(-150);
    expect(stmt.excess_prepaid).toBe(150);
    expect(stmt.amount_owed).toBe(0);
    expect(stmt.movements.some((m) => String(m.description || "").includes("حساب غير نهائي"))).toBe(true);
    expect(stmt.cashier_preview.preview_pay_incomplete).toBe(true);
    expect(stmt.cashier_preview.recorded_hours).toBe(8);
  });

  test("PATCH cashier hourly rate then opening a shift snapshots that rate; live changes do not rewrite it", async () => {
    const hash = await bcrypt.hash("snap-pass-123", 4);
    const ins = await ctx.db.run(
      `INSERT INTO users (username, password, role, must_change_password, hourly_rate)
       VALUES (?, ?, 'cashier', 0, NULL)`,
      ["snapcashier", hash]
    );
    const userId = ins.lastID;
    const loginRes = await login(ctx.app, "snapcashier", "snap-pass-123", "pos");
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const withoutRate = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(token))
      .send({});
    expect(withoutRate.status).toBe(201);
    const openNoRate = await ctx.db.get(
      "SELECT id, hourly_rate_snapshot FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [userId]
    );
    expect(openNoRate.hourly_rate_snapshot).toBeNull();
    await ctx.db.run(
      "UPDATE cashier_shifts SET status = 'closed', end_time = datetime('now') WHERE id = ?",
      [openNoRate.id]
    );

    const patched = await request(ctx.app)
      .patch(`/api/v1/payroll/cashiers/${userId}`)
      .set(authHeader(adminToken))
      .send({ hourly_rate: 27.5 });
    expect(patched.status).toBe(200);

    const started = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(token))
      .send({});
    expect(started.status).toBe(201);
    const withRate = await ctx.db.get(
      "SELECT id, hourly_rate_snapshot FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [userId]
    );
    expect(Number(withRate.hourly_rate_snapshot)).toBe(27.5);

    await request(ctx.app)
      .patch(`/api/v1/payroll/cashiers/${userId}`)
      .set(authHeader(adminToken))
      .send({ hourly_rate: 40 });
    const still = await ctx.db.get("SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?", [
      withRate.id,
    ]);
    expect(Number(still.hourly_rate_snapshot)).toBe(27.5);
    expect(openNoRate.id).not.toBe(withRate.id);
    const oldRow = await ctx.db.get("SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?", [
      openNoRate.id,
    ]);
    expect(oldRow.hourly_rate_snapshot).toBeNull();
  });

  test("a shift already on an active entitlement cannot be posted again", async () => {
    const emp = await createLinkedCashier("وردية مكررة");
    const shiftId = await insertShift({
      startIso: "2026-06-20T05:00:00.000Z",
      endIso: "2026-06-20T13:00:00.000Z",
      snapshot: 20,
    });
    const early = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-06-01",
        period_to: "2026-06-10",
        amount: 10,
        confirm_manual: true,
        reason: "فترة بلا هذه الوردية",
      });
    expect(early.status).toBe(201);
    await ctx.db.run(
      `INSERT INTO employee_entitlement_shifts
         (entitlement_id, shift_id, shop_start_on, hours, hourly_rate, pay, shift_status, included_in_final)
       VALUES (?, ?, '2026-06-20', 8, 20, 160, 'closed', 1)`,
      [unwrap(early.body).id, shiftId]
    );

    const second = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(adminToken))
      .send({ period_from: "2026-06-11", period_to: "2026-06-30" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("SHIFT_ALREADY_ENTITLED");
  });

  test("POS approved advance appears once on the employee statement", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "سلفة كشف" });
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    );
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 400 WHERE id = ?", [shift.id]);

    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 80 });
    expect(created.status).toBe(201);
    const requestId = unwrap(created.body).request_id;

    const empty = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${emp.id}/statement`).set(authHeader(adminToken)))
        .body
    );
    expect(empty.movements.filter((m) => m.advance_request_id === requestId)).toHaveLength(0);

    const approve = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);

    const stmt = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${emp.id}/statement`).set(authHeader(adminToken)))
        .body
    );
    const adv = stmt.movements.filter((m) => m.kind === "salary_advance" && m.advance_request_id === requestId);
    expect(adv).toHaveLength(1);
    expect(adv[0].credit).toBe(80);
    expect(adv[0].kind_label).toBe("سلفة على الراتب");
  });

  test("cashier cannot post office entitlements or payments", async () => {
    const emp = await createRegular("منع كاشير");
    const res = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/entitlements`)
      .set(authHeader(cashierToken))
      .send({ period_from: "2026-08-01", period_to: "2026-08-31", amount: 1, confirm_manual: true, reason: "x" });
    expect(res.status).toBe(403);
  });
});
