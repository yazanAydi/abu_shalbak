import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { JWT_OPTIONS, JWT_SECRET } from "./auth.js";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "محاولات دخول كثيرة — حاول لاحقاً", code: "RATE_LIMIT" },
  skip: () => process.env.NODE_ENV === "test",
});

function isPublicApiPath(req) {
  // This middleware is mounted at /api, before both the v1 and legacy routers.
  const apiPath = req.path.replace(/^\/v1(?=\/|$)/i, "").replace(/\/+$/, "").toLowerCase();
  return apiPath === "/health"
    || apiPath === "/auth/login"
    || apiPath.startsWith("/telegram/webhook/")
    || apiPath === "/attendance/kiosk/descriptors"
    || apiPath === "/attendance/kiosk/punch";
}

function apiLimitKey(req) {
  if (!isPublicApiPath(req)) {
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET, {
          issuer: JWT_OPTIONS.issuer,
          audience: JWT_OPTIONS.audience,
        });
        const userId = Number(payload?.id);
        if (Number.isSafeInteger(userId) && userId > 0) return `user:${userId}`;
      } catch {
        // Unverified, expired and malformed tokens all share the IP budget.
      }
    }
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

export function createApiLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === "development" ? 3000 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "طلبات كثيرة — حاول لاحقاً", code: "RATE_LIMIT" },
    // Office and POS accounts may share a LAN/proxy IP. A signed, stable user
    // ID keeps their budgets separate without granting new budgets on refresh.
    // This is only a limiter key: requireAuth still checks account/session state.
    keyGenerator: apiLimitKey,
    skip: (req) =>
      process.env.NODE_ENV === "development" &&
      (req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"),
  });
}

export const apiLimiter = createApiLimiter();
