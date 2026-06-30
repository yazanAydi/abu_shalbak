import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
import { recordMovement } from "../utils/inventory.js";

const requireReports = requireRoles("admin", "accountant");
const WH_TYPES = ["main", "store", "returns", "damaged"];

async function upsertWarehouseStock(db, warehouseId, productId, delta) {
  const row = await db.get(
    "SELECT id, quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
    [warehouseId, productId]
  );
  if (row) {
    await db.run("UPDATE warehouse_stock SET quantity = quantity + ? WHERE id = ?", [delta, row.id]);
  } else {
    await db.run(
      "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)",
      [warehouseId, productId, delta]
    );
  }
}

export function createWarehousesRouter(db) {
  const router = Router();

  // ════════════ Warehouses ════════════

  router.get("/", requireAuth, async (_req, res) => {
    res.json(await db.all("SELECT * FROM warehouses ORDER BY active DESC, name"));
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const { name, code, type } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "اسم المستودع مطلوب", code: "VALIDATION_ERROR" });
    const t = WH_TYPES.includes(type) ? type : "store";
    const ins = await db.run("INSERT INTO warehouses (name, code, type) VALUES (?, ?, ?)", [String(name).trim(), code || null, t]);
    res.status(201).json(await db.get("SELECT * FROM warehouses WHERE id = ?", [ins.lastID]));
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM warehouses WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    await db.run(
      "UPDATE warehouses SET name=?, code=?, type=?, active=? WHERE id=?",
      [
        b.name !== undefined ? String(b.name).trim() : ex.name,
        b.code !== undefined ? (b.code || null) : ex.code,
        b.type !== undefined && WH_TYPES.includes(b.type) ? b.type : ex.type,
        b.active !== undefined ? (b.active ? 1 : 0) : ex.active,
        req.params.id,
      ]
    );
    res.json(await db.get("SELECT * FROM warehouses WHERE id = ?", [req.params.id]));
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const qty = await db.get("SELECT COALESCE(SUM(quantity),0) AS q FROM warehouse_stock WHERE warehouse_id = ?", [req.params.id]);
    if (Math.abs(Number(qty?.q) || 0) > 0.0001) {
      return res.status(400).json({ error: "لا يمكن حذف مستودع به مخزون", code: "NON_EMPTY" });
    }
    await db.run("DELETE FROM warehouses WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Stock report ════════════

  router.get("/stock", requireAuth, requireReports, async (req, res) => {
    const { warehouse_id } = req.query;
    let sql = `SELECT ws.warehouse_id, w.name AS warehouse_name, ws.product_id,
                      p.name AS product_name, p.barcode, ws.quantity, p.cost,
                      round(ws.quantity * COALESCE(p.cost,0), 2) AS value
               FROM warehouse_stock ws
               JOIN warehouses w ON w.id = ws.warehouse_id
               JOIN products p ON p.id = ws.product_id
               WHERE ABS(ws.quantity) > 0.0001`;
    const params = [];
    if (warehouse_id) { sql += " AND ws.warehouse_id = ?"; params.push(Number(warehouse_id)); }
    sql += " ORDER BY w.name, p.name LIMIT 1000";
    res.json(await db.all(sql, params));
  });

  // ════════════ Stock valuation report ════════════

  router.get("/valuation", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT w.id AS warehouse_id, w.name AS warehouse_name,
              COALESCE(SUM(ws.quantity), 0) AS total_qty,
              COALESCE(SUM(ws.quantity * COALESCE(p.cost,0)), 0) AS total_value
       FROM warehouses w
       LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
       LEFT JOIN products p ON p.id = ws.product_id
       GROUP BY w.id, w.name
       ORDER BY total_value DESC`
    );
    const grand = rows.reduce((s, r) => s + Number(r.total_value || 0), 0);
    res.json({
      warehouses: rows.map((r) => ({ ...r, total_value: round2(Number(r.total_value) || 0), total_qty: Number(r.total_qty) || 0 })),
      grand_total: round2(grand),
    });
  });

  // ════════════ Transfers ════════════

  router.get("/transfers", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name,
              (SELECT COUNT(*) FROM warehouse_transfer_items i WHERE i.transfer_id = t.id) AS item_count
       FROM warehouse_transfers t
       JOIN warehouses wf ON wf.id = t.from_warehouse_id
       JOIN warehouses wt ON wt.id = t.to_warehouse_id
       ORDER BY t.created_at DESC LIMIT 300`
    );
    res.json(rows);
  });

  router.get("/transfers/:id", requireAuth, requireReports, async (req, res) => {
    const t = await db.get(
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name
       FROM warehouse_transfers t
       JOIN warehouses wf ON wf.id = t.from_warehouse_id
       JOIN warehouses wt ON wt.id = t.to_warehouse_id WHERE t.id = ?`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: "التحويل غير موجود", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT i.*, p.name, p.barcode FROM warehouse_transfer_items i
       JOIN products p ON p.id = i.product_id WHERE i.transfer_id = ?`,
      [t.id]
    );
    res.json({ ...t, items });
  });

  router.post("/transfers", requireAuth, requireAdmin, async (req, res) => {
    const { from_warehouse_id, to_warehouse_id, transfer_date, notes, items } = req.body || {};
    const from = Number(from_warehouse_id);
    const to = Number(to_warehouse_id);
    if (!from || !to) return res.status(400).json({ error: "حدّد المستودعين", code: "VALIDATION_ERROR" });
    if (from === to) return res.status(400).json({ error: "المستودعان متطابقان", code: "VALIDATION_ERROR" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "أصناف مطلوبة", code: "VALIDATION_ERROR" });
    const norm = [];
    for (const it of items) {
      const pid = Number(it.product_id);
      const q = Number(it.quantity);
      if (!pid || !Number.isFinite(q) || q <= 0) return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      norm.push({ product_id: pid, quantity: q });
    }
    await db.run("BEGIN IMMEDIATE");
    try {
      const noRow = await db.get("SELECT MAX(transfer_no) AS mx FROM warehouse_transfers");
      const no = (Number(noRow?.mx) || 0) + 1;
      const ins = await db.run(
        `INSERT INTO warehouse_transfers (transfer_no, from_warehouse_id, to_warehouse_id, transfer_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        [no, from, to, transfer_date || new Date().toISOString().slice(0, 10), notes || null, req.user.id]
      );
      for (const it of norm) {
        await db.run(
          "INSERT INTO warehouse_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)",
          [ins.lastID, it.product_id, it.quantity]
        );
      }
      await db.run("COMMIT");
      res.status(201).json(await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [ins.lastID]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.post("/transfers/:id/post", requireAuth, requireAdmin, async (req, res) => {
    const t = await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "التحويل غير موجود", code: "NOT_FOUND" });
    if (t.status === "posted") return res.status(400).json({ error: "مرحّل بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?", [t.id]);
    if (items.length === 0) return res.status(400).json({ error: "لا توجد أصناف", code: "EMPTY" });

    await db.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        await upsertWarehouseStock(db, t.from_warehouse_id, it.product_id, -Number(it.quantity));
        await upsertWarehouseStock(db, t.to_warehouse_id, it.product_id, Number(it.quantity));
        // Per-warehouse movement (global products.stock unchanged: an internal transfer)
        await recordMovement(db, {
          productId: it.product_id, movementType: "transfer_out", quantity: -Number(it.quantity),
          warehouseId: t.from_warehouse_id, refType: "warehouse_transfer", refId: t.id,
          notes: `تحويل #${t.transfer_no ?? t.id}`, userId: req.user.id,
        });
        await recordMovement(db, {
          productId: it.product_id, movementType: "transfer_in", quantity: Number(it.quantity),
          warehouseId: t.to_warehouse_id, refType: "warehouse_transfer", refId: t.id,
          notes: `تحويل #${t.transfer_no ?? t.id}`, userId: req.user.id,
        });
      }
      await db.run("UPDATE warehouse_transfers SET status = 'posted', posted_at = datetime('now') WHERE id = ?", [t.id]);
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [t.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.put("/transfers/:id", requireAuth, requireAdmin, async (req, res) => {
    const t = await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "التحويل غير موجود", code: "NOT_FOUND" });
    if (t.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل تحويل مرحّل", code: "ALREADY_POSTED" });
    const { from_warehouse_id, to_warehouse_id, transfer_date, notes, items } = req.body || {};
    const from = Number(from_warehouse_id);
    const to = Number(to_warehouse_id);
    if (!from || !to) return res.status(400).json({ error: "حدّد المستودعين", code: "VALIDATION_ERROR" });
    if (from === to) return res.status(400).json({ error: "المستودعان متطابقان", code: "VALIDATION_ERROR" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "أصناف مطلوبة", code: "VALIDATION_ERROR" });
    const norm = [];
    for (const it of items) {
      const pid = Number(it.product_id);
      const q = Number(it.quantity);
      if (!pid || !Number.isFinite(q) || q <= 0) return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      norm.push({ product_id: pid, quantity: q });
    }
    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run(
        `UPDATE warehouse_transfers SET from_warehouse_id = ?, to_warehouse_id = ?, transfer_date = ?, notes = ? WHERE id = ?`,
        [from, to, transfer_date || t.transfer_date, notes || null, t.id]
      );
      await db.run("DELETE FROM warehouse_transfer_items WHERE transfer_id = ?", [t.id]);
      for (const it of norm) {
        await db.run(
          "INSERT INTO warehouse_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)",
          [t.id, it.product_id, it.quantity]
        );
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [t.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.delete("/transfers/:id", requireAuth, requireAdmin, async (req, res) => {
    const t = await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (t.status === "posted") return res.status(400).json({ error: "لا يمكن حذف تحويل مرحّل", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
