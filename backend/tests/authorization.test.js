import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Authorization", () => {
  let ctx;
  let cashierToken;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("cashier cannot access admin users list", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/admin/users")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(403);
  });

  test("admin can access admin users list", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/admin/users")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
  });

  test("cashier cannot access finance reports", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/finance/overview")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  test("cashier token is rejected by office-only APIs when submitted directly", async () => {
    const officeOnly = [
      "/api/v1/admin/users",
      "/api/v1/reports/today",
      "/api/v1/finance/overview",
      "/api/v1/purchases/invoices",
      "/api/v1/office/nav-badges",
    ];
    for (const path of officeOnly) {
      const res = await request(ctx.app).get(path).set(authHeader(cashierToken));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }

    const patch = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(cashierToken))
      .send({ store_name: "should-not-apply" });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe("FORBIDDEN");
  });

  test("the same cashier token is still a valid POS session", async () => {
    const me = await request(ctx.app).get("/api/v1/auth/me").set(authHeader(cashierToken));
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe("cashier");
    expect(me.body.data.user.username).toBe("testcashier");

    const shift = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(cashierToken));
    expect(shift.status).toBe(200);
  });

  test("admin token can call the same office-only APIs", async () => {
    const officeOnly = [
      "/api/v1/admin/users",
      "/api/v1/reports/today",
      "/api/v1/purchases/invoices",
      "/api/v1/office/nav-badges",
    ];
    for (const path of officeOnly) {
      const res = await request(ctx.app).get(path).set(authHeader(adminToken));
      expect(res.status).toBe(200);
    }
  });

  test("transaction mutation endpoint returns 405", async () => {
    const res = await request(ctx.app)
      .delete("/api/v1/transactions/1")
      .set(authHeader(adminToken));
    expect(res.status).toBe(405);
    expect(res.body.code).toBe("IMMUTABLE_TRANSACTION");
  });
});
