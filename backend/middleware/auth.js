import jwt from "jsonwebtoken";
import { isAdmin, canRunCheckout } from "../utils/roles.js";

const DEFAULT_SECRET = "change-me-in-production";
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.JWT_SECRET || JWT_SECRET === DEFAULT_SECRET)
) {
  throw new Error(
    "JWT_SECRET must be set to a strong random value in production (environment variable)."
  );
}

export const JWT_OPTIONS = {
  expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  issuer: "abo-shalbak",
  audience: "abo-shalbak-api",
};

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: "غير مصرّح", code: "UNAUTHORIZED" });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_OPTIONS.issuer,
      audience: JWT_OPTIONS.audience,
    });
    next();
  } catch {
    return res.status(401).json({ success: false, error: "رمز غير صالح", code: "INVALID_TOKEN" });
  }
}

/** Block access until default password is changed (checked after DB lookup in route). */
export function requirePasswordChanged(db) {
  return async (req, res, next) => {
    if (!req.user?.id) return next();
    try {
      const row = await db.get(
        "SELECT must_change_password FROM users WHERE id = ?",
        [req.user.id]
      );
      if (row?.must_change_password) {
        const path = req.path || "";
        const allowed =
          path.endsWith("/change-password") ||
          path.endsWith("/me") ||
          path.endsWith("/logout");
        if (!allowed) {
          return res.status(403).json({
            success: false,
            error: "يجب تغيير كلمة المرور قبل المتابعة",
            code: "PASSWORD_CHANGE_REQUIRED",
          });
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) {
    return res.status(403).json({ success: false, error: "للمسؤول فقط", code: "FORBIDDEN" });
  }
  next();
}

/** @param  {...string} allowedRoles */
export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    const r = req.user?.role;
    if (!r || !allowedRoles.includes(r)) {
      return res.status(403).json({ success: false, error: "صلاحيات غير كافية", code: "FORBIDDEN" });
    }
    next();
  };
}

export function requirePosAccess(req, res, next) {
  if (!canRunCheckout(req.user?.role)) {
    return res.status(403).json({
      success: false,
      error: "هذا الحساب غير مسموح له استخدام الكاشير",
      code: "FORBIDDEN",
    });
  }
  next();
}

export { JWT_SECRET };
