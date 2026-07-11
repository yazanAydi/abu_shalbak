import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { canViewReports } from "../utils/roles.js";
import { validate } from "../middleware/validate.js";
import { onAccountRequestReviewSchema } from "../middleware/schemas.js";
import {
  getOnAccountRequestById,
  listPendingOnAccountRequests,
  listOnAccountRequestHistory,
  listMyOnAccountRequests,
  listUnreadOnAccountDecisions,
  acknowledgeOnAccountDecision,
  approveOnAccountRequest,
  rejectOnAccountRequest,
  buildOnAccountRequestStatusPayload,
} from "../services/onAccountRequestService.js";

function canViewOnAccountRequest(user, request) {
  if (!user || !request) return false;
  if (canViewReports(user.role)) return true;
  return Number(request.cashier_id) === Number(user.id);
}

export function createOnAccountRequestsRouter(db) {
  const router = Router();
  const requireOnAccountApprovals = requireReportsPermission(db, "on_account_approvals");

  router.get("/pending", requireAuth, requireOnAccountApprovals, async (_req, res) => {
    const rows = await listPendingOnAccountRequests(db);
    res.json(rows);
  });

  router.get("/history", requireAuth, requireOnAccountApprovals, async (req, res) => {
    const status = String(req.query.status || "all").toLowerCase();
    const rows = await listOnAccountRequestHistory(db, status);
    res.json(rows);
  });

  router.get("/mine/unread", requireAuth, requirePosAccess, async (req, res) => {
    const rows = await listUnreadOnAccountDecisions(db, req.user.id);
    res.json(rows);
  });

  router.get("/mine", requireAuth, requirePosAccess, async (req, res) => {
    const rows = await listMyOnAccountRequests(db, req.user.id);
    res.json(rows);
  });

  router.post("/:id/acknowledge", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row = await acknowledgeOnAccountDecision(db, id, req.user.id);
      res.json({ success: true, request: row });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const row = await getOnAccountRequestById(db, id);
    if (!row) return res.status(404).json({ error: "طلب الذمة غير موجود" });
    if (!canViewOnAccountRequest(req.user, row)) {
      return res.status(403).json({ error: "ممنوع" });
    }
    res.json(await buildOnAccountRequestStatusPayload(db, row));
  });

  router.put("/:id", requireAuth, requireOnAccountApprovals, validate(onAccountRequestReviewSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const { status, review_notes: reviewNotes } = req.body;
    const note = reviewNotes != null ? String(reviewNotes).trim() : null;
    try {
      const result =
        status === "approved"
          ? await approveOnAccountRequest(db, id, req.user, note, req, "admin")
          : await rejectOnAccountRequest(db, id, req.user, note, req, "admin");
      res.json({ success: true, ...result });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  return router;
}
