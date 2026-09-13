import request from "supertest";
import {
  isOriginAllowed,
  isSameOriginAsRequest,
  parseAllowedOrigins,
} from "../utils/corsOrigins.js";
import { createTestContext, destroyTestContext } from "./helpers.js";

function req({ host, proto = "http", secure = false } = {}) {
  return {
    secure,
    headers: {
      host,
      "x-forwarded-proto": proto === "https" && !secure ? "https" : undefined,
    },
    get(name) {
      if (String(name).toLowerCase() === "host") return host;
      return undefined;
    },
  };
}

describe("corsOrigins", () => {
  test("production with no ALLOWED_ORIGINS is an empty extra-host list", () => {
    expect(parseAllowedOrigins({ NODE_ENV: "production" })).toEqual([]);
  });

  test("LAN POS http://SERVER_IP:3000 is same-origin", () => {
    const origin = "http://192.168.1.40:3000";
    const request = req({ host: "192.168.1.40:3000" });
    expect(isSameOriginAsRequest(origin, request)).toBe(true);
    expect(isOriginAllowed(origin, [], request, { NODE_ENV: "production" })).toBe(true);
  });

  test("localhost store POS is same-origin", () => {
    const origin = "http://localhost:3000";
    const request = req({ host: "localhost:3000" });
    expect(isOriginAllowed(origin, [], request, { NODE_ENV: "production" })).toBe(true);
  });

  test("Tailscale origin is allowed when listed, even if Host is internal", () => {
    const origin = "https://shop-pc.tailXXXX.ts.net";
    const request = req({ host: "0.0.0.0:3000" });
    expect(
      isOriginAllowed(origin, [origin], request, { NODE_ENV: "production" })
    ).toBe(true);
  });

  test("foreign website is denied in production", () => {
    const request = req({ host: "192.168.1.40:3000" });
    expect(
      isOriginAllowed("https://evil.example", [], request, { NODE_ENV: "production" })
    ).toBe(false);
  });

  test("missing Origin is allowed (non-browser / same-origin clients)", () => {
    expect(isOriginAllowed("", [], req({ host: "192.168.1.40:3000" }))).toBe(true);
    expect(isOriginAllowed(null, [])).toBe(true);
  });

  test("HTTP API reflects LAN Origin so /pos on SERVER_IP:3000 can call /api", async () => {
    const ctx = await createTestContext();
    try {
      const res = await request(ctx.app)
        .get("/api/v1/health")
        .set("Host", "192.168.1.40:3000")
        .set("Origin", "http://192.168.1.40:3000");
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://192.168.1.40:3000");
    } finally {
      await destroyTestContext(ctx);
    }
  });
});
