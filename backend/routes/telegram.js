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
