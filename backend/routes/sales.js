import { Router } from "express";
import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { listLimitSql } from "../utils/listQuery.js";
import {
  createSalesInvoiceDraft,
  updateSalesInvoiceDraft,
  postSalesInvoice,
  getSalesInvoiceDetail,
} from "../services/salesInvoiceService.js";

export function createSalesRouter(db) {
  const router = Router();
  const requireSalesInvoices = requireReportsPermission(db, "sales_invoices");

  router.get("/invoices", requireAuth, requireSalesInvoices, async (req, res) => {
    const { customer_id, status } = req.query;
    let sql = `SELECT si.*, c.name AS customer_name FROM sales_invoices si
               JOIN customers c ON c.id = si.customer_id WHERE 1=1`;
    const params = [];
    if (customer_id) {
      sql += " AND si.customer_id = ?";
      params.push(Number(customer_id));
    }
    if (status) {
      sql += " AND si.status = ?";
      params.push(status);
    }
    sql += ` ORDER BY si.created_at DESC${listLimitSql(req.query, 300, req.user?.role).sql}`;
    res.json(await db.all(sql, params));
  });

  router.get("/invoices/:id", requireAuth, requireSalesInvoices, async (req, res) => {
    const detail = await getSalesInvoiceDetail(db, req.params.id);
    if (!detail) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    res.json(detail);
  });

  router.post("/invoices", requireAuth, requireSalesInvoices, async (req, res, next) => {
    try {
      const result = await createSalesInvoiceDraft(db, req.body, req.user.id);
      if (result.error) return res.status(result.status).json({ error: result.error, code: "VALIDATION_ERROR" });
      res.status(201).json(result.row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/invoices/:id", requireAuth, requireSalesInvoices, async (req, res, next) => {
    try {
      const result = await updateSalesInvoiceDraft(db, req.params.id, req.body);
      if (result.error) return res.status(result.status).json({ error: result.error, code: result.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR" });
      res.json(result.row);
    } catch (e) {
      next(e);
    }
  });

  router.post("/invoices/post-all", requireAuth, requireSalesInvoices, async (req, res, next) => {
    const body = req.body || {};
    if (Array.isArray(body.payments)) {
      return res.status(400).json({
        error: "ترحيل الكل يدعم طريقة دفع واحدة لكل الفواتير",
        code: "VALIDATION_ERROR",
      });
    }
    if (!body.payment_method) {
      return res.status(400).json({
        error: "طريقة الدفع مطلوبة",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const drafts = await db.all(
        "SELECT id FROM sales_invoices WHERE status = 'draft' ORDER BY id"
      );
      const ids = [];
      const errors = [];
      for (const d of drafts) {
        const result = await postSalesInvoice(db, d.id, body, req.user.id);
        if (result.error) {
          errors.push({ id: d.id, error: result.error });
        } else {
          ids.push(d.id);
        }
      }
      res.json({ posted_count: ids.length, ids, errors });
    } catch (e) {
      next(e);
    }
  });

  router.post("/invoices/:id/post", requireAuth, requireSalesInvoices, async (req, res, next) => {
    try {
      const result = await postSalesInvoice(db, req.params.id, req.body, req.user.id);
      if (result.error) {
        const code = result.status === 404 ? "NOT_FOUND" : result.status === 400 ? "VALIDATION_ERROR" : "ERROR";
        return res.status(result.status).json({ error: result.error, code });
      }
      res.json(result.row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/invoices/:id", requireAuth, requireSalesInvoices, async (req, res) => {
    const inv = await db.get("SELECT * FROM sales_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن حذف فاتورة مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM sales_invoices WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
