import crypto from "crypto";
import jwt from "jsonwebtoken";
import { isAdmin, canRunCheckout } from "../utils/roles.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { CACHE_KEYS, cacheInvalidate, cacheInvalidatePrefix } from "../utils/cache.js";
import { assertTokenSession } from "../utils/sessions.js";

const DEFAULT_SECRET = "change-me-in-production";
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

function isLoopbackHost(host) {
  const h = String(host || "127.0.0.1").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

const usingDefaultJwt =
  !process.env.JWT_SECRET || JWT_SECRET === DEFAULT_SECRET;
if (process.env.NODE_ENV === "production" && usingDefaultJwt) {
  throw new Error(
    "JWT_SECRET must be set to a strong random value in production (environment variable)."
  );
}
if (usingDefaultJwt && !isLoopbackHost(process.env.HOST)) {
  throw new Error(
    "JWT_SECRET must be set to a strong random value when HOST is not loopback."
  );
}

export const JWT_OPTIONS = {
  expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  issuer: "abo-shalbak",
  audience: "abo-shalbak-api",
};

export function invalidateUserCache(userId) {
  if (userId == null) cacheInvalidatePrefix("user:");
  else cacheInvalidate(CACHE_KEYS.user(userId));
}

export function signAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      sv: Number(user.session_version) || 0,
      jti: crypto.randomUUID(),
    },
    JWT_SECRET,
    JWT_OPTIONS
  );
}

function sendAuthError(res, err) {
  const status = err?.status || 401;
  return res.status(status).json({
    success: false,
    error: err?.message || "غير مصرّح",
    code: err?.code || "UNAUTHORIZED",
  });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: "غير مصرّح", code: "UNAUTHORIZED" });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_OPTIONS.issuer,
      audience: JWT_OPTIONS.audience,
    });
  } catch {
    return res.status(401).json({ success: false, error: "رمز غير صالح", code: "INVALID_TOKEN" });
  }
  const db = req.app?.get?.("db");
  if (!db) return next(new Error("Auth database is not available"));
  assertTokenSession(db, payload)
    .then((row) => {
      req.user = {
        id: row.id ?? payload.id,
        username: row.username,
        role: row.role,
        permissions_json: row.permissions_json,
        must_change_password: row.must_change_password,
        session_version: Number(row.session_version) || 0,
      };
      req.auth = {
        jti: payload.jti,
        exp: payload.exp,
        sv: payload.sv,
        userId: req.user.id,
      };
      next();
    })
    .catch((err) => {
      if (err?.status) return sendAuthError(res, err);
      next(err);
    });
}

/**
 * Re-read must_change_password from the DB (JWT has no flag).
 * Allow /auth/me, /auth/change-password, /auth/logout via router mount order.
 */
export function enforceMustChangePassword(db) {
  return async (req, res, next) => {
    if (!req.user?.id) return next();
    try {
      const row = await db.get("SELECT must_change_password FROM users WHERE id = ?", [req.user.id]);
      if (!row || !Number(row.must_change_password)) return next();
      return res.status(403).json({
        success: false,
        error: "يجب تغيير كلمة المرور قبل المتابعة",
        code: "PASSWORD_CHANGE_REQUIRED",
      });
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

const FORBIDDEN_PAYLOAD = {
  success: false,
  error: "صلاحيات غير كافية",
  code: "FORBIDDEN",
};

function isOfficeRole(role) {
  return role === "admin" || role === "accountant";
}

/**
 * Admin always passes; accountant must have the given permission key.
 * @param {object} db
 * @param {string} permissionKey
 */
export function requireReportsPermission(db, permissionKey) {
  return async (req, res, next) => {
    const role = req.user?.role;
    if (!role || !isOfficeRole(role)) {
      return res.status(403).json(FORBIDDEN_PAYLOAD);
    }
    try {
      if (await userHasAccountantPermission(db, req.user, permissionKey)) {
        return next();
      }
      return res.status(403).json(FORBIDDEN_PAYLOAD);
    } catch (err) {
      if (err?.code === "PERMISSIONS_CORRUPT") return sendAuthError(res, err);
      next(err);
    }
  };
}

/**
 * Admin always passes; accountant must have at least one of the permission keys.
 * @param {object} db
 * @param {...string} permissionKeys
 */
export function requireAnyReportsPermission(db, ...permissionKeys) {
  return async (req, res, next) => {
    const role = req.user?.role;
    if (!role || !isOfficeRole(role)) {
      return res.status(403).json(FORBIDDEN_PAYLOAD);
    }
    try {
      for (const key of permissionKeys) {
        if (await userHasAccountantPermission(db, req.user, key)) {
          return next();
        }
      }
      return res.status(403).json(FORBIDDEN_PAYLOAD);
    } catch (err) {
      if (err?.code === "PERMISSIONS_CORRUPT") return sendAuthError(res, err);
      next(err);
    }
  };
}

/** Require admin or accountant (any office reports role) without a specific permission. */
export function requireOfficeRole() {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !isOfficeRole(role)) {
      return res.status(403).json(FORBIDDEN_PAYLOAD);
    }
    next();
  };
}
