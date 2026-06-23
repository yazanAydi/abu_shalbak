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
  });

  test("transaction mutation endpoint returns 405", async () => {
    const res = await request(ctx.app)
      .delete("/api/v1/transactions/1")
      .set(authHeader(adminToken));
    expect(res.status).toBe(405);
    expect(res.body.code).toBe("IMMUTABLE_TRANSACTION");
  });
});
