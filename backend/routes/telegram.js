import { Router } from "express";

import rateLimit from "express-rate-limit";

import { getRefundWebhookSecret } from "../utils/telegram.js";

import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

import { sendExpiryAlert } from "../services/expiryAlertService.js";

import { requireAuth, requireAdmin } from "../middleware/auth.js";



const webhookLimiter = rateLimit({

  windowMs: 60 * 1000,

  max: 120,

  standardHeaders: true,

  legacyHeaders: false,

});



export function createTelegramRouter(db) {

  const router = Router();



  router.post("/webhook/:secret", webhookLimiter, async (req, res) => {

    const expected = getRefundWebhookSecret();

    if (!expected || req.params.secret !== expected) {

      return res.status(403).json({ error: "Forbidden" });

    }



    await handleTelegramUpdate(db, req.body || {});

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


