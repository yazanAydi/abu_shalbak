import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { validate } from "../middleware/validate.js";
import { handoverFollowUpSchema, onAccountRequestReviewSchema, posCustomerCashDebtSchema } from "../middleware/schemas.js";
import {
  acknowledgeCustomerCashDebtDecision,
  approveCustomerCashDebtRequest,
  buildCustomerCashDebtStatusPayload,
  createCustomerCashDebtRequest,
  getCustomerCashDebtRequestById,
  listCustomerCashDebtRequestHistory,
  listPendingCustomerCashDebtRequests,
  listUnreadCustomerCashDebtDecisions,
  recordCustomerCashDebtHandover,
  rejectCustomerCashDebtRequest,
} from "../services/customerCashDebtRequestService.js";

async function canView(db, user, request) {
  if (!user || !request) return false;
  if (Number(request.cashier_id) === Number(user.id)) return true;
  if (user.role === "admin" || user.role === "accountant") {
    return userHasAccountantPermission(db, user, "on_account_approvals");
  }
  return false;
}

export function createCustomerCashDebtRequestsRouter(db) {
  const router = Router();
  const requireApprovals = requireReportsPermission(db, "on_account_approvals");

  router.post("/", requireAuth, requirePosAccess, validate(posCustomerCashDebtSchema), async (req, res, next) => {
    try {
      const result = await createCustomerCashDebtRequest(db, {
        cashierId: req.user.id,
        customerId: req.body.customer_id,
        amount: req.body.amount,
        notes: req.body.notes,
        idempotencyKey: req.body.idempotency_key,
        req,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.get("/pending", requireAuth, requireApprovals, async (_req, res) => {
    res.json(await listPendingCustomerCashDebtRequests(db));
  });

  router.get("/history", requireAuth, requireApprovals, async (req, res) => {
    const status = String(req.query.status || "all").toLowerCase();
    res.json(await listCustomerCashDebtRequestHistory(db, status));
  });

  router.get("/mine/unread", requireAuth, requirePosAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await listUnreadCustomerCashDebtDecisions(db, req.user.id));
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const row = await getCustomerCashDebtRequestById(db, id);
    if (!row) return res.status(404).json({ error: "طلب الذمة النقدية غير موجود" });
    if (!(await canView(db, req.user, row))) return res.status(403).json({ error: "ممنوع" });
    res.set("Cache-Control", "no-store");
    res.json(await buildCustomerCashDebtStatusPayload(db, row));
  });

  router.post("/:id/acknowledge", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await acknowledgeCustomerCashDebtDecision(db, id, req.user.id);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.post("/:id/handover", requireAuth, requireApprovals, validate(handoverFollowUpSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await recordCustomerCashDebtHandover(db, id, req.user.id, req.body.disposition);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.put("/:id", requireAuth, requireApprovals, validate(onAccountRequestReviewSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const note = req.body.review_notes != null ? String(req.body.review_notes).trim() : null;
    try {
      const result =
        req.body.status === "approved"
          ? await approveCustomerCashDebtRequest(db, id, req.user, note, req, "admin", {
              overrideCreditLimit: req.body.override_credit_limit === true,
            })
          : await rejectCustomerCashDebtRequest(db, id, req.user, note, req, "admin", {
              handoverDisposition: req.body.handover_disposition,
            });
      res.json({ success: true, ...result });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  return router;
}
