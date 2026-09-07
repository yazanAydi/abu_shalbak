import { Router } from "express";
import { requireAuth, requireAdmin, requireReportsPermission } from "../middleware/auth.js";
import {
  buildEmployeeAttendanceReport,
  createManualPunch,
  deleteFaceDescriptors,
  deletePunch,
  listAttendanceEmployees,
  listKioskDescriptors,
  recordPunch,
  saveFaceDescriptors,
  updatePunch,
} from "../services/attendanceService.js";
import { HttpError } from "../utils/httpError.js";
import { signKioskToken, timingSafeStringEqual, verifyKioskToken } from "../utils/kioskToken.js";

function getKioskApiKey() {
  return process.env.KIOSK_API_KEY && String(process.env.KIOSK_API_KEY).trim();
}

function extractBearer(req) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireKioskKey(req, res, next) {
  const token = req.headers["x-kiosk-token"] || extractBearer(req);
  if (token) {
    try {
      const payload = verifyKioskToken(token);
      if (payload?.typ === "kiosk") {
        req.kiosk = payload;
        return next();
      }
    } catch {
      /* fall through to shared-key fallback */
    }
  }

  const expected = getKioskApiKey();
  const provided = req.headers["x-kiosk-key"];
  if (expected && provided && timingSafeStringEqual(provided, expected)) {
    return next();
  }
  if (!expected && !token) {
    return res.status(503).json({
      success: false,
      error: "الكشك غير مُعدّ — سجّل هذا الجهاز من حساب المدير",
      code: "KIOSK_NOT_CONFIGURED",
    });
  }
  return res.status(401).json({
    success: false,
    error: "مفتاح الكشك غير صالح",
    code: "INVALID_KIOSK_KEY",
  });
}

export function createAttendanceRouter(db) {
  const router = Router();
  const requirePayroll = requireReportsPermission(db, "employee_payroll");

  router.post("/kiosk/session", requireAuth, requireAdmin, async (req, res) => {
    const token = signKioskToken({ enrolledBy: req.user.id });
    res.status(201).json({ token, expires_in: process.env.KIOSK_TOKEN_EXPIRES_IN || "365d" });
  });

  router.get("/kiosk/descriptors", requireKioskKey, async (_req, res, next) => {
    try {
      const rows = await listKioskDescriptors(db);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post("/kiosk/punch", requireKioskKey, async (req, res, next) => {
    try {
      const userId = (req.body || {}).user_id;
      const result = await recordPunch(db, userId);
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  router.get("/employees", requireAuth, requirePayroll, async (_req, res, next) => {
    try {
      const rows = await listAttendanceEmployees(db);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post("/enroll", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const { user_id, descriptors } = req.body || {};
      if (!user_id) {
        throw new HttpError(400, "معرّف الموظف مطلوب");
      }
      const result = await saveFaceDescriptors(db, user_id, descriptors);
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/enroll/:userId", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const result = await deleteFaceDescriptors(db, req.params.userId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.get("/report", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const report = await buildEmployeeAttendanceReport(db, {
        dateFrom: req.query.date_from,
        dateTo: req.query.date_to,
        userId: req.query.user_id,
      });
      res.json(report);
    } catch (e) {
      next(e);
    }
  });

  router.post("/manual-punch", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const { user_id, punch_time, type } = req.body || {};
      if (!user_id) {
        throw new HttpError(400, "معرّف الموظف مطلوب");
      }
      if (!type) {
        throw new HttpError(400, "نوع التسجيل مطلوب");
      }
      const result = await createManualPunch(db, {
        userId: user_id,
        punchTime: punch_time,
        type,
      });
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  router.patch("/punch/:id", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const { punch_time, type } = req.body || {};
      const result = await updatePunch(db, req.params.id, { punchTime: punch_time, type });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/punch/:id", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const result = await deletePunch(db, req.params.id);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
