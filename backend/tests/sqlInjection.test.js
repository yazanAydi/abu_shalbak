import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

describe("SQL injection regression", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = loginRes.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("malicious username in login does not crash server", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/auth/login")
      .send({ username: "'; DROP TABLE users; --", password: "x", app: "office" });
    expect([400, 401]).toContain(res.status);
    const users = await ctx.db.get("SELECT COUNT(*) AS c FROM users");
    expect(users.c).toBeGreaterThan(0);
  });

  test("malicious barcode lookup is handled safely", async () => {
    const payload = encodeURIComponent("'; DROP TABLE products; --");
    const res = await request(ctx.app)
      .get(`/api/v1/products/${payload}`)
      .set(authHeader(adminToken));
    expect([404, 200]).toContain(res.status);
    const products = await ctx.db.get("SELECT COUNT(*) AS c FROM products");
    expect(products.c).toBeGreaterThan(0);
  });

  test("audit logs filter with injection attempt", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/admin/audit-logs")
      .query({ action: "' OR 1=1 --" })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });
});
