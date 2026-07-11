import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { canViewReports } from "../utils/roles.js";
import { validate } from "../middleware/validate.js";
import { advanceRequestCreateSchema, advanceRequestReviewSchema } from "../middleware/schemas.js";
import {
  createAdvanceRequest,
  getAdvanceRequestById,
  listPendingAdvanceRequests,
  listAdvanceRequestHistory,
  listMyAdvanceRequests,
  listUnreadAdvanceDecisions,
  acknowledgeAdvanceDecision,
  approveAdvanceRequest,
  rejectAdvanceRequest,
} from "../services/advanceRequestService.js";

function canViewAdvanceRequest(user, request) {
  if (!user || !request) return false;
  if (canViewReports(user.role)) return true;
  return Number(request.cashier_id) === Number(user.id);
}

export function createAdvanceRequestsRouter(db) {
  const router = Router();
  const requireAdvanceApprovals = requireReportsPermission(db, "advance_approvals");

  router.post("/", requireAuth, requirePosAccess, validate(advanceRequestCreateSchema), async (req, res, next) => {
    try {
      const result = await createAdvanceRequest(db, {
        cashierId: req.user.id,
        employeeName: req.body.employee_name,
        amount: req.body.amount,
        notes: req.body.notes,
        req,
      });
      res.status(201).json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.get("/pending", requireAuth, requireAdvanceApprovals, async (_req, res) => {
    const rows = await listPendingAdvanceRequests(db);
    res.json(rows);
  });

  router.get("/history", requireAuth, requireAdvanceApprovals, async (req, res) => {
    const status = String(req.query.status || "all").toLowerCase();
    const rows = await listAdvanceRequestHistory(db, status);
    res.json(rows);
  });

  router.get("/mine/unread", requireAuth, requirePosAccess, async (req, res) => {
    const rows = await listUnreadAdvanceDecisions(db, req.user.id);
    res.json(rows);
  });

  router.get("/mine", requireAuth, requirePosAccess, async (req, res) => {
    const rows = await listMyAdvanceRequests(db, req.user.id);
    res.json(rows);
  });

  router.post("/:id/acknowledge", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await acknowledgeAdvanceDecision(db, id, req.user.id);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const row = await getAdvanceRequestById(db, id);
    if (!row) return res.status(404).json({ error: "طلب السلف غير موجود" });
    if (!canViewAdvanceRequest(req.user, row)) {
      return res.status(403).json({ error: "ممنوع" });
    }
    res.json({
      request_id: row.id,
      status: row.status,
      amount: row.amount,
      employee_name: row.employee_name,
      notes: row.notes,
      created_at: row.created_at,
      approved_at: row.approved_at,
      rejected_at: row.rejected_at,
      review_notes: row.review_notes,
      decision_source: row.decision_source ?? null,
      cashier_notified_at: row.cashier_notified_at ?? null,
      cashier_acknowledged_at: row.cashier_acknowledged_at ?? null,
      cashier_username: row.cashier_username,
      manager_username: row.manager_username,
    });
  });

  router.put("/:id", requireAuth, requireAdvanceApprovals, validate(advanceRequestReviewSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const { status, review_notes: reviewNotes } = req.body;
    const note = reviewNotes != null ? String(reviewNotes).trim() : null;
    try {
      const result =
        status === "approved"
          ? await approveAdvanceRequest(db, id, req.user, note, req, "admin")
          : await rejectAdvanceRequest(db, id, req.user, note, req, "admin");
      res.json({ success: true, ...result });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  return router;
}
