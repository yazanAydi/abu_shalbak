import {
  accessTokenExpiryMs,
  isAccessTokenExpired,
  shouldRenewAccessToken,
} from "./sessionRefresh";

function tokenExpiringAt(expSeconds) {
  const payload = btoa(JSON.stringify({ exp: expSeconds, role: "cashier" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `e30.${payload}.sig`;
}

describe("POS access-token renewal", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  test("renews during the last 30 minutes and not after expiry", () => {
    const soon = tokenExpiringAt((now + 10 * 60 * 1000) / 1000);
    const later = tokenExpiringAt((now + 2 * 60 * 60 * 1000) / 1000);
    const expired = tokenExpiringAt((now - 1000) / 1000);
    expect(shouldRenewAccessToken(soon, now)).toBe(true);
    expect(shouldRenewAccessToken(later, now)).toBe(false);
    expect(shouldRenewAccessToken(expired, now)).toBe(false);
    expect(isAccessTokenExpired(expired, now)).toBe(true);
    expect(isAccessTokenExpired(soon, now)).toBe(false);
    expect(accessTokenExpiryMs(soon)).toBe(now + 10 * 60 * 1000);
  });
});
