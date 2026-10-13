/** How long before access-token expiry the POS asks for a new token. */
export const RENEW_BEFORE_MS = 30 * 60 * 1000;

export function decodeAccessTokenPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const json = JSON.parse(atob(padded));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

export function accessTokenExpiryMs(token) {
  const exp = Number(decodeAccessTokenPayload(token)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

export function isAccessTokenExpired(token, now = Date.now()) {
  const exp = accessTokenExpiryMs(token);
  if (exp == null) return false;
  return exp <= now;
}

/** Renew only while the current token is still accepted. An expired token needs a new login. */
export function shouldRenewAccessToken(token, now = Date.now()) {
  const exp = accessTokenExpiryMs(token);
  if (exp == null || exp <= now) return false;
  return exp - now <= RENEW_BEFORE_MS;
}
