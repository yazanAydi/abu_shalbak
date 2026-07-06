import { Router } from "express";

import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { listCurrencies, getCurrencyById, round2Rate } from "../utils/currencies.js";
import { withTransaction } from "../utils/dbTx.js";

export function createCurrenciesRouter(db) {
  const router = Router();

  // Enabled currencies for POS / cashier use.
  router.get("/", requireAuth, async (_req, res, next) => {
    try {
      const currencies = await listCurrencies(db, { enabledOnly: true });
      res.json({ currencies });
    } catch (e) {
      next(e);
    }
  });

  // Full list (including disabled) for the admin settings page.
  router.get("/all", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
      const currencies = await listCurrencies(db, { enabledOnly: false });
      res.json({ currencies });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const before = await getCurrencyById(db, id);
      if (!before) {
        return res.status(404).json({ error: "العملة غير موجودة", code: "NOT_FOUND" });
      }

      const body = req.body || {};
      const updates = {};

      if (body.name != null) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ error: "الاسم مطلوب", code: "VALIDATION_ERROR" });
        updates.name = name;
      }
      if (body.symbol != null) {
        const symbol = String(body.symbol).trim();
        if (!symbol) return res.status(400).json({ error: "الرمز مطلوب", code: "VALIDATION_ERROR" });
        updates.symbol = symbol;
      }
      if (body.exchange_rate_to_nis != null) {
        const rate = round2Rate(body.exchange_rate_to_nis);
        if (!Number.isFinite(rate) || rate <= 0) {
          return res.status(400).json({ error: "سعر الصرف يجب أن يكون أكبر من صفر", code: "VALIDATION_ERROR" });
        }
        if (before.is_base && rate !== 1) {
          return res.status(400).json({ error: "سعر صرف العملة الأساسية يجب أن يكون 1", code: "BASE_RATE_LOCKED" });
        }
        updates.exchange_rate_to_nis = rate;
      }
      if (body.enabled != null) {
        const enabled = body.enabled ? 1 : 0;
        if (before.is_base && !enabled) {
          return res.status(400).json({ error: "لا يمكن تعطيل العملة الأساسية", code: "BASE_ENABLED_LOCKED" });
        }
        updates.enabled = enabled;
      }

      const setBase = body.is_base === true || body.set_base === true;

      if (Object.keys(updates).length === 0 && !setBase) {
        return res.status(400).json({ error: "لا يوجد تغييرات", code: "VALIDATION_ERROR" });
      }

      await withTransaction(db, async () => {
        if (Object.keys(updates).length > 0) {
          const cols = Object.keys(updates);
          const setSql = cols.map((c) => `${c} = ?`).join(", ");
          await db.run(
            `UPDATE currencies SET ${setSql}, updated_at = datetime('now') WHERE id = ?`,
            [...cols.map((c) => updates[c]), id]
          );
        }
        if (setBase && !before.is_base) {
          // Base currency must always have rate 1 and be enabled.
          await db.run(`UPDATE currencies SET is_base = 0`);
          await db.run(
            `UPDATE currencies SET is_base = 1, enabled = 1, exchange_rate_to_nis = 1, updated_at = datetime('now') WHERE id = ?`,
            [id]
          );
        }
      });

      const after = await getCurrencyById(db, id);
      await logAudit(db, req, AUDIT_ACTIONS.CURRENCY_UPDATE, "currencies", id, before, after);
      res.json({ currency: after });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
