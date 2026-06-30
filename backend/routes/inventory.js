import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { recordMovement, applyStockDelta } from "../utils/inventory.js";
import { round2 } from "../utils/tax.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
const requireReports = requireRoles("admin", "accountant");

const ADJ_TYPES = ["in", "out", "damage", "consumption", "correction"];
// Maps adjustment type -> ledger movement_type and sign of stock change.
const ADJ_MOVEMENT = {
  in: { type: "adjust_in", sign: 1 },
  out: { type: "adjust_out", sign: -1 },
  damage: { type: "damage", sign: -1 },
  consumption: { type: "consumption", sign: -1 },
  correction: { type: "correction", sign: 1 }, // signed quantity supplied by user
};

export function createInventoryRouter(db) {
  const router = Router();

  // ───── Stock Count Sessions ─────

  router.get("/counts", requireAuth, requireReports, async (req, res) => {
    const rows = await db.all(
      `SELECT sc.*, u.username as created_by_name
       FROM stock_count_sessions sc
       LEFT JOIN users u ON sc.created_by = u.id
       ORDER BY sc.created_at DESC LIMIT 100`
    );
    res.json(rows);
  });

  router.post("/counts", requireAuth, requireAdmin, async (req, res) => {
    const open = await db.get(
      "SELECT id FROM stock_count_sessions WHERE status = 'open' LIMIT 1"
    );
    if (open) {
      return res.status(400).json({
        error: "يوجد جرد مفتوح بالفعل، يرجى إغلاقه أولاً",
        code: "OPEN_COUNT_EXISTS",
        session_id: open.id,
      });
    }
    const ins = await db.run(
      "INSERT INTO stock_count_sessions (notes, created_by) VALUES (?, ?)",
      [req.body?.notes || null, req.user.id]
    );
    const row = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [ins.lastID]);
    res.status(201).json(row);
  });

  router.get("/counts/:id", requireAuth, requireReports, async (req, res) => {
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
    const lines = await db.all(
      `SELECT scl.*, p.name, p.barcode, p.unit
       FROM stock_count_lines scl
       JOIN products p ON scl.product_id = p.id
       WHERE scl.session_id = ?
       ORDER BY p.name`,
      [req.params.id]
    );
    res.json({ ...session, lines });
  });

  router.post("/counts/:id/lines", requireAuth, requireRoles("admin", "accountant", "shelves_employee"), async (req, res, next) => {
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
    if (session.status !== "open") {
      return res.status(400).json({ error: "لا يمكن تعديل جلسة مغلقة", code: "SESSION_CLOSED" });
    }

    const { product_id, counted_qty } = req.body || {};
    if (!product_id || counted_qty === undefined) {
      return res.status(400).json({ error: "product_id و counted_qty مطلوبان", code: "VALIDATION_ERROR" });
    }
    const qty = Number(counted_qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ error: "الكمية المعدودة غير صالحة", code: "VALIDATION_ERROR" });
    }

    const product = await db.get("SELECT * FROM products WHERE id = ?", [Number(product_id)]);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const systemQty = Number(product.stock) || 0;
    const variance = qty - systemQty;

    const existing = await db.get(
      "SELECT id FROM stock_count_lines WHERE session_id = ? AND product_id = ?",
      [session.id, product.id]
    );
    if (existing) {
      await db.run(
        "UPDATE stock_count_lines SET system_qty = ?, counted_qty = ?, variance = ? WHERE id = ?",
        [systemQty, qty, variance, existing.id]
      );
    } else {
      await db.run(
        "INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance) VALUES (?, ?, ?, ?, ?)",
        [session.id, product.id, systemQty, qty, variance]
      );
    }
    const updated = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [session.id]);
    const lines = await db.all("SELECT * FROM stock_count_lines WHERE session_id = ?", [session.id]);
    res.json({ ...updated, lines });
  });

  router.post("/counts/:id/post", requireAuth, requireAdmin, async (req, res, next) => {
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
    if (session.status !== "open") {
      return res.status(400).json({ error: "الجلسة ليست مفتوحة", code: "SESSION_CLOSED" });
    }
    const lines = await db.all("SELECT * FROM stock_count_lines WHERE session_id = ?", [session.id]);
    if (lines.length === 0) {
      return res.status(400).json({ error: "لا توجد أسطر جرد", code: "EMPTY_SESSION" });
    }

    await db.run("BEGIN IMMEDIATE");
    try {
      for (const L of lines) {
        const variance = Number(L.variance) || 0;
        if (variance !== 0) {
          await applyStockDelta(db, L.product_id, variance, {
            movementType: "count",
            referenceType: "stock_count_session",
            referenceId: session.id,
            userId: req.user.id,
            notes: `جرد #${session.id}`,
          });
        }
      }
      await db.run(
        "UPDATE stock_count_sessions SET status = 'posted', posted_at = datetime('now') WHERE id = ?",
        [session.id]
      );
      await db.run("COMMIT");
      await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_COUNT, "stock_count_sessions", session.id, { status: "open" }, { status: "posted", lines: lines.length });
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      return next(e);
    }

    const updated = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [session.id]);
    res.json(updated);
  });

  router.delete("/counts/:id", requireAuth, requireAdmin, async (req, res) => {
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
    if (session.status === "posted") {
      return res.status(400).json({ error: "لا يمكن حذف جلسة مرحّلة", code: "ALREADY_POSTED" });
    }
    await db.run("DELETE FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Expiry Reports ─────

  router.get("/expiry", requireAuth, requireReports, async (req, res) => {
    const { days = 30 } = req.query;
    const d = Math.max(1, Math.min(365, Number(days) || 30));
    const rows = await db.all(
      `SELECT id, barcode, name, unit, stock, expiry_date,
         CAST(julianday(expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
       FROM products
       WHERE expiry_date IS NOT NULL AND expiry_date != ''
         AND julianday(expiry_date) <= julianday('now', '+' || ? || ' days')
       ORDER BY expiry_date ASC`,
      [d]
    );
    res.json(rows);
  });

  // ───── Stock Adjustments ─────

  router.get("/adjustments", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT a.*, u.username AS created_by_name,
              (SELECT COUNT(*) FROM stock_adjustment_items ai WHERE ai.adjustment_id = a.id) AS item_count
       FROM stock_adjustments a LEFT JOIN users u ON u.id = a.created_by
       ORDER BY a.created_at DESC LIMIT 200`
    );
    res.json(rows);
  });

  router.get("/adjustments/:id", requireAuth, requireReports, async (req, res) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "التسوية غير موجودة", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT ai.*, p.name, p.barcode FROM stock_adjustment_items ai
       JOIN products p ON p.id = ai.product_id WHERE ai.adjustment_id = ?`,
      [adj.id]
    );
    res.json({ ...adj, items });
  });

  router.post("/adjustments", requireAuth, requireAdmin, async (req, res) => {
    const { adjustment_type, adjustment_date, notes, items, post } = req.body || {};
    if (!ADJ_TYPES.includes(adjustment_type)) {
      return res.status(400).json({ error: "نوع التسوية غير صالح", code: "VALIDATION_ERROR" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "أصناف التسوية مطلوبة", code: "VALIDATION_ERROR" });
    }
    const norm = [];
    for (const it of items) {
      const pid = Number(it.product_id);
      const q = Number(it.quantity);
      if (!pid || !Number.isFinite(q) || q === 0) {
        return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      }
      norm.push({ product_id: pid, quantity: q, unit_cost: it.unit_cost != null ? round2(Number(it.unit_cost)) : null, notes: it.notes || null });
    }

    await db.run("BEGIN IMMEDIATE");
    try {
      const noRow = await db.get("SELECT MAX(adjustment_no) AS mx FROM stock_adjustments");
      const no = (Number(noRow?.mx) || 0) + 1;
      const ins = await db.run(
        `INSERT INTO stock_adjustments (adjustment_no, adjustment_date, adjustment_type, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [no, adjustment_date || new Date().toISOString().slice(0, 10), adjustment_type, post ? "posted" : "draft", notes || null, req.user.id]
      );
      const adjId = ins.lastID;
      const map = ADJ_MOVEMENT[adjustment_type];
      for (const it of norm) {
        await db.run(
          `INSERT INTO stock_adjustment_items (adjustment_id, product_id, quantity, unit_cost, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [adjId, it.product_id, it.quantity, it.unit_cost, it.notes]
        );
        if (post) {
          const delta = adjustment_type === "correction" ? it.quantity : map.sign * Math.abs(it.quantity);
          await recordMovement(db, {
            productId: it.product_id,
            movementType: map.type,
            quantity: delta,
            unitCost: it.unit_cost,
            refType: "stock_adjustment",
            refId: adjId,
            notes: `تسوية #${no} (${adjustment_type})`,
            userId: req.user.id,
            applyStock: true,
          });
        }
      }
      if (post) await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "stock_adjustments", adjId, null, { adjustment_no: no, type: adjustment_type });
      await db.run("COMMIT");
      const row = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adjId]);
      res.status(201).json(row);
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      next(e);
    }
  });

  router.post("/adjustments/:id/post", requireAuth, requireAdmin, async (req, res, next) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "التسوية غير موجودة", code: "NOT_FOUND" });
    if (adj.status === "posted") return res.status(400).json({ error: "مرحّلة بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?", [adj.id]);
    const map = ADJ_MOVEMENT[adj.adjustment_type];
    await db.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        const delta = adj.adjustment_type === "correction" ? it.quantity : map.sign * Math.abs(it.quantity);
        await recordMovement(db, {
          productId: it.product_id, movementType: map.type, quantity: delta, unitCost: it.unit_cost,
          refType: "stock_adjustment", refId: adj.id, notes: `تسوية #${adj.adjustment_no ?? adj.id}`, userId: req.user.id,
          applyStock: true,
        });
      }
      await db.run("UPDATE stock_adjustments SET status = 'posted', posted_at = datetime('now') WHERE id = ?", [adj.id]);
      await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "stock_adjustments", adj.id, { status: "draft" }, { status: "posted" });
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adj.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      next(e);
    }
  });

  router.put("/adjustments/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "التسوية غير موجودة", code: "NOT_FOUND" });
    if (adj.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل تسوية مرحّلة", code: "ALREADY_POSTED" });
    const { adjustment_type, adjustment_date, notes, items } = req.body || {};
    if (!ADJ_TYPES.includes(adjustment_type)) {
      return res.status(400).json({ error: "نوع التسوية غير صالح", code: "VALIDATION_ERROR" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "أصناف التسوية مطلوبة", code: "VALIDATION_ERROR" });
    }
    const norm = [];
    for (const it of items) {
      const pid = Number(it.product_id);
      const q = Number(it.quantity);
      if (!pid || !Number.isFinite(q) || q === 0) {
        return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      }
      norm.push({ product_id: pid, quantity: q, unit_cost: it.unit_cost != null ? round2(Number(it.unit_cost)) : null, notes: it.notes || null });
    }

    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run(
        `UPDATE stock_adjustments SET adjustment_type = ?, adjustment_date = ?, notes = ? WHERE id = ?`,
        [adjustment_type, adjustment_date || adj.adjustment_date, notes || null, adj.id]
      );
      await db.run("DELETE FROM stock_adjustment_items WHERE adjustment_id = ?", [adj.id]);
      for (const it of norm) {
        await db.run(
          `INSERT INTO stock_adjustment_items (adjustment_id, product_id, quantity, unit_cost, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [adj.id, it.product_id, it.quantity, it.unit_cost, it.notes]
        );
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adj.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      next(e);
    }
  });

  router.delete("/adjustments/:id", requireAuth, requireAdmin, async (req, res) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (adj.status === "posted") return res.status(400).json({ error: "لا يمكن حذف تسوية مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM stock_adjustments WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Movement ledger ─────

  router.get("/movements", requireAuth, requireReports, async (req, res) => {
    const { product_id, type, from, to } = req.query;
    let sql = `SELECT m.*, p.name AS product_name, p.barcode, u.username AS created_by_name
               FROM inventory_movements m
               JOIN products p ON p.id = m.product_id
               LEFT JOIN users u ON u.id = m.created_by WHERE 1=1`;
    const params = [];
    if (product_id) { sql += " AND m.product_id = ?"; params.push(Number(product_id)); }
    if (type) { sql += " AND m.movement_type = ?"; params.push(type); }
    if (from) { sql += " AND date(m.created_at) >= ?"; params.push(from); }
    if (to) { sql += " AND date(m.created_at) <= ?"; params.push(to); }
    sql += " ORDER BY m.created_at DESC, m.id DESC LIMIT 500";
    res.json(await db.all(sql, params));
  });

  // ───── Product batches (batch + expiry tracking) ─────

  router.get("/batches", requireAuth, requireReports, async (req, res) => {
    const { product_id } = req.query;
    let sql = `SELECT b.*, p.name AS product_name, p.barcode,
                 CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
               FROM product_batches b JOIN products p ON p.id = b.product_id WHERE 1=1`;
    const params = [];
    if (product_id) { sql += " AND b.product_id = ?"; params.push(Number(product_id)); }
    sql += " ORDER BY b.expiry_date IS NULL, b.expiry_date ASC LIMIT 500";
    res.json(await db.all(sql, params));
  });

  router.post("/batches", requireAuth, requireAdmin, async (req, res) => {
    const { product_id, batch_no, expiry_date, quantity, cost, notes } = req.body || {};
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: "المنتج مطلوب", code: "VALIDATION_ERROR" });
    const q = Number(quantity) || 0;
    const ins = await db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, cost, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [pid, batch_no || null, expiry_date || null, q, cost != null ? round2(Number(cost)) : null, notes || null]
    );
    res.status(201).json(await db.get("SELECT * FROM product_batches WHERE id = ?", [ins.lastID]));
  });

  router.delete("/batches/:id", requireAuth, requireAdmin, async (req, res) => {
    const info = await db.run("DELETE FROM product_batches WHERE id = ?", [req.params.id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    res.json({ success: true });
  });

  router.get("/adjustment-types", requireAuth, (_req, res) => {
    res.json({
      types: ADJ_TYPES,
      labels: { in: "إدخال مخزون", out: "إخراج مخزون", damage: "تالف", consumption: "استهلاك", correction: "تصحيح" },
    });
  });

  // ───── Low Stock ─────

  router.get("/low-stock", requireAuth, requireReports, async (req, res) => {
    const { threshold = 10 } = req.query;
    const t = Math.max(0, Number(threshold) || 10);
    const rows = await db.all(
      `SELECT id, barcode, name, unit, stock, category
       FROM products WHERE stock <= ? ORDER BY stock ASC, name`,
      [t]
    );
    res.json(rows);
  });

  // ───── Negative Stock (oversold) ─────
  // Negative stock is allowed by design (selling below zero is permitted).
  // This report lets managers see which products were oversold so they can
  // reconcile/restock. It does NOT block or clamp anything.
  router.get("/negative-stock", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT id, barcode, name, unit, stock, category
       FROM products WHERE COALESCE(stock, 0) < 0 ORDER BY stock ASC, name`
    );
    res.json({ count: rows.length, products: rows });
  });

  return router;
}
