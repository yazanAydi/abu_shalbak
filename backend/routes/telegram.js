import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getRefundWebhookSecret,
  getZimmaWebhookSecret,
  getSulafWebhookSecret,
  getApprovalsWebhookSecret,
} from "../utils/telegram.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";
import { sendExpiryAlert } from "../services/expiryAlertService.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { timingSafeStringEqual } from "../utils/kioskToken.js";

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

export function createTelegramRouter(db) {
  const router = Router();

  function telegramSecretOk(expected, req) {
    if (!expected) return false;
    const header = req.headers["x-telegram-bot-api-secret-token"];
    if (header && timingSafeStringEqual(header, expected)) return true;
    return Boolean(req.params.secret && timingSafeStringEqual(req.params.secret, expected));
  }

  router.post("/webhook/:secret", webhookLimiter, async (req, res) => {
    const expected = getRefundWebhookSecret();
    if (!telegramSecretOk(expected, req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await handleTelegramUpdate(db, req.body || {});
    return res.json({ ok: true });
  });

  router.post("/webhook/zimma/:secret", webhookLimiter, async (req, res) => {
    const expected = getZimmaWebhookSecret();
    if (!telegramSecretOk(expected, req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await handleTelegramUpdate(db, req.body || {});
    return res.json({ ok: true });
  });

  router.post("/webhook/sulaf/:secret", webhookLimiter, async (req, res) => {
    const expected = getSulafWebhookSecret();
    if (!telegramSecretOk(expected, req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await handleTelegramUpdate(db, req.body || {});
    return res.json({ ok: true });
  });

  router.post("/webhook/approvals/:secret", webhookLimiter, async (req, res) => {
    const expected = getApprovalsWebhookSecret();
    if (!telegramSecretOk(expected, req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await handleTelegramUpdate(db, req.body || {}, { sourceBot: "approvals" });
    return res.json({ ok: true });
  });

  const RETRY_TABLES = {
    refund: "refund_requests",
    on_account: "on_account_requests",
    advance: "advance_requests",
    cash_debt: "customer_cash_debt_requests",
    expense: "expense_approval_requests",
    supplier: "supplier_payment_approval_requests",
    consumption: "shop_consumption_requests",
  };

  router.post("/outbound/retry", requireAuth, async (req, res, next) => {
    try {
      const kind = String(req.body?.kind || "");
      const requestId = Number(req.body?.request_id);
      const table = RETRY_TABLES[kind];
      if (!table || !Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ error: "طلب غير صالح", code: "INVALID_RETRY" });
      }
      const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [requestId]);
      if (!row) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      const ownerId = Number(row.cashier_id ?? row.requester_id);
      const role = req.user?.role;
      if (role !== "admin" && role !== "accountant" && ownerId !== Number(req.user?.id)) {
        return res.status(403).json({ error: "غير مصرح", code: "FORBIDDEN" });
      }
      const { retrySavedTelegramDelivery } = await import("../services/telegramDelivery.js");
      const state = await retrySavedTelegramDelivery(db, table, requestId);
      res.json({ success: true, data: { request_id: requestId, kind, ...state } });
    } catch (e) {
      next(e);
    }
  });

  router.post("/send-expiry-alert", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const result = await sendExpiryAlert(db);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
