import { Router } from "express";

import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { canViewReports } from "../utils/roles.js";
import { getAppSettings, updateAppSettings, SETTING_KEYS } from "../utils/settings.js";
import { sendCachedJson } from "../utils/httpCache.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

export function createSettingsRouter(db) {
  const router = Router();
  const requireStoreSettings = requireReportsPermission(db, "store_settings");

  router.get("/", requireAuth, async (req, res) => {
    const settings = await getAppSettings(db);
    if (!canViewReports(req.user?.role)) {
      const { accountant_permissions: _perms, ...posSettings } = settings;
      return sendCachedJson(req, res, posSettings, { maxAgeSec: 30 });
    }
    return sendCachedJson(req, res, settings, { maxAgeSec: 30 });
  });

  router.patch("/", requireAuth, requireStoreSettings, async (req, res, next) => {
    try {
      const body = { ...(req.body || {}) };
      delete body[SETTING_KEYS.accountant_permissions];

      const before = await getAppSettings(db);
      const settings = await updateAppSettings(db, body);
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
