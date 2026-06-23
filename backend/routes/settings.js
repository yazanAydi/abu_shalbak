import { Router } from "express";

import { requireAuth, requireAdmin } from "../middleware/auth.js";

import { getAppSettings, updateAppSettings } from "../utils/settings.js";

import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";



export function createSettingsRouter(db) {

  const router = Router();



  router.get("/", requireAuth, async (_req, res) => {

    const settings = await getAppSettings(db);

    res.json(settings);

  });



  router.patch("/", requireAuth, requireAdmin, async (req, res, next) => {

    try {

      const before = await getAppSettings(db);

      const settings = await updateAppSettings(db, req.body || {});

      await logAudit(db, req, AUDIT_ACTIONS.SETTINGS_UPDATE, "app_settings", null, before, settings);

      res.json(settings);

    } catch (e) {

      if (e.message && !e.status) {

        return res.status(400).json({ error: e.message, code: "VALIDATION_ERROR" });

      }

      next(e);

    }

  });



  return router;

}

