import { Router } from "express";
import { requireAuth, requireAdmin, requireReportsPermission } from "../middleware/auth.js";
import { shopTodayYmd } from "../utils/shopTime.js";

const SALES_STATUS = ["pending", "out", "delivered", "cancelled"];
const RECV_STATUS = ["pending", "received", "cancelled"];

export function createDeliveriesRouter(db) {
  const router = Router();
  const requireDeliveries = requireReportsPermission(db, "deliveries");

  // ════════════ Sales Deliveries ════════════

  router.get("/sales", requireAuth, requireDeliveries, async (req, res) => {
    const { status } = req.query;
    let sql = `SELECT d.*, c.name AS customer_name, u.username AS created_by_name
               FROM sales_deliveries d
               LEFT JOIN customers c ON c.id = d.customer_id
               LEFT JOIN users u ON u.id = d.created_by WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND d.status = ?"; params.push(status); }
    sql += " ORDER BY d.created_at DESC LIMIT 300";
    res.json(await db.all(sql, params));
  });

  router.post("/sales", requireAuth, requireAdmin, async (req, res) => {
    const { transaction_id, customer_id, driver, vehicle, address, delivery_date, notes } = req.body || {};
    const noRow = await db.get("SELECT MAX(delivery_no) AS mx FROM sales_deliveries");
    const no = (Number(noRow?.mx) || 0) + 1;
    const ins = await db.run(
      `INSERT INTO sales_deliveries (delivery_no, transaction_id, customer_id, driver, vehicle, address, delivery_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        no,
        transaction_id ? Number(transaction_id) : null,
        customer_id ? Number(customer_id) : null,
        driver || null, vehicle || null, address || null,
        delivery_date || shopTodayYmd(),
        notes || null, req.user.id,
      ]
    );
    res.status(201).json(await db.get("SELECT * FROM sales_deliveries WHERE id = ?", [ins.lastID]));
  });

  router.patch("/sales/:id/status", requireAuth, requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (!SALES_STATUS.includes(status)) return res.status(400).json({ error: "حالة غير صالحة", code: "VALIDATION_ERROR" });
    const info = await db.run("UPDATE sales_deliveries SET status = ? WHERE id = ?", [status, req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json(await db.get("SELECT * FROM sales_deliveries WHERE id = ?", [req.params.id]));
  });

  router.delete("/sales/:id", requireAuth, requireAdmin, async (req, res) => {
    const info = await db.run("DELETE FROM sales_deliveries WHERE id = ?", [req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json({ success: true });
  });

  // ════════════ Purchase Receivings ════════════

  router.get("/receivings", requireAuth, requireDeliveries, async (req, res) => {
    const { status } = req.query;
    let sql = `SELECT r.*, s.name AS supplier_name, u.username AS created_by_name
               FROM purchase_receivings r
               LEFT JOIN suppliers s ON s.id = r.supplier_id
               LEFT JOIN users u ON u.id = r.created_by WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND r.status = ?"; params.push(status); }
    sql += " ORDER BY r.created_at DESC LIMIT 300";
    res.json(await db.all(sql, params));
  });

  router.post("/receivings", requireAuth, requireAdmin, async (req, res) => {
    const { purchase_invoice_id, supplier_id, driver, vehicle, received_date, notes } = req.body || {};
    const noRow = await db.get("SELECT MAX(receiving_no) AS mx FROM purchase_receivings");
    const no = (Number(noRow?.mx) || 0) + 1;
    const ins = await db.run(
      `INSERT INTO purchase_receivings (receiving_no, purchase_invoice_id, supplier_id, driver, vehicle, received_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        no,
        purchase_invoice_id ? Number(purchase_invoice_id) : null,
        supplier_id ? Number(supplier_id) : null,
        driver || null, vehicle || null,
        received_date || shopTodayYmd(),
        notes || null, req.user.id,
      ]
    );
    res.status(201).json(await db.get("SELECT * FROM purchase_receivings WHERE id = ?", [ins.lastID]));
  });

  router.patch("/receivings/:id/status", requireAuth, requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (!RECV_STATUS.includes(status)) return res.status(400).json({ error: "حالة غير صالحة", code: "VALIDATION_ERROR" });
    const info = await db.run("UPDATE purchase_receivings SET status = ? WHERE id = ?", [status, req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json(await db.get("SELECT * FROM purchase_receivings WHERE id = ?", [req.params.id]));
  });

  router.delete("/receivings/:id", requireAuth, requireAdmin, async (req, res) => {
    const info = await db.run("DELETE FROM purchase_receivings WHERE id = ?", [req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json({ success: true });
  });

  return router;
}
