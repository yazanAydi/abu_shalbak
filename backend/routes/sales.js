import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import {
  createSalesInvoiceDraft,
  updateSalesInvoiceDraft,
  postSalesInvoice,
} from "../services/salesInvoiceService.js";

const requireReports = requireRoles("admin", "accountant");

export function createSalesRouter(db) {
  const router = Router();

  router.get("/invoices", requireAuth, requireReports, async (req, res) => {
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
    sql += " ORDER BY si.created_at DESC LIMIT 300";
    res.json(await db.all(sql, params));
  });

  router.get("/invoices/:id", requireAuth, requireReports, async (req, res) => {
    const inv = await db.get(
      `SELECT si.*, c.name AS customer_name FROM sales_invoices si
       JOIN customers c ON c.id = si.customer_id WHERE si.id = ?`,
      [req.params.id]
    );
    if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT sii.*, p.name, p.barcode FROM sales_invoice_items sii
       JOIN products p ON p.id = sii.product_id WHERE sii.invoice_id = ?`,
      [inv.id]
    );
    const payments = inv.status === "posted"
      ? await db.all("SELECT * FROM sales_invoice_payments WHERE invoice_id = ? ORDER BY id", [inv.id])
      : [];
    res.json({ ...inv, items, payments });
  });

  router.post("/invoices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await createSalesInvoiceDraft(db, req.body, req.user.id);
      if (result.error) return res.status(result.status).json({ error: result.error, code: "VALIDATION_ERROR" });
      res.status(201).json(result.row);
    } catch (e) {
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.put("/invoices/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await updateSalesInvoiceDraft(db, req.params.id, req.body);
      if (result.error) return res.status(result.status).json({ error: result.error, code: result.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR" });
      res.json(result.row);
    } catch (e) {
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.post("/invoices/:id/post", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await postSalesInvoice(db, req.params.id, req.body, req.user.id);
      if (result.error) {
        const code = result.status === 404 ? "NOT_FOUND" : result.status === 400 ? "VALIDATION_ERROR" : "ERROR";
        return res.status(result.status).json({ error: result.error, code });
      }
      res.json(result.row);
    } catch (e) {
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.delete("/invoices/:id", requireAuth, requireAdmin, async (req, res) => {
    const inv = await db.get("SELECT * FROM sales_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن حذف فاتورة مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM sales_invoices WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
