import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApiLimiter, loginLimiter } from "../middleware/rateLimit.js";
import { JWT_OPTIONS, JWT_SECRET, signAccessToken } from "../middleware/auth.js";

const originalNodeEnv = process.env.NODE_ENV;

function tokenFor(id, role = "admin") {
  return signAccessToken({ id, username: `limiter-test-${id}`, role, session_version: 0 });
}

function createLimiterApp({ loginProtection = false } = {}) {
  const app = express();
  app.use("/api", createApiLimiter());
  if (loginProtection) app.post("/api/auth/login", loginLimiter);
  // Test the production limiter through HTTP without opening a database or
  // executing stock/auth actions. Protected routes still use requireAuth in app.js.
  app.use("/api", (_req, res) => res.json({ ok: true }));
  return app;
}

async function consumeBudget(app, makeRequest) {
  for (let i = 0; i < 300; i += 1) {
    const response = await makeRequest(request(app), i);
    expect(response.status).toBe(200);
    expect(Number(response.headers["ratelimit-limit"])).toBe(300);
  }
}

describe("API rate-limit isolation", () => {
  beforeEach(() => {
    // Exercise the real store quota and do not skip loopback as development does.
    process.env.NODE_ENV = "production";
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("an office account exhausting 300 requests does not block a cashier on the same IP", async () => {
    const app = createLimiterApp();
    const office = tokenFor(101);
    const cashier = tokenFor(102, "cashier");
    await consumeBudget(app, (client) => client
      .post("/api/v1/inventory/counts/14/lines")
      .set("Authorization", `Bearer ${office}`));

    const blocked = await request(app).get("/api/inventory/counts")
      .set("Authorization", `Bearer ${office}`);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMIT");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const checkout = await request(app).post("/api/v1/checkout")
      .set("Authorization", `Bearer ${cashier}`);
    expect(checkout.status).toBe(200);
    expect(Number(checkout.headers["ratelimit-remaining"])).toBe(299);
  });

  test("token rotation, role claims and legacy/v1 paths share one user's quota", async () => {
    const app = createLimiterApp();
    const tokens = [tokenFor(201), tokenFor(201), tokenFor("201", "cashier")];
    await consumeBudget(app, (client, i) => client
      .get(i % 2 ? "/api/products" : "/api/v1/products")
      .set("Authorization", `Bearer ${tokens[i % tokens.length]}`));
    for (const path of ["/api/products", "/api/v1/products"]) {
      const response = await request(app).get(path)
        .set("Authorization", `Bearer ${tokenFor(201)}`);
      expect(response.status).toBe(429);
    }
  });

  test("missing, forged, expired and wrong-audience tokens cannot split the IP budget", async () => {
    const app = createLimiterApp();
    const variants = [
      null,
      "not-a-token",
      jwt.sign({ id: 301 }, "limiter-test-wrong-signing-key", JWT_OPTIONS),
      jwt.sign({ id: 302 }, JWT_SECRET, { ...JWT_OPTIONS, expiresIn: -1 }),
      jwt.sign({ id: 303 }, JWT_SECRET, { ...JWT_OPTIONS, audience: "wrong-audience" }),
      jwt.sign({ id: 304 }, JWT_SECRET, { ...JWT_OPTIONS, issuer: "wrong-issuer" }),
      jwt.sign({ id: 305 }, null, { ...JWT_OPTIONS, algorithm: "none" }),
      jwt.sign({ id: "invalid-id" }, JWT_SECRET, JWT_OPTIONS),
      jwt.sign({ id: 0 }, JWT_SECRET, JWT_OPTIONS),
    ];
    await consumeBudget(app, (client, i) => {
      const call = client.get("/api/v1/products")
        .set("X-User-Id", String(i + 1))
        .set("X-Forwarded-For", `192.0.2.${i % 250 + 1}`);
      const token = variants[i % variants.length];
      return token ? call.set("Authorization", `Bearer ${token}`) : call;
    });
    for (const token of variants) {
      let call = request(app).get("/api/products");
      if (token) call = call.set("Authorization", `Bearer ${token}`);
      expect((await call).status).toBe(429);
    }
    // A real signed user remains isolated from anonymous traffic on that IP.
    expect((await request(app).get("/api/products")
      .set("Authorization", `Bearer ${tokenFor(306)}`)).status).toBe(200);
  });

  test("public routes remain IP-limited even when a caller rotates valid Bearer tokens", async () => {
    const app = createLimiterApp();
    const paths = [
      "/api/auth/login",
      "/api/v1/AUTH/LOGIN/",
      "/api/v1/health/",
      "/api/telegram/webhook/test-secret",
      "/api/v1/telegram/webhook/approvals/test-secret/",
      "/api/attendance/kiosk/descriptors",
      "/api/v1/attendance/kiosk/punch/",
    ];
    const tokens = [tokenFor(401), tokenFor(402)];
    await consumeBudget(app, (client, i) => client.post(paths[i % paths.length])
      .set("Authorization", `Bearer ${tokens[i % tokens.length]}`));
    for (const path of paths) {
      const response = await request(app).post(path)
        .set("Authorization", `Bearer ${tokenFor(403)}`);
      expect(response.status).toBe(429);
    }
    // Protected auth and administrative endpoints still use the user budget.
    for (const path of ["/api/v1/auth/me", "/api/attendance/kiosk/session", "/api/telegram/outbound/retry"]) {
      expect((await request(app).get(path)
        .set("Authorization", `Bearer ${tokens[0]}`)).status).toBe(200);
    }
  });

  test("the stricter 10-attempt login limiter remains shared by IP", async () => {
    const app = createLimiterApp({ loginProtection: true });
    for (let i = 0; i < 10; i += 1) {
      const response = await request(app).post("/api/auth/login")
        .set("Authorization", `Bearer ${tokenFor(500 + i)}`);
      expect(response.status).toBe(200);
      expect(Number(response.headers["ratelimit-limit"])).toBe(10);
    }
    const response = await request(app).post("/api/auth/login")
      .set("Authorization", `Bearer ${tokenFor(600)}`);
    expect(response.status).toBe(429);
    expect(response.body.error).toBe("محاولات دخول كثيرة — حاول لاحقاً");
  });
});
