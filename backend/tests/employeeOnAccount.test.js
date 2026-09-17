import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createTestEmployee,
  createAccountantUser,
} from "./helpers.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("employee on-account (ذمة) checkout", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierUserId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierUserId = cashier.id;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    await ctx.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createLinkedEmployee(name) {
    const created = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, start_on: "2026-01-01" });
    expect(created.status).toBe(201);
    const emp = unwrap(created.body);
    const account = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(adminToken))
      .send({});
    expect([200, 201]).toContain(account.status);
    return unwrap(account.body);
  }

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

  async function approve(requestId) {
    const res = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    return unwrap(res.body);
  }

  test("schema stores employee_id and allows pending ذمة without customer_id", async () => {
    const txCols = await ctx.db.all("PRAGMA table_info(transactions)");
    const oaCols = await ctx.db.all("PRAGMA table_info(on_account_requests)");
    expect(txCols.some((c) => c.name === "employee_id")).toBe(true);
    expect(oaCols.some((c) => c.name === "employee_id")).toBe(true);
    const customerCol = oaCols.find((c) => c.name === "customer_id");
    expect(customerCol).toBeTruthy();
    expect(Number(customerCol.notnull)).toBe(0);
  });

  async function customerCount() {
    return Number((await ctx.db.get("SELECT COUNT(*) AS n FROM customers")).n);
  }

  test("POS lookup still exposes only selection fields", async () => {
    const res = await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["display_name", "employee_no", "id", "name"]);
      expect(row).not.toHaveProperty("customer_id");
      expect(row).not.toHaveProperty("balance");
    }
  });

  test("selecting an employee does not create a debt account", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_select_only__" });
    const customersBefore = await customerCount();
    const res = await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    expect(unwrap(res.body).some((row) => row.id === emp.id)).toBe(true);
    expect(await customerCount()).toBe(customersBefore);
    const row = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id]);
    expect(row.customer_id).toBeNull();
  });

  test("employee without a customer account can submit a pending ذمة with no finance", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_unlinked__" });
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const customersBefore = await customerCount();
    const txBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);

    const res = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-pending-${emp.id}`);
    expect(res.status).toBe(202);
    const requestId = unwrap(res.body).request_id;
    expect(requestId).toBeTruthy();

    const oa = await ctx.db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oa.status).toBe("pending");
    expect(Number(oa.employee_id)).toBe(emp.id);
    expect(oa.customer_id).toBeNull();
    expect(oa.transaction_id).toBeNull();
    expect(await customerCount()).toBe(customersBefore);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(txBefore);
    expect((await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id])).customer_id).toBeNull();

    const pendingList = await request(ctx.app)
      .get("/api/v1/on-account-requests/pending")
      .set(authHeader(adminToken));
    expect(pendingList.status).toBe(200);
    const listed = unwrap(pendingList.body).find((row) => row.id === requestId);
    expect(listed).toBeTruthy();
    expect(listed.employee_name).toBe("__zimma_unlinked__");
  });

  test("authorized posting creates one linked account and one debt for an unlinked employee", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_autopost__" });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sameName = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES (?, 'SN-AUTO', 0, 0, 0)`,
      [emp.name]
    );
    const customersBefore = await customerCount();
    const openingsBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_opening_balances")).n);
    const ledgerBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE employee_id = ?", [emp.id])).n
    );

    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-auto-${emp.id}`);
    expect(pending.status).toBe(202);
    expect(await customerCount()).toBe(customersBefore);

    const approved = await approve(unwrap(pending.body).request_id);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    expect(txId).toBeTruthy();

    const linked = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id]);
    expect(linked.customer_id).toBeTruthy();
    expect(Number(linked.customer_id)).not.toBe(sameName.lastID);
    expect(await customerCount()).toBe(customersBefore + 1);

    const tx = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    expect(Number(tx.employee_id)).toBe(emp.id);
    expect(Number(tx.customer_id)).toBe(Number(linked.customer_id));
    expect(
      Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [linked.customer_id])).balance)
    ).toBe(Number(product.price));
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_opening_balances")).n)).toBe(
      openingsBefore
    );
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE employee_id = ?", [emp.id])).n)
    ).toBe(ledgerBefore);

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = hist.debts.items.find((row) => row.source_id === txId);
    expect(debt).toBeTruthy();
    expect(debt.original).toBe(Number(product.price));
    expect(debt.remaining).toBe(Number(product.price));
  });

  test("explicit debt-account create does not match an existing same-name customer", async () => {
    const name = "__zimma_same_name__";
    const existing = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES (?, 'SN-OLD', 0, 0, 0)`,
      [name]
    );
    const empRes = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name, start_on: "2026-01-01" });
    const emp = unwrap(empRes.body);
    const created = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(adminToken))
      .send({});
    expect(created.status).toBe(201);
    const row = unwrap(created.body);
    expect(row.customer_id).toBeTruthy();
    expect(row.customer_id).not.toBe(existing.lastID);
    const twins = await ctx.db.all("SELECT id FROM customers WHERE name = ?", [name]);
    expect(twins.length).toBe(2);
  });

  test("cashier cannot create a debt account; accountant without payroll cannot either", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_perm__" });
    const cashierTry = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(cashierToken))
      .send({});
    expect(cashierTry.status).toBe(403);

    await createAccountantUser(ctx.db, {
      username: "acct-no-payroll",
      permissions: { ...defaultAccountantPermissions(), employee_payroll: false },
    });
    const acctLogin = await login(ctx.app, "acct-no-payroll", "acctpass123");
    const acctTry = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/debt-account`)
      .set(authHeader(acctLogin.body.token))
      .send({});
    expect(acctTry.status).toBe(403);
  });

  test("employee selected then approved appears only on that employee statement", async () => {
    const empA = await createLinkedEmployee("__zimma_emp_a__");
    const empB = await createLinkedEmployee("__zimma_emp_b__");
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = Number(product.stock);
    const ledgerBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE employee_id = ?", [empA.id])).n
    );
    const balanceBefore = Number(
      (await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [empA.customer_id])).balance
    );

    const pending = await checkoutOnAccount({ employee_id: empA.id }, `oa-emp-a-${empA.id}`);
    expect(pending.status).toBe(202);
    const requestId = unwrap(pending.body).request_id;
    expect(requestId).toBeTruthy();

    const oa = await ctx.db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    expect(oa.status).toBe("pending");
    expect(Number(oa.employee_id)).toBe(empA.id);
    expect(Number(oa.customer_id)).toBe(empA.customer_id);
    expect(oa.transaction_id).toBeNull();
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );
    expect(
      Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [empA.customer_id])).balance)
    ).toBe(balanceBefore);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE employee_id = ?", [empA.id])).n)
    ).toBe(ledgerBefore);

    const approved = await approve(requestId);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    expect(txId).toBeTruthy();

    const tx = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    expect(Number(tx.employee_id)).toBe(empA.id);
    expect(Number(tx.customer_id)).toBe(empA.customer_id);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore - 1
    );
    expect(
      Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [empA.customer_id])).balance)
    ).toBe(balanceBefore + Number(product.price));
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries WHERE employee_id = ?", [empA.id])).n)
    ).toBe(ledgerBefore);

    const histA = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${empA.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const debtA = histA.debts.items.find((row) => row.source_id === txId);
    expect(debtA).toBeTruthy();
    expect(debtA.original).toBe(Number(product.price));
    expect(debtA.remaining).toBe(Number(product.price));
    expect(debtA.invoice_no).toBeTruthy();
    expect(Array.isArray(debtA.products)).toBe(true);
    expect(debtA.products.length).toBeGreaterThan(0);

    const histB = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${empB.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((histB.debts.items || []).some((row) => row.source_id === txId)).toBe(false);

    const unlink = await request(ctx.app)
      .post(`/api/v1/employees/${empA.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: null });
    expect(unlink.status).toBe(409);
    expect(unlink.body.code || unwrap(unlink.body).code).toBe("EMPLOYEE_DEBT_ACCOUNT_IN_USE");

    const steal = await request(ctx.app)
      .post(`/api/v1/employees/${empB.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: empA.customer_id });
    expect(steal.status).toBe(409);
    expect(steal.body.code || unwrap(steal.body).code).toMatch(/CUSTOMER_HAS_HISTORY|CUSTOMER_ALREADY_LINKED|EMPLOYEE_DEBT_ACCOUNT_IN_USE/);

    const histAAfter = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${empA.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(histAAfter.debts.items.some((row) => row.source_id === txId)).toBe(true);
    const histBAfter = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${empB.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((histBAfter.debts.items || []).some((row) => row.source_id === txId)).toBe(false);
  });

  test("existing customer ذمة flow still works and is not attributed to another employee", async () => {
    const walkIn = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('__zimma_walkin__', 'WI-OA', 0, 0, 10000)`
    );
    const emp = await createLinkedEmployee("__zimma_other_emp__");
    const pending = await checkoutOnAccount({ customer_id: walkIn.lastID }, `oa-cust-${walkIn.lastID}`);
    expect(pending.status).toBe(202);
    const approved = await approve(unwrap(pending.body).request_id);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    const tx = await ctx.db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    expect(Number(tx.customer_id)).toBe(walkIn.lastID);
    expect(tx.employee_id).toBeNull();
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((hist.debts.items || []).some((row) => row.source_id === txId)).toBe(false);
  });

  test("duplicate employee ذمة submission does not duplicate the sale or debt", async () => {
    const emp = await createLinkedEmployee("__zimma_idem__");
    const key = `oa-emp-idem-${emp.id}`;
    const first = await checkoutOnAccount({ employee_id: emp.id }, key);
    expect(first.status).toBe(202);
    const requestId = unwrap(first.body).request_id;
    const replay = await checkoutOnAccount({ employee_id: emp.id }, key);
    expect(replay.status).toBe(202);
    expect(unwrap(replay.body).request_id).toBe(requestId);
    const count = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM on_account_requests WHERE idempotency_key = ?",
      [key]
    );
    expect(count.n).toBe(1);
    await approve(requestId);
    const again = await checkoutOnAccount({ employee_id: emp.id }, key);
    expect([200, 202]).toContain(again.status);
    const txs = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?", [key]);
    expect(txs.n).toBe(1);
  });

  test("rejected employee ذمة has no financial effect", async () => {
    const emp = await createLinkedEmployee("__zimma_reject__");
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const balBefore = Number(
      (await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id])).balance
    );
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-rej-${emp.id}`);
    const requestId = unwrap(pending.body).request_id;
    const rejected = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(rejected.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );
    expect(
      Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id])).balance)
    ).toBe(balBefore);
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((hist.debts.items || []).length).toBe(0);
  });

  test("salary deduction reduces the same invoice outstanding once", async () => {
    const emp = await createLinkedEmployee("__zimma_payroll__");
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-pay-${emp.id}`);
    const approved = await approve(unwrap(pending.body).request_id);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    const original = Number(product.price);

    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-09-01", period_to: "2026-09-30", as_of: "2026-09-30" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = preview.debts.find((row) => row.source_id === txId);
    expect(debt).toBeTruthy();
    expect(debt.remaining).toBe(original);
    expect(debt.selectable).toBe(true);

    const payout = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-09-01",
        period_to: "2026-09-30",
        occurred_on: "2026-09-30",
        salary_before_deductions: 500,
        cash_paid: 500 - original,
        payment_method: "transfer",
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: original }],
        idempotency_key: `debt-once-${emp.id}`,
      });
    expect(payout.status).toBe(201);

    const again = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/payroll-payouts`)
      .set(authHeader(adminToken))
      .send({
        period_from: "2026-10-01",
        period_to: "2026-10-31",
        occurred_on: "2026-10-16",
        salary_before_deductions: 500,
        cash_paid: 0,
        deductions: [{ kind: "debt", source_type: "pos_sale", source_id: txId, amount: original }],
        idempotency_key: `debt-twice-${emp.id}`,
      });
    expect(again.status).toBe(201);
    expect(unwrap(again.body).breakdown.product_debt_deducted).toBe(0);

    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    const row = hist.debts.items.find((item) => item.source_id === txId);
    expect(row.settled).toBe(original);
    expect(row.remaining).toBe(0);
    expect(
      Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id])).balance)
    ).toBe(0);
  });

  test("authorized posting of an unlinked employee is available for salary deduction", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_auto_pay__" });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-autopay-${emp.id}`);
    const approved = await approve(unwrap(pending.body).request_id);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    const preview = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/payroll-preview`)
          .query({ period_from: "2026-09-01", period_to: "2026-09-30", as_of: "2026-09-30" })
          .set(authHeader(adminToken))
      ).body
    );
    const debt = preview.debts.find((row) => row.source_id === txId);
    expect(debt).toBeTruthy();
    expect(debt.remaining).toBe(Number(product.price));
    expect(debt.selectable).toBe(true);
  });

  test("rejected unlinked employee ذمة creates no account or financial records", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_unlinked_rej__" });
    const customersBefore = await customerCount();
    const stockBefore = Number(
      (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock
    );
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-unlinked-rej-${emp.id}`);
    const rejected = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(pending.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(rejected.status).toBe(200);
    expect(await customerCount()).toBe(customersBefore);
    expect((await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id])).customer_id).toBeNull();
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(
      stockBefore
    );
    const hist = unwrap(
      (
        await request(ctx.app)
          .get(`/api/v1/employees/${emp.id}/history`)
          .query({ from: "2020-01-01", to: "2030-12-31" })
          .set(authHeader(adminToken))
      ).body
    );
    expect((hist.debts.items || []).length).toBe(0);
  });

  test("retry and concurrent posting do not duplicate the employee debt account or sale", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_race__" });
    const key = `oa-emp-race-${emp.id}`;
    const [first, second] = await Promise.all([
      checkoutOnAccount({ employee_id: emp.id }, key),
      checkoutOnAccount({ employee_id: emp.id }, key),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 202]);
    const requestId = unwrap(first.body).request_id;
    expect(unwrap(second.body).request_id).toBe(requestId);
    expect(
      Number(
        (await ctx.db.get("SELECT COUNT(*) AS n FROM on_account_requests WHERE idempotency_key = ?", [key])).n
      )
    ).toBe(1);

    const [approveRes, retry] = await Promise.all([
      request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
      checkoutOnAccount({ employee_id: emp.id }, key),
    ]);
    expect(approveRes.status).toBe(200);
    expect([200, 202]).toContain(retry.status);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?", [key])).n)
    ).toBe(1);
    expect(
      Number(
        (await ctx.db.get("SELECT COUNT(*) AS n FROM employees WHERE id = ? AND customer_id IS NOT NULL", [emp.id])).n
      )
    ).toBe(1);

    const other = await createTestEmployee(ctx.db, { name: "__zimma_two_sales__" });
    const a = await checkoutOnAccount({ employee_id: other.id }, `oa-emp-two-a-${other.id}`);
    const b = await checkoutOnAccount({ employee_id: other.id }, `oa-emp-two-b-${other.id}`);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const [okA, okB] = await Promise.all([
      request(ctx.app)
        .put(`/api/v1/on-account-requests/${unwrap(a.body).request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
      request(ctx.app)
        .put(`/api/v1/on-account-requests/${unwrap(b.body).request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" }),
    ]);
    expect(okA.status).toBe(200);
    expect(okB.status).toBe(200);
    const linked = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [other.id]);
    expect(linked.customer_id).toBeTruthy();
    const txs = await ctx.db.all(
      "SELECT id FROM transactions WHERE employee_id = ? AND customer_id = ?",
      [other.id, linked.customer_id]
    );
    expect(txs.length).toBe(2);
    const accounts = await ctx.db.all(
      `SELECT id FROM customers WHERE id IN (
         SELECT customer_id FROM employees WHERE id = ?
       )`,
      [other.id]
    );
    expect(accounts.length).toBe(1);
  });

  test("failed posting rolls back the auto-created debt account", async () => {
    const emp = await createTestEmployee(ctx.db, { name: "__zimma_fail_post__" });
    const customersBefore = await customerCount();
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-fail-${emp.id}`);
    const requestId = unwrap(pending.body).request_id;
    const oa = await ctx.db.get("SELECT sale_snapshot_json FROM on_account_requests WHERE id = ?", [requestId]);
    const snap = JSON.parse(oa.sale_snapshot_json);
    snap.promoBreakdown = [{ promotion_id: 999999001, units_used: 1 }];
    await ctx.db.run("UPDATE on_account_requests SET sale_snapshot_json = ? WHERE id = ?", [
      JSON.stringify(snap),
      requestId,
    ]);

    const failed = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await customerCount()).toBe(customersBefore);
    expect((await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id])).customer_id).toBeNull();
    expect(
      Number(
        (await ctx.db.get("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?", [
          `oa-emp-fail-${emp.id}`,
        ])).n
      )
    ).toBe(0);
    const stillPending = await ctx.db.get("SELECT status, customer_id FROM on_account_requests WHERE id = ?", [
      requestId,
    ]);
    expect(stillPending.status).toBe("pending");
    expect(stillPending.customer_id).toBeNull();
  });

  test("conflicting employee customer links are rejected without merging debt", async () => {
    const emp = await createLinkedEmployee("__zimma_conflict__");
    const originalCustomerId = emp.customer_id;
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-conflict-${emp.id}`);
    expect(pending.status).toBe(202);
    expect(Number((await ctx.db.get(
      "SELECT customer_id FROM on_account_requests WHERE id = ?",
      [unwrap(pending.body).request_id]
    )).customer_id)).toBe(Number(originalCustomerId));

    const other = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('__zimma_conflict_other__', 'CF-NEW', 0, 0, 0)`
    );
    const relink = await request(ctx.app)
      .post(`/api/v1/employees/${emp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: other.lastID });
    expect(relink.status).toBe(409);
    expect(relink.body.code || unwrap(relink.body).code).toBe("EMPLOYEE_DEBT_ACCOUNT_IN_USE");
    expect(
      Number((await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [emp.id])).customer_id)
    ).toBe(Number(originalCustomerId));

    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(pending.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const owner = await createLinkedEmployee("__zimma_owner__");
    const ownerPending = await checkoutOnAccount({ employee_id: owner.id }, `oa-emp-owner-${owner.id}`);
    expect(ownerPending.status).toBe(202);
    const otherEmp = await createTestEmployee(ctx.db, { name: "__zimma_other_emp__" });
    const unlinkOwner = await request(ctx.app)
      .post(`/api/v1/employees/${owner.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: null });
    expect(unlinkOwner.status).toBe(409);
    const steal = await request(ctx.app)
      .post(`/api/v1/employees/${otherEmp.id}/link-customer`)
      .set(authHeader(adminToken))
      .send({ customer_id: owner.customer_id });
    expect(steal.status).toBe(409);
    expect(steal.body.code || unwrap(steal.body).code).toMatch(/CUSTOMER_HAS_HISTORY|CUSTOMER_ALREADY_LINKED|EMPLOYEE_DEBT_ACCOUNT_IN_USE/);
    const stillOwner = await ctx.db.get("SELECT customer_id FROM employees WHERE id = ?", [owner.id]);
    expect(Number(stillOwner.customer_id)).toBe(Number(owner.customer_id));
    const stolenApprove = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${unwrap(ownerPending.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(stolenApprove.status).toBe(200);
  });

  test("statement invoice receipt preview is the printable POS slip", async () => {
    const emp = await createLinkedEmployee("__zimma_receipt_preview__");
    const other = await createLinkedEmployee("__zimma_receipt_other__");
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const pending = await checkoutOnAccount({ employee_id: emp.id }, `oa-emp-receipt-${emp.id}`);
    expect(pending.status).toBe(202);
    const approved = await approve(unwrap(pending.body).request_id);
    const txId = approved.checkout?.transaction_id || approved.request?.transaction_id;
    expect(txId).toBeTruthy();
    const tx = await ctx.db.get("SELECT receipt_number FROM transactions WHERE id = ?", [txId]);

    const res = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/invoices/pos_sale/${txId}/receipt`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = unwrap(res.body);
    expect(body.kind).toBe("pos_receipt");
    expect(body.transaction_id).toBe(txId);
    expect(body.receipt_html).toContain(tx.receipt_number || "INV-");
    expect(body.receipt_html).toContain("INV-");
    expect(body.receipt_html).toContain(product.name);
    expect(body.receipt_text).toContain(product.name);

    const stolen = await request(ctx.app)
      .get(`/api/v1/employees/${other.id}/invoices/pos_sale/${txId}/receipt`)
      .set(authHeader(adminToken));
    expect(stolen.status).toBe(404);

    await createAccountantUser(ctx.db, {
      username: "acct-no-receipt-preview",
      permissions: { ...defaultAccountantPermissions(), employee_payroll: false },
    });
    const acctLogin = await login(ctx.app, "acct-no-receipt-preview", "acctpass123");
    const denied = await request(ctx.app)
      .get(`/api/v1/employees/${emp.id}/invoices/pos_sale/${txId}/receipt`)
      .set(authHeader(acctLogin.body.token));
    expect(denied.status).toBe(403);
  });
});
