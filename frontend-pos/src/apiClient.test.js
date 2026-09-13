import { getPosApiBaseURL, resolveApiUrl } from "./apiClient";

describe("getPosApiBaseURL", () => {
  test("store/production uses same-origin (no baked host)", () => {
    expect(getPosApiBaseURL({ NODE_ENV: "production" })).toBe("");
    expect(getPosApiBaseURL({ NODE_ENV: "production", REACT_APP_API_BASE: "" })).toBe("");
    expect(getPosApiBaseURL({ NODE_ENV: "production", REACT_APP_API_BASE: "   " })).toBe("");
    expect(
      getPosApiBaseURL({
        NODE_ENV: "production",
        REACT_APP_API_BASE: "http://127.0.0.1:5001",
      })
    ).toBe("");
  });

  test("development without REACT_APP_API_BASE stays same-origin", () => {
    expect(getPosApiBaseURL({ NODE_ENV: "development" })).toBe("");
  });

  test("explicit REACT_APP_API_BASE wins (dev npm start)", () => {
    expect(
      getPosApiBaseURL({
        NODE_ENV: "development",
        REACT_APP_API_BASE: "http://127.0.0.1:5001/",
      })
    ).toBe("http://127.0.0.1:5001");
  });
});

describe("resolveApiUrl", () => {
  test("rewrites /api to /api/v1 without inventing a host", () => {
    const url = resolveApiUrl("/api/print-receipt");
    expect(url).toContain("/api/v1/print-receipt");
    expect(url).not.toMatch(/silent/);
    expect(url).not.toMatch(/17891/);
  });
});
