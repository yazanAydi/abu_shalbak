import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";
import { formatEmploymentDuration } from "../utils/employmentDuration.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("employment start date", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("duration is calculated from the start date and is not stored", () => {
    expect(formatEmploymentDuration("2026-09-20", "2026-10-03")).toBe("13 يوم");
    expect(formatEmploymentDuration("2026-03-03", "2026-10-03")).toBe("7 أشهر");
    expect(formatEmploymentDuration("2024-06-15", "2026-10-03")).toBe("2 سنة و 3 أشهر");
    expect(formatEmploymentDuration(null, "2026-10-03")).toBeNull();
    expect(formatEmploymentDuration("2026-10-03", "2026-10-03")).toBe("0 يوم");
  });

  test("creates an employee with a start date and without one", async () => {
    const withDate = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({
        username: "start-dated",
        password: "pass1234",
        role: "cashier",
        start_on: "2026-09-20",
      });
    expect(withDate.status).toBe(201);
    const created = unwrap(withDate.body);
    expect(created.start_on).toBe("2026-09-20");
    expect(created.employment_duration).toBeTruthy();
    const row = await ctx.db.get("SELECT start_on FROM employees WHERE user_id = ?", [created.id]);
    expect(row.start_on).toBe("2026-09-20");
    const storedColumns = await ctx.db.all("PRAGMA table_info(employees)");
    expect(storedColumns.map((col) => col.name)).not.toContain("employment_duration");

    const without = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: "start-empty", password: "pass1234", role: "cashier" });
    expect(without.status).toBe(201);
    expect(unwrap(without.body).start_on).toBeNull();
    const empty = await ctx.db.get("SELECT start_on FROM employees WHERE user_id = ?", [
      unwrap(without.body).id,
    ]);
    expect(empty.start_on).toBeNull();
  });

  test("updates and clears the start date, and rejects a future date", async () => {
    const user = unwrap(
      (
        await request(ctx.app)
          .post("/api/v1/admin/users")
          .set(authHeader(adminToken))
          .send({ username: "start-edit", password: "pass1234", role: "cashier", start_on: "2024-06-15" })
      ).body
    );
    const updated = await request(ctx.app)
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(authHeader(adminToken))
      .send({ start_on: "2026-03-03" });
    expect(updated.status).toBe(200);
    expect(unwrap(updated.body).start_on).toBe("2026-03-03");

    const cleared = await request(ctx.app)
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(authHeader(adminToken))
      .send({ start_on: null });
    expect(cleared.status).toBe(200);
    expect(unwrap(cleared.body).start_on).toBeNull();
    expect(unwrap(cleared.body).employment_duration).toBeNull();

    const futureUser = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(adminToken))
      .send({ username: "start-future", password: "pass1234", role: "cashier", start_on: "2099-01-01" });
    expect(futureUser.status).toBe(400);

    const employee = unwrap(
      (
        await request(ctx.app)
          .post("/api/v1/employees")
          .set(authHeader(adminToken))
          .send({ name: "موظف بتاريخ", start_on: "2026-01-02" })
      ).body
    );
    const employeeUpdate = await request(ctx.app)
      .patch(`/api/v1/employees/${employee.id}`)
      .set(authHeader(adminToken))
      .send({ start_on: "2026-02-02" });
    expect(employeeUpdate.status).toBe(200);
    expect(unwrap(employeeUpdate.body).start_on).toBe("2026-02-02");
    const employeeClear = await request(ctx.app)
      .patch(`/api/v1/employees/${employee.id}`)
      .set(authHeader(adminToken))
      .send({ start_on: "" });
    expect(employeeClear.status).toBe(200);
    expect(unwrap(employeeClear.body).start_on).toBeNull();
    const employeeFuture = await request(ctx.app)
      .patch(`/api/v1/employees/${employee.id}`)
      .set(authHeader(adminToken))
      .send({ start_on: "2099-05-01" });
    expect(employeeFuture.status).toBe(400);
  });

  test("existing users with a null start date stay valid", async () => {
    const listed = await request(ctx.app).get("/api/v1/admin/users").set(authHeader(adminToken));
    expect(listed.status).toBe(200);
    const admin = unwrap(listed.body).find((row) => row.username === "testadmin");
    expect(admin).toBeTruthy();
    expect(admin.start_on).toBeNull();
    expect(admin.employment_duration).toBeNull();
    const employees = await request(ctx.app).get("/api/v1/employees").set(authHeader(adminToken));
    expect(employees.status).toBe(200);
  });
});
