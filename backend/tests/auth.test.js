import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("Auth", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("login succeeds with valid credentials", async () => {
    const res = await login(ctx.app, "testadmin", "adminpass123");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe("admin");
  });

  test("login fails with invalid credentials", async () => {
    const res = await login(ctx.app, "testadmin", "wrong");
    expect(res.status).toBe(401);
    expect(res.body.code || res.body.error).toBeTruthy();
  });

  test("cashier cannot login on office portal", async () => {
    const res = await login(ctx.app, "testcashier", "cashpass123", "office");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("WRONG_LOGIN_PORTAL");
  });

  test("admin cannot login on pos portal", async () => {
    const res = await login(ctx.app, "testadmin", "adminpass123", "pos");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("WRONG_LOGIN_PORTAL");
  });

  test("cashier can login on pos portal", async () => {
    const res = await login(ctx.app, "testcashier", "cashpass123", "pos");
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("cashier");
  });

  test("protected route rejects missing token", async () => {
    const res = await request(ctx.app).get("/api/v1/reports/today");
    expect(res.status).toBe(401);
  });

  test("GET /me returns user with valid token", async () => {
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    const res = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set(authHeader(loginRes.body.token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe("testadmin");
  });
});
