import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_OPTIONS, requireAuth } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, changePasswordSchema } from "../middleware/schemas.js";
import {
  canLoginOffice,
  canLoginPos,
  wrongPortalLoginMessage,
} from "../utils/roles.js";
import { getAppSettings } from "../utils/settings.js";
import { getEffectivePermissions } from "../utils/accountantPermissions.js";

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function createAuthRouter(db) {
  const router = Router();

  router.post("/login", loginLimiter, validate(loginSchema), async (req, res, next) => {
    const { username, password, app } = req.body;
    try {
      const row = await db.get("SELECT * FROM users WHERE username = ?", [username]);
      if (!row || !(await bcrypt.compare(password, row.password))) {
        console.warn(
          `[auth-fail] ip=${clientIp(req)} username=${username} ua=${req.headers["user-agent"] || ""}`
        );
        return res.status(401).json({
          success: false,
          error: "بيانات الدخول غير صحيحة",
          code: "INVALID_CREDENTIALS",
        });
      }
      const role = row.role;
      const allowed =
        app === "office" ? canLoginOffice(role) : app === "pos" ? canLoginPos(role) : false;
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: wrongPortalLoginMessage(role, app),
          code: "WRONG_LOGIN_PORTAL",
        });
      }
      const token = jwt.sign(
        { id: row.id, username: row.username, role: row.role },
        JWT_SECRET,
        JWT_OPTIONS
      );
      res.json({
        token,
        user: {
          id: row.id,
          username: row.username,
          role: row.role,
          must_change_password: !!row.must_change_password,
          permissions: await (async () => {
            const settings = await getAppSettings(db);
            return getEffectivePermissions(row.role, settings.accountant_permissions);
          })(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/change-password", requireAuth, validate(changePasswordSchema), async (req, res, next) => {
    try {
      const row = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);
      if (!row) {
        return res.status(404).json({ success: false, error: "المستخدم غير موجود", code: "NOT_FOUND" });
      }
      const { current_password, new_password } = req.body;
      if (!(await bcrypt.compare(current_password, row.password))) {
        return res.status(401).json({
          success: false,
          error: "كلمة المرور الحالية غير صحيحة",
          code: "INVALID_CREDENTIALS",
        });
      }
      const hash = await bcrypt.hash(new_password, 10);
      await db.run(
        "UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?",
        [hash, req.user.id]
      );
      res.json({ success: true, message: "تم تغيير كلمة المرور" });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", (_req, res) => {
    res.json({ message: "تم تسجيل الخروج" });
  });

  router.get("/me", requireAuth, async (req, res, next) => {
    try {
      const row = await db.get(
        "SELECT id, username, role, must_change_password FROM users WHERE id = ?",
        [req.user.id]
      );
      if (!row) {
        return res.status(404).json({ success: false, error: "المستخدم غير موجود", code: "NOT_FOUND" });
      }
      res.json({
        user: {
          id: row.id,
          username: row.username,
          role: row.role,
          must_change_password: !!row.must_change_password,
          permissions: await (async () => {
            const settings = await getAppSettings(db);
            return getEffectivePermissions(row.role, settings.accountant_permissions);
          })(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
