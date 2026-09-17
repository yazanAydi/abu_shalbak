import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createTestEmployee,
} from "./helpers.js";
import { fingerprintCheckoutPayload } from "../utils/checkoutIdempotency.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("on-account checkout notes", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let customerId;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    const shift = await ctx.db.get(
      "SELECT id FROM cashier_shifts WHERE cashier_id = (SELECT id FROM users WHERE username = ?) AND status = 'open'",
      ["testcashier"]
    );
    shiftId = shift.id;
    await ctx.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [ctx.productId]);
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('__notes_cust__', 'NT-OA', 0, 0, 100000)`
    );
    customerId = cust.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function checkoutOnAccount(extra, key) {
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey(
          {
            items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
            payment_method: "on_account",
            ...extra,
          },
          key
        )
      );
  }

  async function approve(requestId, reviewNotes = null) {
    const res = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved", review_notes: reviewNotes });
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("schema has a cashier notes column separate from review_notes", async () => {
    const oaCols = await ctx.db.all("PRAGMA table_info(on_account_requests)");
    const txCols = await ctx.db.all("PRAGMA table_info(transactions)");
    expect(oaCols.some((c) => c.name === "notes")).toBe(true);
    expect(oaCols.some((c) => c.name === "review_notes")).toBe(true);
    expect(txCols.some((c) => c.name === "notes")).toBe(true);
  });

  test("fingerprint treats empty notes like omitted notes and includes non-empty notes", () => {
    const base = {
      items: [{ product_id: 1, quantity: 1, price: 10 }],
      payment_method: "on_account",
      customer_id: 9,
    };
    expect(fingerprintCheckoutPayload(base)).toBe(
      fingerprintCheckoutPayload({ ...base, notes: "" })
    );
    expect(fingerprintCheckoutPayload(base)).toBe(
      fingerprintCheckoutPayload({ ...base, notes: "   " })
    );
    expect(fingerprintCheckoutPayload({ ...base, notes: "مرحبا" })).not.toBe(
      fingerprintCheckoutPayload(base)
    );
    expect(fingerprintCheckoutPayload({ ...base, notes: "مرحبا" })).toBe(
      fingerprintCheckoutPayload({ ...base, notes: "  مرحبا  " })
    );
    expect(
      fingerprintCheckoutPayload({
        ...base,
        payment_method: "cash",
        notes: "تجاهل",
      })
    ).toBe(fingerprintCheckoutPayload({ ...base, payment_method: "cash" }));
  });

  test("Arabic notes survive employee request → approval → invoice → statements", async () => {
    const note = "ملاحظة ذمة للموظف\nسطر ثاني — <تجربة>";
    const emp = await createTestEmployee(ctx.db, { name: "__notes_emp__" });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = Number(product.stock);

    const pending = await checkoutOnAccount(
      { employee_id: emp.id, notes: `  ${note}  ` },
      `oa-notes-emp-${emp.id}`
    );
    expect(pending.status).toBe(202);
    const requestId = unwrap(pending.body).request_id;
    const oa = await ctx.db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oa.notes).toBe(note);
    expect(oa.review_notes).toBeNull();
    expect(oa.status).toBe("pending");
    expect(oa.transaction_id).toBeNull();
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );

    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/on-account-requests/pending").set(authHeader(adminToken))).body
    );
    const row = listed.find((r) => Number(r.id) === Number(requestId));
    expect(row).toBeTruthy();
    expect(row.notes).toBe(note);
    expect(row.review_notes == null || row.review_notes === "").toBe(true);

    const status = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/on-account-requests/${requestId}`)
          .set(authHeader(cashierToken))
      ).body
    );
    expect(status.notes).toBe(note);
    expect(status.review_notes == null || status.review_notes === "").toBe(true);

    const approved = await approve(requestId, "سبب موافقة المدير");
    const oaAfter = await ctx.db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oaAfter.notes).toBe(note);
    expect(oaAfter.review_notes).toBe("سبب موافقة المدير");
    const txId = oaAfter.transaction_id;
    expect(txId).toBeTruthy();
    const tx = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    expect(tx.notes).toBe(note);
    expect(Number(tx.total)).toBe(Number(product.price));
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore - 1
    );

    const empRow = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id]);
    expect(empRow.customer_id).toBeTruthy();

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = hist.debts.items.find((r) => r.source_id === txId);
    expect(debt).toBeTruthy();
    expect(debt.notes).toBe(note);
    expect(debt.original).toBe(Number(product.price));
    expect(debt.remaining).toBe(Number(product.price));

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/customers/${empRow.customer_id}/statement`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const saleRow = (stmt.rows || stmt.events || stmt.ledger?.events || []).find(
      (r) =>
        (r.sourceType === "sale" || r.ev_type === "sale" || r.source_type === "sale") &&
        Number(r.sourceId || r.ref_id) === Number(txId)
    ) || (stmt.rows || []).find((r) => Number(r.sourceId) === Number(txId));
    expect(saleRow).toBeTruthy();
    expect(saleRow.notes).toBe(note);

    const shift = unwrap(
      (await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(adminToken))).body
    );
    const sale = (shift.transactions || []).find((t) => Number(t.id) === Number(txId));
    expect(sale).toBeTruthy();
    expect(sale.notes).toBe(note);
  });

  test("customer ذمة notes survive approval onto the sale and customer statement", async () => {
    const note = "عميل: تسليم الغد";
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const pending = await checkoutOnAccount(
      { customer_id: customerId, notes: note },
      `oa-notes-cust-${customerId}`
    );
    expect(pending.status).toBe(202);
    const requestId = unwrap(pending.body).request_id;
    await approve(requestId);
    const oa = await ctx.db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oa.notes).toBe(note);
    const tx = await ctx.db.get("SELECT notes, total, customer_id FROM transactions WHERE id = ?", [
      oa.transaction_id,
    ]);
    expect(tx.notes).toBe(note);
    expect(Number(tx.customer_id)).toBe(customerId);
    expect(Number(tx.total)).toBe(Number(product.price));

    const stmt = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/customers/${customerId}/statement`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const saleRow = (stmt.rows || []).find((r) => Number(r.sourceId) === Number(oa.transaction_id));
    expect(saleRow).toBeTruthy();
    expect(saleRow.notes).toBe(note);
  });

  test("blank notes remain valid and do not change debt amounts", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__notes_blank__" });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const pending = await checkoutOnAccount(
      { employee_id: emp.id, notes: "   " },
      `oa-notes-blank-${emp.id}`
    );
    expect(pending.status).toBe(202);
    const requestId = unwrap(pending.body).request_id;
    const oa = await ctx.db.get("SELECT notes, review_notes FROM on_account_requests WHERE id = ?", [
      requestId,
    ]);
    expect(oa.notes).toBeNull();
    await approve(requestId);
    const posted = await ctx.db.get(
      "SELECT transaction_id, notes FROM on_account_requests WHERE id = ?",
      [requestId]
    );
    const tx = await ctx.db.get("SELECT notes, total FROM transactions WHERE id = ?", [
      posted.transaction_id,
    ]);
    expect(tx.notes).toBeNull();
    expect(Number(tx.total)).toBe(Number(product.price));
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = hist.debts.items.find((r) => r.source_id === posted.transaction_id);
    expect(debt.notes == null || debt.notes === "").toBe(true);
    expect(debt.remaining).toBe(Number(product.price));
  });

  test("notes over 500 characters are rejected", async () => {
    const res = await checkoutOnAccount(
      { customer_id: customerId, notes: "م".repeat(501) },
      "oa-notes-too-long-xx"
    );
    expect(res.status).toBe(400);
    expect(res.body.code === "VALIDATION_ERROR" || res.body.code === "NOTES_TOO_LONG").toBe(true);
  });

  test("retry with the same notes replays; different notes reuse the key as a mismatch", async () => {
    const note = "نفس الملاحظة";
    const key = "oa-notes-idem-000008";
    const first = await checkoutOnAccount({ customer_id: customerId, notes: note }, key);
    expect(first.status).toBe(202);
    const requestId = unwrap(first.body).request_id;

    const replay = await checkoutOnAccount({ customer_id: customerId, notes: ` ${note} ` }, key);
    expect(replay.status).toBe(202);
    expect(unwrap(replay.body).request_id).toBe(requestId);
    expect(unwrap(replay.body).idempotent_replay).toBe(true);

    const mismatch = await checkoutOnAccount(
      { customer_id: customerId, notes: "ملاحظة مختلفة" },
      key
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("IDEMPOTENCY_KEY_REUSE");
    const count = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM on_account_requests WHERE idempotency_key = ?",
      [key]
    );
    expect(count.c).toBe(1);
    const oa = await ctx.db.get("SELECT notes FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oa.notes).toBe(note);
  });
});
