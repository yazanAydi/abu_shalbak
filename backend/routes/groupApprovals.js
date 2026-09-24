import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import {
  approveShopConsumptionRequest,
  rejectShopConsumptionRequest,
  getShopConsumptionRequestById,
} from "../services/shopConsumptionService.js";
import {
  approveExpenseApprovalRequest,
  rejectExpenseApprovalRequest,
  approveSupplierPaymentApprovalRequest,
  rejectSupplierPaymentApprovalRequest,
  createExpenseApprovalRequest,
  getExpenseApprovalRequestById,
  getSupplierPaymentApprovalRequestById,
} from "../services/groupApprovalService.js";

function review(action) {
  return async (db, req, res, next, kind) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const row =
        kind === "expense"
          ? action === "approve"
            ? await approveExpenseApprovalRequest(db, id, req.user, "admin")
            : await rejectExpenseApprovalRequest(db, id, req.user, "admin")
          : action === "approve"
            ? await approveSupplierPaymentApprovalRequest(db, id, req.user, "admin", req)
            : await rejectSupplierPaymentApprovalRequest(db, id, req.user, "admin");
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  };
}

export function createExpenseApprovalRouter(db) {
  const router = Router();
  const requireExpenses = requireReportsPermission(db, "expenses");
  router.get("/", requireAuth, requireExpenses, async (_req, res) => {
    const rows = await db.all(
      `SELECT r.*, u.username AS requester_username
       FROM expense_approval_requests r
       JOIN users u ON u.id = r.requester_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at ASC, r.id ASC`
    );
    res.json(rows);
  });
  router.post("/", requireAuth, requireExpenses, async (req, res, next) => {
    try {
      const result = await createExpenseApprovalRequest(db, {
        requesterId: req.user.id,
        categoryId: req.body?.category_id,
        amount: req.body?.amount,
        paidOn: req.body?.paid_on,
        paymentMethod: req.body?.payment_method,
        referenceNote: req.body?.reference_note,
        idempotencyKey: req.body?.idempotency_key,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });
  router.get("/:id", requireAuth, requireExpenses, async (req, res) => {
    const row = await getExpenseApprovalRequestById(db, req.params.id);
    if (!row) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json(row);
  });
  router.post("/:id/approve", requireAuth, requireExpenses, (req, res, next) =>
    review("approve")(db, req, res, next, "expense")
  );
  router.post("/:id/reject", requireAuth, requireExpenses, (req, res, next) =>
    review("reject")(db, req, res, next, "expense")
  );
  return router;
}

export function createShopConsumptionApprovalRouter(db) {
  const router = Router();
  const requireExpenses = requireReportsPermission(db, "expenses");
  router.get("/:id", requireAuth, async (req, res, next) => {
    try {
      const row = await getShopConsumptionRequestById(db, req.params.id);
      if (!row) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      const isCashier = Number(row.cashier_id) === Number(req.user.id);
      const canReview = await userHasAccountantPermission(db, req.user, "expenses");
      if (!isCashier && !canReview) return res.status(403).json({ error: "غير مسموح", code: "FORBIDDEN" });
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });
  router.post("/:id/approve", requireAuth, requireExpenses, async (req, res, next) => {
    try {
      const row = await approveShopConsumptionRequest(db, req.params.id, {
        decisionSource: "admin",
        officeUser: req.user,
        req,
      });
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });
  router.post("/:id/reject", requireAuth, requireExpenses, async (req, res, next) => {
    try {
      const row = await rejectShopConsumptionRequest(db, req.params.id, {
        decisionSource: "admin",
        officeUser: req.user,
      });
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });
  return router;
}

export function createSupplierPaymentApprovalRouter(db) {
  const router = Router();
  const requireSuppliers = requireReportsPermission(db, "suppliers");
  router.get("/:id", requireAuth, async (req, res, next) => {
    try {
      const row = await getSupplierPaymentApprovalRequestById(db, req.params.id);
      if (!row) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      const isCashier = Number(row.cashier_id) === Number(req.user.id);
      const canReview = await userHasAccountantPermission(db, req.user, "suppliers");
      if (!isCashier && !canReview) return res.status(403).json({ error: "غير مسموح", code: "FORBIDDEN" });
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });
  router.post("/:id/acknowledge", requireAuth, requirePosAccess, async (req, res, next) => {
    try {
      const info = await db.run(
        `UPDATE supplier_payment_approval_requests
           SET cashier_acknowledged_at = datetime('now')
         WHERE id = ? AND cashier_id = ? AND status IN ('approved', 'rejected')`,
        [req.params.id, req.user.id]
      );
      if (!info.changes) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });
  router.post("/:id/approve", requireAuth, requireSuppliers, (req, res, next) =>
    review("approve")(db, req, res, next, "supplier")
  );
  router.post("/:id/reject", requireAuth, requireSuppliers, (req, res, next) =>
    review("reject")(db, req, res, next, "supplier")
  );
  return router;
}
