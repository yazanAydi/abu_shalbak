import { Router } from "express";

import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { canViewReports } from "../utils/roles.js";
import { getAppSettings, updateAppSettings, SETTING_KEYS } from "../utils/settings.js";
import { sendCachedJson } from "../utils/httpCache.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

export function createSettingsRouter(db) {
  const router = Router();
  const requireStoreSettings = requireReportsPermission(db, "store_settings");

  router.get("/", requireAuth, async (req, res, next) => {
    try {
      const settings = { ...(await getAppSettings(db)) };
      const office = canViewReports(req.user?.role);
      const canPermissions =
        office && (await userHasAccountantPermission(db, req.user, "permissions"));
      const canStoreSettings =
        office && (await userHasAccountantPermission(db, req.user, "store_settings"));
      if (!canPermissions) delete settings.accountant_permissions;
      if (!canStoreSettings) delete settings.refund_telegram_manager_user_id;
      return sendCachedJson(req, res, settings, { maxAgeSec: 30 });
    } catch (err) {
      if (err?.code === "PERMISSIONS_CORRUPT") {
        return res.status(403).json({ success: false, error: err.message, code: err.code });
      }
      next(err);
    }
  });

  router.patch("/", requireAuth, requireStoreSettings, async (req, res, next) => {
    try {
      const body = { ...(req.body || {}) };
      delete body[SETTING_KEYS.accountant_permissions];

      const before = await getAppSettings(db);
      const settings = { ...(await updateAppSettings(db, body)) };
      await logAudit(db, req, AUDIT_ACTIONS.SETTINGS_UPDATE, "app_settings", null, before, settings);
      if (!(await userHasAccountantPermission(db, req.user, "permissions"))) {
        delete settings.accountant_permissions;
      }
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
