import request from "supertest";
import bcrypt from "bcrypt";
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

  test("must_change_password blocks mutations until the password is changed", async () => {
    const hash = await bcrypt.hash("oldpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 1)",
      ["newcashier", hash]
    );

    const loginRes = await login(ctx.app, "newcashier", "oldpass123", "pos");
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.must_change_password).toBe(true);
    const token = loginRes.body.token;

    const me = await request(ctx.app).get("/api/v1/auth/me").set(authHeader(token));
    expect(me.status).toBe(200);
    expect(me.body.data.user.must_change_password).toBe(true);

    const started = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(token))
      .send({});
    expect(started.status).toBe(403);
    expect(started.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await request(ctx.app)
      .post("/api/v1/auth/change-password")
      .set(authHeader(token))
      .send({ current_password: "oldpass123", new_password: "newpass123" });
    expect(changed.status).toBe(200);

    const startedAfter = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(token))
      .send({});
    expect(startedAfter.status).toBe(201);
    expect(startedAfter.body.data?.shift_id ?? startedAfter.body.shift_id).toBeTruthy();
  });

  test("office admin with must_change_password cannot mutate products until change", async () => {
    const hash = await bcrypt.hash("oldadmin1", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'admin', 1)",
      ["newadmin", hash]
    );
    const loginRes = await login(ctx.app, "newadmin", "oldadmin1", "office");
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const blocked = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(token))
      .send({ barcode: "8800990001", name: "محظور", price: 1, stock: 0 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await request(ctx.app)
      .post("/api/v1/auth/change-password")
      .set(authHeader(token))
      .send({ current_password: "oldadmin1", new_password: "newadmin1" });
    expect(changed.status).toBe(200);

    const allowed = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(token))
      .send({ barcode: "8800990001", name: "مسموح", price: 1, stock: 0, unit: "حبة" });
    expect(allowed.status).toBe(201);
  });
});
