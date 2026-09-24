import request from "supertest";
import {
  authHeader,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
} from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function startShift(app, token, db, opening = 200) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  const shift = await db.get(
    "SELECT * FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
  );
  await db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, shift.id]);
  return { ...shift, opening_cash: opening };
}

describe("operation receipts after posting", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    await ctx.db.run("UPDATE products SET price = 15, cost = 10, cost_known = 1, stock = 20 WHERE id = ?", [
      ctx.productId,
    ]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("shop consumption queues one receipt without line costs, and reprint does not move stock", async () => {
    await startShift(ctx.app, cashierToken, ctx.db, 100);
    const posted = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2 }],
        reason: "تنظيف",
        idempotency_key: "print-shop-use-0001",
      });
    expect(posted.status).toBe(201);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'shop_consumption'")).n).toBe(0);
    const approved = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${unwrap(posted.body).request_id}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    const jobs = await ctx.db.all(
      "SELECT * FROM operation_print_jobs WHERE kind = 'shop_consumption'"
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    expect(Number(jobs[0].cashier_id)).toBe(cashierId);
    expect(jobs[0].snapshot_json).not.toMatch(/unit_cost/);

    const claim = await request(ctx.app)
      .post("/api/v1/pos/print-jobs/claim")
      .set(authHeader(cashierToken))
      .send({});
    expect(claim.status).toBe(200);
    const slip = unwrap(claim.body);
    expect(slip.receipt_html).toContain("استهلاك داخلي — مصاريف محل");
    expect(slip.receipt_html).toContain("لا توجد حركة نقدية");
    expect(slip.receipt_html).toContain("20.00");
    expect(slip.receipt_html).not.toContain("10.00");
    expect(slip.receipt_html).not.toContain("unit_cost");

    const again = await request(ctx.app)
      .post("/api/v1/pos/print-jobs/claim")
      .set(authHeader(cashierToken))
      .send({});
    expect(again.body.data).toBeNull();

    const stock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const reprint = await request(ctx.app)
      .post(`/api/v1/pos/print-jobs/${slip.id}/reprint`)
      .set(authHeader(cashierToken))
      .send({});
    expect(reprint.status).toBe(200);
    expect(unwrap(reprint.body).receipt_html).toContain("نسخة");
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(stock);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n).toBe(0);

    const office = await request(ctx.app)
      .post("/api/v1/pos/print-jobs/claim")
      .set(authHeader(adminToken))
      .send({});
    expect(office.status).toBe(200);
    expect(office.body.data).toBeNull();
  });

  test("pending and rejected requests do not queue a receipt", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "بدون طباعة" });
    const created = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 10, notes: "لا" });
    expect(created.status).toBe(201);
    const requestId = unwrap(created.body).request_id;
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'salary_advance'")).n
    ).toBe(0);
    const rejected = await request(ctx.app)
      .put(`/api/v1/advance-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected", review_notes: "لا" });
    expect(rejected.status).toBe(200);
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'salary_advance'")).n
    ).toBe(0);
  });

  test("approved salary advance and cash debt queue one receipt each on the cashier", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "موظف سلف" });
    const advance = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: emp.id, amount: 15, notes: "سلفة" });
    const advanceId = unwrap(advance.body).request_id;
    const approved = await request(ctx.app)
      .put(`/api/v1/advance-requests/${advanceId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const advanceJob = await ctx.db.get(
      "SELECT * FROM operation_print_jobs WHERE kind = 'salary_advance' AND reference_id = ?",
      [advanceId]
    );
    expect(advanceJob.status).toBe("pending");
    expect(Number(advanceJob.cashier_id)).toBe(cashierId);
    expect(advanceJob.snapshot_json).toContain("سلفة على الراتب");

    const dup = await request(ctx.app)
      .put(`/api/v1/advance-requests/${advanceId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await ctx.db.get(
          "SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'salary_advance' AND reference_id = ?",
          [advanceId]
        )
      ).n
    ).toBe(1);

    const customer = await ctx.db.run(
      "INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('عميل صرف', 'C-PRINT-1', 0, 0)"
    );
    const cash = await request(ctx.app)
      .post("/api/v1/customer-cash-debt-requests")
      .set(authHeader(cashierToken))
      .send({ customer_id: customer.lastID, amount: 12, notes: "صرف", idempotency_key: "print-cash-debt-01" });
    expect(cash.status).toBe(201);
    const cashId = unwrap(cash.body).request_id;
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM operation_print_jobs WHERE kind = 'cash_debt'")).n
    ).toBe(0);
    const ok = await request(ctx.app)
      .put(`/api/v1/customer-cash-debt-requests/${cashId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(ok.status).toBe(200);
    const first = unwrap(
      (await request(ctx.app).post("/api/v1/pos/print-jobs/claim").set(authHeader(cashierToken)).send({})).body
    );
    const second = unwrap(
      (await request(ctx.app).post("/api/v1/pos/print-jobs/claim").set(authHeader(cashierToken)).send({})).body
    );
    const claimed = [first, second].find((job) => String(job?.receipt_html || "").includes("صرف نقدي"));
    expect(claimed).toBeTruthy();
    const html = claimed.receipt_html;
    expect(html).toContain("صرف نقدي على ذمة العميل");
    expect(html).toContain("ليس تحصيلاً ولا سداداً");
    expect(html).not.toContain("سند قبض");
    const expenses = (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n;
    const failed = await request(ctx.app)
      .post(`/api/v1/pos/print-jobs/${claimed.id}/result`)
      .set(authHeader(cashierToken))
      .send({ outcome: "failed" });
    expect(unwrap(failed.body).message).toContain("تم حفظ العملية وتعذرت الطباعة");
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n).toBe(expenses);
    const stuck = await ctx.db.get("SELECT status FROM operation_print_jobs WHERE id = ?", [claimed.id]);
    expect(stuck.status).toBe("failed");
  });
});
