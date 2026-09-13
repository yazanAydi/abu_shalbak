/**
 * Browser CORS allow-list plus same-origin LAN access.
 *
 * Store cashiers open http://SERVER_IP:3000/pos (or localhost:3000/pos).
 * Those requests are same-origin and must work without hardcoding the LAN IP.
 * ALLOWED_ORIGINS is only for extra hosts (Tailscale HTTPS, etc.).
 */

export function parseAllowedOrigins(env = process.env) {
  const raw = env.ALLOWED_ORIGINS;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  if (env.NODE_ENV === "production") return [];
  return [
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "http://localhost:3001",
    "http://localhost:3002",
  ];
}

/** Dev phone access via Tailscale Serve uses https://machine.tailXXXX.ts.net */
export function isDevTailscaleOrigin(origin, env = process.env) {
  if (env.NODE_ENV !== "development" || !origin) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "https:" && hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}

function requestProtocol(req) {
  const forwarded = String(req.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  if (forwarded) return forwarded;
  return req.secure ? "https" : "http";
}

function requestHost(req) {
  if (typeof req.get === "function") {
    const host = req.get("host");
    if (host) return host;
  }
  return req.headers?.host || "";
}

/** True when Origin is this same server (LAN IP, localhost, or hostname:3000). */
export function isSameOriginAsRequest(origin, req) {
  if (!origin || !req) return false;
  try {
    const parsed = new URL(origin);
    const host = requestHost(req);
    if (!host) return false;
    return parsed.host === host && parsed.protocol === `${requestProtocol(req)}:`;
  } catch {
    return false;
  }
}

export function isOriginAllowed(origin, allowedOrigins, req = null, env = process.env) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (isSameOriginAsRequest(origin, req)) return true;
  return isDevTailscaleOrigin(origin, env);
}
