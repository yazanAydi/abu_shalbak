import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { validate } from "../middleware/validate.js";
import { handoverFollowUpSchema, refundRequestCreateSchema, refundRequestPreviewSchema, refundRequestReviewSchema } from "../middleware/schemas.js";
import {
  createRefundRequest,
  previewRefundRequest,
  getRefundRequestById,
  listPendingRefundRequests,
  listRefundRequestHistory,
  listMyRefundRequests,
  listUnreadRefundDecisions,
  acknowledgeRefundDecision,
  approveRefundRequest,
  rejectRefundRequest,
  recordRefundHandover,
} from "../services/refundRequestService.js";

async function canViewRefundRequest(db, user, request) {
  if (!user || !request) return false;
  if (Number(request.cashier_id) === Number(user.id)) return true;
  if (user.role === "admin" || user.role === "accountant") {
    return userHasAccountantPermission(db, user, "refund_approvals");
  }
  return false;
}

export function createRefundRequestsRouter(db) {
  const router = Router();
  const requireRefundApprovals = requireReportsPermission(db, "refund_approvals");

  router.post("/", requireAuth, requirePosAccess, validate(refundRequestCreateSchema), async (req, res, next) => {
    try {
      const body = req.body;
      const result = await createRefundRequest(db, {
        cashierId: req.user.id,
        transactionId: body.original_transaction_id,
        lines: body.lines,
        paymentMethod: body.payment_method,
        reason: body.reason,
        idempotencyKey: body.idempotency_key,
        req,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, max_returnable: e.max_returnable, code: e.code });
      next(e);
    }
  });

  router.post("/preview", requireAuth, requirePosAccess, validate(refundRequestPreviewSchema), async (req, res, next) => {
    try {
      const body = req.body;
      const quote = await previewRefundRequest(db, {
        cashierId: req.user.id,
        transactionId: body.original_transaction_id,
        lines: body.lines,
        paymentMethod: body.payment_method,
      });
      res.json(quote);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, max_returnable: e.max_returnable, code: e.code });
      next(e);
    }
  });

  router.get("/pending", requireAuth, requireRefundApprovals, async (_req, res) => {
    const rows = await listPendingRefundRequests(db);
    res.json(rows);
  });

  router.get("/history", requireAuth, requireRefundApprovals, async (req, res) => {
    const status = String(req.query.status || "all").toLowerCase();
    const rows = await listRefundRequestHistory(db, status);
    res.json(rows);
  });

  router.get("/mine/unread", requireAuth, requirePosAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const rows = await listUnreadRefundDecisions(db, req.user.id);
    res.json(rows);
  });

  router.get("/mine", requireAuth, requirePosAccess, async (req, res) => {
    const rows = await listMyRefundRequests(db, req.user.id);
    res.json(rows);
  });

  router.post("/:id/acknowledge", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await acknowledgeRefundDecision(db, id, req.user.id);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const row = await getRefundRequestById(db, id);
    if (!row) return res.status(404).json({ error: "طلب الاسترجاع غير موجود" });
    if (!(await canViewRefundRequest(db, req.user, row))) {
      return res.status(403).json({ error: "ممنوع" });
    }
    res.set("Cache-Control", "no-store");
    res.json({
      request_id: row.id,
      status: row.status,
      total_amount: row.total_amount,
      transaction_id: row.transaction_id,
      refund_id: row.refund_id,
      created_at: row.created_at,
      approved_at: row.approved_at,
      rejected_at: row.rejected_at,
      review_notes: row.review_notes,
      decision_source: row.decision_source ?? null,
      cashier_notified_at: row.cashier_notified_at ?? null,
      cashier_acknowledged_at: row.cashier_acknowledged_at ?? null,
      cashier_username: row.cashier_username,
      manager_username: row.manager_username,
      shift_status: row.shift_status ?? null,
    });
  });

  router.post("/:id/handover", requireAuth, requireRefundApprovals, validate(handoverFollowUpSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await recordRefundHandover(db, id, req.user.id, req.body.disposition);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.put("/:id", requireAuth, requireRefundApprovals, validate(refundRequestReviewSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const { status, review_notes: reviewNotes } = req.body;
    const note = reviewNotes != null ? String(reviewNotes).trim() : null;
    try {
      const result =
        status === "approved"
          ? await approveRefundRequest(db, id, req.user, note, req, "admin")
          : await rejectRefundRequest(db, id, req.user, note, req, "admin", {
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
