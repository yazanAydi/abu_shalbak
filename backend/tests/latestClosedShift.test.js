import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";

function bodyOf(res) {
  return res.body.data ?? res.body;
}

async function insertShift(db, cashierId, fields) {
  const ins = await db.run(
    `INSERT INTO cashier_shifts
       (cashier_id, opening_cash, status, start_time, end_time, business_day, variance, store_id)
     VALUES (?, 100, ?, ?, ?, ?, ?, ?)`,
    [
      cashierId,
      fields.status || "closed",
      fields.start,
      fields.end ?? null,
      fields.businessDay ?? null,
      fields.variance === undefined ? 0 : fields.variance,
      fields.storeId || 1,
    ]
  );
  return ins.lastID;
}

describe("latest closed shift summary", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    await ctx.db.run(
      `INSERT INTO stores (id, name, name_ar, branch_code) VALUES (2, 'Other', 'فرع آخر', 'OTHER')`
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function summary(token, query = {}) {
    return request(ctx.app).get("/api/v1/shifts/latest-closed").query(query).set(authHeader(token));
  }

  test("returns no shift when nothing is closed", async () => {
    await insertShift(ctx.db, cashierId, {
      status: "open",
      start: "2026-10-28T06:00:00.000Z",
      end: null,
      businessDay: "2026-10-28",
      variance: null,
    });
    await insertShift(ctx.db, cashierId, {
      status: "pending_count",
      start: "2026-10-27T06:00:00.000Z",
      end: "2026-10-27T18:00:00.000Z",
      businessDay: "2026-10-27",
      variance: 4,
    });
    const res = await summary(adminToken, { date_to: "2026-10-28" });
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({ shift: null });
  });

  test("picks the latest closed shift, breaks timestamp ties by id, and keeps stored variance", async () => {
    const earlier = await insertShift(ctx.db, cashierId, {
      start: "2026-10-20T06:00:00.000Z",
      end: "2026-10-20T18:00:00.000Z",
      businessDay: "2026-10-20",
      variance: 1,
      storeId: 1,
    });
    const laterLowerIdWouldLose = await insertShift(ctx.db, cashierId, {
      start: "2026-10-21T06:00:00.000Z",
      end: "2026-10-22T02:00:00.000Z",
      businessDay: "2026-10-21",
      variance: 12.5,
      storeId: 2,
    });
    const tiedOlder = laterLowerIdWouldLose;
    const tiedNewer = await insertShift(ctx.db, cashierId, {
      start: "2026-10-21T07:00:00.000Z",
      end: "2026-10-22T02:00:00.000Z",
      businessDay: "2026-10-21",
      variance: null,
      storeId: 1,
    });
    expect(tiedNewer).toBeGreaterThan(tiedOlder);
    expect(earlier).toBeLessThan(laterLowerIdWouldLose);

    const res = await summary(adminToken, { date_to: "2026-10-28" });
    expect(res.status).toBe(200);
    const shift = bodyOf(res).shift;
    expect(shift.id).toBe(tiedNewer);
    expect(shift.cashier_name).toBe("testcashier");
    expect(shift.end_time).toBe("2026-10-22T02:00:00.000Z");
    expect(shift.variance).toBeNull();
    expect(shift.visa_sales).toBeUndefined();
    expect(shift.expected_cash).toBeUndefined();
    expect(shift.sale_count).toBeUndefined();

    const list = await request(ctx.app)
      .get("/api/v1/shifts")
      .query({ status: "closed", date_to: "2026-10-28" })
      .set(authHeader(adminToken));
    const rows = bodyOf(list);
    expect(rows[0].id).toBe(shift.id);
    expect(rows[0].variance).toBeNull();
    expect(rows[0].visa_sales).toBeDefined();
    expect(rows[0].sale_count).toBeDefined();
  });

  test("a later end time wins over a higher id, and another store_id is included", async () => {
    const olderHighId = await insertShift(ctx.db, cashierId, {
      start: "2026-10-25T06:00:00.000Z",
      end: "2026-10-25T12:00:00.000Z",
      businessDay: "2026-10-25",
      variance: 2,
      storeId: 1,
    });
    const latestOtherStore = await insertShift(ctx.db, cashierId, {
      start: "2026-10-26T06:00:00.000Z",
      end: "2026-10-26T20:00:00.000Z",
      businessDay: "2026-10-26",
      variance: -3.5,
      storeId: 2,
    });
    expect(latestOtherStore).toBeGreaterThan(olderHighId);
    const future = await insertShift(ctx.db, cashierId, {
      start: "2026-11-02T06:00:00.000Z",
      end: "2026-11-02T20:00:00.000Z",
      businessDay: "2026-11-02",
      variance: 99,
      storeId: 1,
    });

    const res = await summary(adminToken, { date_to: "2026-10-28" });
    const shift = bodyOf(res).shift;
    expect(shift.id).toBe(latestOtherStore);
    expect(shift.variance).toBe(-3.5);
    expect(shift.id).not.toBe(future);

    const list = await request(ctx.app)
      .get("/api/v1/shifts")
      .query({ status: "closed", date_to: "2026-10-28" })
      .set(authHeader(adminToken));
    expect(bodyOf(list)[0].id).toBe(latestOtherStore);
    expect(bodyOf(list).some((row) => row.id === future)).toBe(false);
  });

  test("a legacy shift with no stored business day uses the same start-time fallback", async () => {
    const legacy = await insertShift(ctx.db, cashierId, {
      start: "2026-10-28T08:00:00.000Z",
      end: "2026-10-28T15:00:00.000Z",
      businessDay: null,
      variance: null,
    });
    const res = await summary(adminToken, { date_to: "2026-10-28" });
    expect(bodyOf(res).shift.id).toBe(legacy);
    expect(bodyOf(res).shift.variance).toBeNull();
    const outside = await summary(adminToken, { date_to: "2026-10-01" });
    expect(bodyOf(outside).shift?.id).not.toBe(legacy);
  });

  test("older closed shifts do not add hydration queries or payload", async () => {
    const warm = await summary(adminToken, { date_to: "2026-10-28" });
    const before = await summary(adminToken, { date_to: "2026-10-28" });
    const beforeBytes = Buffer.byteLength(JSON.stringify(before.body));
    const beforeQueries = Number(before.headers["x-query-count"]);

    for (let i = 0; i < 25; i += 1) {
      const shiftId = await insertShift(ctx.db, cashierId, {
        start: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T06:00:00.000Z`,
        end: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T07:00:00.000Z`,
        businessDay: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        variance: i,
        storeId: i % 2 === 0 ? 1 : 2,
      });
      const tx = await ctx.db.run(
        `INSERT INTO transactions
           (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, created_at, business_day, store_id)
         VALUES (?, '[]', 10, 0, 10, 'cash', ?, 'completed', '2026-09-01T10:00:00.000Z', '2026-09-01', 1)`,
        [cashierId, shiftId]
      );
      await ctx.db.run(
        `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
         VALUES (?, 'cash', 10, 10, 1, 10)`,
        [tx.lastID]
      );
    }

    const after = await summary(adminToken, { date_to: "2026-10-28" });
    expect(bodyOf(after)).toEqual(bodyOf(before));
    expect(Buffer.byteLength(JSON.stringify(after.body))).toBe(beforeBytes);
    expect(Number(after.headers["x-query-count"])).toBe(beforeQueries);
    expect(beforeQueries).toBeLessThanOrEqual(6);
    expect(warm.status).toBe(200);

    const list = await request(ctx.app)
      .get("/api/v1/shifts")
      .query({ status: "closed", date_to: "2026-10-28" })
      .set(authHeader(adminToken));
    expect(Number(list.headers["x-query-count"])).toBeGreaterThan(beforeQueries);
    expect(Buffer.byteLength(JSON.stringify(list.body))).toBeGreaterThan(beforeBytes * 2);
  });

  test("a cashier and an accountant without shift audit cannot read the shop-wide summary", async () => {
    const denied = await summary(cashierToken, { date_to: "2026-10-28" });
    expect(denied.status).toBe(403);
    const anon = await request(ctx.app).get("/api/v1/shifts/latest-closed");
    expect(anon.status).toBe(401);

    await createAccountantUser(ctx.db, {
      username: "noshiftaudit",
      permissions: { dashboard: true, sales_reports: true },
    });
    const acct = (await login(ctx.app, "noshiftaudit", "acctpass123", "office")).body.token;
    const acctDenied = await summary(acct, { date_to: "2026-10-28" });
    expect(acctDenied.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "shiftreader",
      permissions: { shift_audit: true },
    });
    const allowed = (await login(ctx.app, "shiftreader", "acctpass123", "office")).body.token;
    const ok = await summary(allowed, { date_to: "2026-10-28" });
    expect(ok.status).toBe(200);
    expect(bodyOf(ok).shift?.cashier_name).toBe("testcashier");
  });
});
