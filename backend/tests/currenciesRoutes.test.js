import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("currency listing routes", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("POS GET /api/currencies returns enabled currencies", async () => {
    const res = await request(ctx.app).get("/api/currencies").set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const payload = unwrap(res.body);
    expect(Array.isArray(payload.currencies)).toBe(true);
    expect(payload.currencies.length).toBeGreaterThan(0);
    expect(payload.currencies.every((c) => c.enabled)).toBe(true);
    expect(payload.currencies.map((c) => c.code)).toEqual(expect.arrayContaining(["NIS", "USD"]));
  });

  test("admin GET /api/v1/currencies returns enabled currencies (office path)", async () => {
    const res = await request(ctx.app).get("/api/v1/currencies").set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const payload = unwrap(res.body);
    expect(Array.isArray(payload.currencies)).toBe(true);
    expect(payload.currencies.every((c) => c.enabled)).toBe(true);
  });

  test("admin GET /api/currencies/all and /api/v1/currencies/all include disabled", async () => {
    const usd = await ctx.db.get("SELECT id FROM currencies WHERE code = 'USD'");
    const disable = await request(ctx.app)
      .patch(`/api/v1/currencies/${usd.id}`)
      .set(authHeader(adminToken))
      .send({ enabled: false });
    expect(disable.status).toBe(200);

    const legacy = await request(ctx.app)
      .get("/api/currencies/all")
      .set(authHeader(adminToken));
    expect(legacy.status).toBe(200);
    const allLegacy = unwrap(legacy.body).currencies;
    expect(allLegacy.some((c) => c.code === "USD" && !c.enabled)).toBe(true);

    const v1 = await request(ctx.app)
      .get("/api/v1/currencies/all")
      .set(authHeader(adminToken));
    expect(v1.status).toBe(200);
    const allV1 = unwrap(v1.body).currencies;
    expect(allV1.some((c) => c.code === "USD" && !c.enabled)).toBe(true);

    const posEnabled = await request(ctx.app)
      .get("/api/currencies")
      .set(authHeader(cashierToken));
    expect(posEnabled.status).toBe(200);
    expect(unwrap(posEnabled.body).currencies.some((c) => c.code === "USD")).toBe(false);

    const restore = await request(ctx.app)
      .patch(`/api/v1/currencies/${usd.id}`)
      .set(authHeader(adminToken))
      .send({ enabled: true });
    expect(restore.status).toBe(200);
  });

  test("cashier cannot load admin GET /all", async () => {
    const res = await request(ctx.app)
      .get("/api/currencies/all")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(403);
  });

  test("ETag 304 uses the request headers on both list endpoints", async () => {
    const first = await request(ctx.app).get("/api/currencies").set(authHeader(cashierToken));
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();

    const again = await request(ctx.app)
      .get("/api/currencies")
      .set(authHeader(cashierToken))
      .set("If-None-Match", first.headers.etag);
    expect(again.status).toBe(304);

    const adminFirst = await request(ctx.app)
      .get("/api/v1/currencies/all")
      .set(authHeader(adminToken));
    expect(adminFirst.status).toBe(200);
    const adminAgain = await request(ctx.app)
      .get("/api/v1/currencies/all")
      .set(authHeader(adminToken))
      .set("If-None-Match", adminFirst.headers.etag);
    expect(adminAgain.status).toBe(304);
  });
});
