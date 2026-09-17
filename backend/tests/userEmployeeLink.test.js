import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  createTestEmployee,
  createAccountantUser,
} from "./helpers.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";
import { ATTENDANCE_ROLES } from "../utils/roles.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function financeSnapshot(db) {
  const [
    employees,
    compensation,
    openings,
    ledger,
    entitlements,
    expenses,
    customers,
  ] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM employees"),
    db.get("SELECT COUNT(*) AS n FROM employee_compensation"),
    db.get("SELECT COUNT(*) AS n FROM employee_opening_balances"),
    db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries"),
    db.get("SELECT COUNT(*) AS n FROM employee_salary_entitlements"),
    db.get("SELECT COUNT(*) AS n FROM operating_expenses"),
    db.get("SELECT COUNT(*) AS n FROM customers"),
  ]);
  return {
    employees: employees.n,
    compensation: compensation.n,
    openings: openings.n,
    ledger: ledger.n,
    entitlements: entitlements.n,
    expenses: expenses.n,
    customers: customers.n,
  };
}

describe("إدارة الحسابات ↔ employee records", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashierId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    adminToken = adminLogin.body.token;
    cashierToken = cashierLogin.body.token;
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testcashier"]);
    cashierId = cashier.id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function uniqueName(prefix) {
    seq += 1;
    return `${prefix}${seq}`;
  }

  test("GET users and cashier-accounts do not create employees", async () => {
    const before = await financeSnapshot(ctx.db);
    const users = await request(ctx.app)
      .get("/api/v1/admin/users")
      .set(authHeader(adminToken));
    expect(users.status).toBe(200);
    const rows = unwrap(users.body);
    const existing = rows.find((u) => u.username === "testcashier");
    expect(existing).toBeTruthy();
    expect(existing.employee_id).toBeNull();

    const cashiers = await request(ctx.app)
      .get("/api/v1/employees/cashier-accounts")
      .set(authHeader(adminToken));
    expect(cashiers.status).toBe(200);
    expect(unwrap(cashiers.body).find((r) => r.user_id === cashierId).linked).toBe(false);

    expect(await financeSnapshot(ctx.db)).toEqual(before);
  });

  test.each(ATTENDANCE_ROLES)(
    "creating %s account also creates a linked employee in the same transaction",
    async (role) => {
      const before = await financeSnapshot(ctx.db);
      const username = uniqueName(`staff_${role}_`);
      const body = { username, role };
      if (role === "cashier") body.password = "staffpass1";

      const created = await request(ctx.app)
        .post("/api/v1/admin/users")
        .set(authHeader(adminToken))
        .send(body);
      expect(created.status).toBe(201);
      const user = unwrap(created.body);
      expect(user.username).toBe(username);
      expect(user.role).toBe(role);
      expect(user.employee_id).toEqual(expect.any(Number));
      expect(user.employee_name).toBe(username);
      expect(user.employee_active).toBe(true);

      const emp = await ctx.db.get("SELECT * FROM employees WHERE user_id = ?", [user.id]);
      expect(emp).toBeTruthy();
      expect(emp.id).toBe(user.employee_id);
      expect(emp.name).toBe(username);
      expect(Number(emp.active)).toBe(1);

      const listed = unwrap(
        (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
      );
      const found = listed.find((e) => e.id === emp.id);
      expect(found).toBeTruthy();
      expect(found.user_id).toBe(user.id);
      expect(found.kind).toBe(role === "cashier" ? "cashier" : "regular");

      const pos = unwrap(
        (await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken))).body
      );
      expect(pos.some((r) => r.id === emp.id && r.name === username)).toBe(true);

      const after = await financeSnapshot(ctx.db);
      expect(after.employees).toBe(before.employees + 1);
      expect(after.compensation).toBe(before.compensation);
      expect(after.openings).toBe(before.openings);
      expect(after.ledger).toBe(before.ledger);
      expect(after.entitlements).toBe(before.entitlements);
      expect(after.expenses).toBe(before.expenses);
      expect(after.customers).toBe(before.customers);

      const stmt = await request(ctx.app)
        .get(`/api/v1/employees/${emp.id}/statement`)
        .set(authHeader(adminToken));
      expect(stmt.status).toBe(200);

      if (role === "cashier") {
        const posLogin = await login(ctx.app, username, "staffpass1", "pos");
        expect(posLogin.status).toBe(200);
        await ctx.db.run(
          `INSERT INTO cashier_shifts
             (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
           VALUES (?, '2026-09-01T07:00:00.000Z', '2026-09-01T15:00:00.000Z', 100, 'closed', 20)`,
          [user.id]
        );
        const hours = unwrap(
          (
            await request(ctx.app)
              .get(`/api/v1/employees/${emp.id}/hours-preview`)
              .query({ from: "2026-09-01", to: "2026-09-30" })
              .set(authHeader(adminToken))
          ).body
        );
        expect(hours.applicable).toBe(true);
        expect(hours.posted_hours).toBeGreaterThan(0);
      } else {
        const hours = unwrap(
          (
            await request(ctx.app)
              .get(`/api/v1/employees/${emp.id}/hours-preview`)
              .query({ from: "2026-09-01", to: "2026-09-30" })
              .set(authHeader(adminToken))
          ).body
        );
        expect(hours.applicable).toBe(false);
        const officeLogin = await login(ctx.app, username, "x", "office");
        expect(officeLogin.status).toBeGreaterThanOrEqual(400);
        const posLogin = await login(ctx.app, username, "x", "pos");
        expect(posLogin.status).toBeGreaterThanOrEqual(400);
      }
    }
  );

  test("admin and accountant accounts are not auto-treated as employees", async () => {
    const before = await financeSnapshot(ctx.db);
    const adminName = uniqueName("mgr_");
    const acctName = uniqueName("acct_");
    const adminRes = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: adminName, password: "adminpass9", role: "admin" });
    expect(adminRes.status).toBe(201);
    expect(unwrap(adminRes.body).employee_id).toBeNull();

    const acctRes = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: acctName, password: "acctpass9", role: "accountant" });
    expect(acctRes.status).toBe(201);
    expect(unwrap(acctRes.body).employee_id).toBeNull();

    const withLink = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: uniqueName("acct_link_"),
        password: "acctpass9",
        role: "accountant",
        employee_id: 1,
      });
    expect(withLink.status).toBe(400);
    expect(withLink.body.code).toBe("USER_NOT_STAFF");

    expect((await financeSnapshot(ctx.db)).employees).toBe(before.employees);
  });

  test("optional link of an existing unlinked employee does not duplicate", async () => {
    const standing = await createTestEmployee(ctx.db, { name: "سجل قائم للربط" });
    const before = await financeSnapshot(ctx.db);
    const username = uniqueName("linkstaff_");
    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username,
        password: "staffpass1",
        role: "cashier",
        employee_id: standing.id,
        employee_name: "يجب أن يُتجاهل",
      });
    expect(created.status).toBe(201);
    const user = unwrap(created.body);
    expect(user.employee_id).toBe(standing.id);
    expect(user.employee_name).toBe("سجل قائم للربط");
    expect((await financeSnapshot(ctx.db)).employees).toBe(before.employees);

    const row = await ctx.db.get("SELECT user_id, name FROM employees WHERE id = ?", [standing.id]);
    expect(row.user_id).toBe(user.id);
    expect(row.name).toBe("سجل قائم للربط");
  });

  test("does not link by matching names and rejects a second employee for the same user", async () => {
    const sameName = uniqueName("توأم_");
    const standing = await createTestEmployee(ctx.db, { name: sameName });
    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: sameName, password: "staffpass1", role: "shelves_employee" });
    expect(created.status).toBe(201);
    const user = unwrap(created.body);
    expect(user.employee_id).not.toBe(standing.id);
    const count = await ctx.db.get("SELECT COUNT(*) AS n FROM employees WHERE name = ?", [sameName]);
    expect(count.n).toBe(2);

    const dupUser = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: "نسخة ثانية", user_id: user.id });
    expect(dupUser.status).toBe(409);
    expect(dupUser.body.code).toBe("USER_ALREADY_LINKED");
  });

  test("linking an already-linked employee rolls back the new user", async () => {
    const standing = await createTestEmployee(ctx.db, { name: "موظف مربوط مسبقاً" });
    const firstName = uniqueName("firstlink_");
    const first = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: firstName,
        password: "staffpass1",
        role: "cashier",
        employee_id: standing.id,
      });
    expect(first.status).toBe(201);

    const beforeUsers = await ctx.db.get("SELECT COUNT(*) AS n FROM users");
    const ghost = uniqueName("ghost_");
    const second = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: ghost,
        password: "staffpass1",
        role: "bakery_employee",
        employee_id: standing.id,
      });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("EMPLOYEE_ALREADY_LINKED");
    expect(await ctx.db.get("SELECT id FROM users WHERE username = ?", [ghost])).toBeUndefined();
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM users")).n).toBe(beforeUsers.n);
  });

  test("invalid employee_id rolls back account creation", async () => {
    const beforeUsers = await ctx.db.get("SELECT COUNT(*) AS n FROM users");
    const beforeEmp = await ctx.db.get("SELECT COUNT(*) AS n FROM employees");
    const ghost = uniqueName("rollback_");
    const res = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: ghost,
        password: "staffpass1",
        role: "cashier",
        employee_id: 999999,
      });
    expect(res.status).toBe(404);
    expect(await ctx.db.get("SELECT id FROM users WHERE username = ?", [ghost])).toBeUndefined();
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM users")).n).toBe(beforeUsers.n);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employees")).n).toBe(beforeEmp.n);
  });

  test("reconcile backfills unlinked staff by user_id without finance and is idempotent", async () => {
    const before = await financeSnapshot(ctx.db);
    const first = await request(ctx.app)
      .post("/api/v1/admin/users/reconcile-employees")
      .set(authHeader(adminToken))
      .send({});
    expect(first.status).toBe(200);
    const body = unwrap(first.body);
    expect(body.created_count).toBeGreaterThanOrEqual(1);
    const forCashier = body.created.find((row) => row.user_id === cashierId);
    expect(forCashier).toBeTruthy();
    expect(forCashier.employee_id).toEqual(expect.any(Number));
    expect(forCashier.employee_name).toBe("testcashier");

    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
    );
    expect(listed.some((e) => e.user_id === cashierId)).toBe(true);
    const pos = unwrap(
      (await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken))).body
    );
    expect(pos.some((r) => r.id === forCashier.employee_id)).toBe(true);

    const afterCreate = await financeSnapshot(ctx.db);
    expect(afterCreate.employees).toBe(before.employees + body.created_count);
    expect(afterCreate.compensation).toBe(before.compensation);
    expect(afterCreate.openings).toBe(before.openings);
    expect(afterCreate.ledger).toBe(before.ledger);
    expect(afterCreate.entitlements).toBe(before.entitlements);
    expect(afterCreate.expenses).toBe(before.expenses);
    expect(afterCreate.customers).toBe(before.customers);

    const again = await request(ctx.app)
      .post("/api/v1/admin/users/reconcile-employees")
      .set(authHeader(adminToken))
      .send({});
    expect(again.status).toBe(200);
    expect(unwrap(again.body).created_count).toBe(0);
    expect(unwrap(again.body).reused.some((row) => row.user_id === cashierId)).toBe(true);
    expect((await financeSnapshot(ctx.db)).employees).toBe(afterCreate.employees);
  });

  test("reconcile does not merge same-name standalone employees", async () => {
    const username = uniqueName("twin_");
    const hash = await bcrypt.hash("staffpass1", 4);
    const ins = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'bakery_employee', 0)",
      [username, hash]
    );
    const standing = await createTestEmployee(ctx.db, { name: username });
    const rate = await request(ctx.app)
      .post(`/api/v1/employees/${standing.id}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: "2026-02-01", compensation_type: "monthly", amount: 2100 });
    expect(rate.status).toBe(201);
    const beforeLed = await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries");

    const recon = unwrap(
      (
        await request(ctx.app)
          .post("/api/v1/admin/users/reconcile-employees")
          .set(authHeader(adminToken))
          .send({})
      ).body
    );
    const created = recon.created.find((row) => row.user_id === ins.lastID);
    expect(created).toBeTruthy();
    expect(created.employee_id).not.toBe(standing.id);
    expect(recon.ambiguous.some((row) => row.employee_id === standing.id && row.reason === "name_collision")).toBe(
      true
    );

    const standingRow = await ctx.db.get("SELECT user_id FROM employees WHERE id = ?", [standing.id]);
    expect(standingRow.user_id).toBeNull();
    const rates = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${standing.id}`).set(authHeader(adminToken))).body
    ).compensation;
    expect(rates).toHaveLength(1);
    expect(rates[0].amount).toBe(2100);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM employee_ledger_entries")).n).toBe(beforeLed.n);

    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
    );
    expect(listed.filter((e) => e.user_id === ins.lastID)).toHaveLength(1);
  });

  test("role change keeps employee history and does not delete the record", async () => {
    const username = uniqueName("rolechange_");
    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username, password: "staffpass1", role: "cashier", employee_name: "كاشير للترقية" });
    const user = unwrap(created.body);
    const empId = user.employee_id;
    const rate = await request(ctx.app)
      .post(`/api/v1/employees/${empId}/compensation`)
      .set(authHeader(adminToken))
      .send({ effective_from: "2026-01-01", compensation_type: "hourly", amount: 22 });
    expect(rate.status).toBe(201);

    const patched = await request(ctx.app)
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(authHeader(adminToken))
      .send({ role: "accountant" });
    expect(patched.status).toBe(200);
    expect(unwrap(patched.body).role).toBe("accountant");
    expect(unwrap(patched.body).employee_id).toBe(empId);

    const emp = await ctx.db.get("SELECT * FROM employees WHERE id = ?", [empId]);
    expect(emp.user_id).toBe(user.id);
    const listed = unwrap(
      (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
    ).find((e) => e.id === empId);
    expect(listed.kind).toBe("regular");
    expect(listed.user_role).toBe("accountant");

    const stmt = await request(ctx.app)
      .get(`/api/v1/employees/${empId}/statement`)
      .set(authHeader(adminToken));
    expect(stmt.status).toBe(200);
    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/employees/${empId}`).set(authHeader(adminToken))).body
    );
    expect(detail.compensation).toHaveLength(1);
    expect(detail.compensation[0].amount).toBe(22);
  });

  test("account deletion does not cascade into employee, shifts, or payments", async () => {
    const username = uniqueName("nodel_");
    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username, password: "staffpass1", role: "cashier" });
    const user = unwrap(created.body);
    const empId = user.employee_id;
    await ctx.db.run(
      `INSERT INTO cashier_shifts
         (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
       VALUES (?, '2026-09-02T07:00:00.000Z', '2026-09-02T15:00:00.000Z', 50, 'closed', 18)`,
      [user.id]
    );

    const removed = await request(ctx.app)
      .delete(`/api/v1/admin/users/${user.id}`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(400);
    expect(removed.body.code).toBe("USER_HAS_EMPLOYEE");
    expect(await ctx.db.get("SELECT id FROM users WHERE id = ?", [user.id])).toBeTruthy();
    expect(await ctx.db.get("SELECT id FROM employees WHERE id = ?", [empId])).toBeTruthy();
    expect(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts WHERE cashier_id = ?", [user.id])).n
    ).toBeGreaterThan(0);
  });

  test("inactive employee stays on office lists and drops out of POS selection", async () => {
    const username = uniqueName("inactive_");
    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username, password: "staffpass1", role: "cashier" });
    const empId = unwrap(created.body).employee_id;
    const inactive = await request(ctx.app)
      .patch(`/api/v1/employees/${empId}`)
      .set(authHeader(adminToken))
      .send({ active: false });
    expect(inactive.status).toBe(200);

    const office = unwrap(
      (await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken))).body
    );
    expect(office.some((e) => e.id === empId && e.active === false)).toBe(true);
    const stmt = await request(ctx.app)
      .get(`/api/v1/employees/${empId}/statement`)
      .set(authHeader(adminToken));
    expect(stmt.status).toBe(200);

    const pos = unwrap(
      (await request(ctx.app).get("/api/v1/pos/employees").set(authHeader(cashierToken))).body
    );
    expect(pos.some((r) => r.id === empId)).toBe(false);
  });

  test("standalone employees without login accounts remain supported", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/employees")
      .set(authHeader(adminToken))
      .send({ name: uniqueName("مستقل_") });
    expect(res.status).toBe(201);
    expect(unwrap(res.body).user_id).toBeNull();
    expect(unwrap(res.body).kind).toBe("regular");
  });

  test("user_accounts can create/link identity but does not grant payroll viewing", async () => {
    const acct = await createAccountantUser(ctx.db, {
      username: uniqueName("acct_users_"),
      permissions: {
        ...defaultAccountantPermissions(),
        user_accounts: true,
        employee_payroll: false,
      },
    });
    const loginRes = await login(ctx.app, acct.username, acct.password, "office");
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;
    const hdr = authHeader(token);

    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(hdr)
      .send({ username: uniqueName("fromacct_"), password: "staffpass1", role: "cashier" });
    expect(created.status).toBe(201);
    const empId = unwrap(created.body).employee_id;
    expect(empId).toEqual(expect.any(Number));

    expect((await request(ctx.app).get("/api/v1/employees").set(hdr)).status).toBe(403);
    expect(
      (await request(ctx.app).get(`/api/v1/employees/${empId}/statement`).set(hdr)).status
    ).toBe(403);
    expect((await request(ctx.app).get("/api/v1/employees/staff-accounts").set(hdr)).status).toBe(
      403
    );
    const recon = await request(ctx.app).post("/api/v1/admin/users/reconcile-employees").set(hdr).send({});
    expect(recon.status).toBe(200);
    expect(unwrap(recon.body).created_count).toBeGreaterThanOrEqual(0);
  });

  test("staff-accounts lists all attendance roles without creating rows", async () => {
    const before = await financeSnapshot(ctx.db);
    const res = await request(ctx.app)
      .get("/api/v1/employees/staff-accounts")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res.body);
    expect(rows.every((r) => ATTENDANCE_ROLES.includes(r.role))).toBe(true);
    expect(rows.some((r) => r.role === "cashier")).toBe(true);
    expect(await financeSnapshot(ctx.db)).toEqual(before);
  });
});
