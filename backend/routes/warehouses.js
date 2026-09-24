import { Router } from "express";
import { requireAuth, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import { recordMovement } from "../utils/inventory.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { listLimitSql } from "../utils/listQuery.js";
import { withTransaction } from "../utils/dbTx.js";
import { getWarehouseValuation, listWarehouseStock } from "../utils/warehouseInventory.js";

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

function isBakeryMembership(req) {
  const raw = String(req.query?.membership || req.query?.workspace || "").trim().toLowerCase();
  return raw === "bakery";
}

function catalogQuery(req) {
  return {
    warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    membership: isBakeryMembership(req) ? "bakery" : null,
    q: req.query.q,
  };
}

export function createWarehousesRouter(db) {
  const router = Router();
  const requireWarehouses = requireReportsPermission(db, "warehouses");
  const requireWarehouseLookup = requireAnyReportsPermission(
    db,
    "warehouses",
    "bakery",
    "bakery_supplies",
    "purchases",
    "inventory_receipts"
  );
  const requireBakeryWarehouseRead = requireAnyReportsPermission(db, "warehouses", "bakery", "bakery_supplies");
  const requireWarehouseReport = (req, res, next) => {
    if (isBakeryMembership(req)) return requireBakeryWarehouseRead(req, res, next);
    return requireWarehouses(req, res, next);
  };

  // ════════════ Warehouses ════════════

  router.get("/", requireAuth, requireWarehouseLookup, async (_req, res) => {
    res.json(await db.all("SELECT * FROM warehouses ORDER BY active DESC, name"));
  });

  router.post("/", requireAuth, requireWarehouses, async (req, res, next) => {
    const { name, code, type } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "اسم المستودع مطلوب", code: "VALIDATION_ERROR" });
    const t = WH_TYPES.includes(type) ? type : "store";
    const ins = await db.run("INSERT INTO warehouses (name, code, type) VALUES (?, ?, ?)", [String(name).trim(), code || null, t]);
    res.status(201).json(await db.get("SELECT * FROM warehouses WHERE id = ?", [ins.lastID]));
  });

  router.put("/:id", requireAuth, requireWarehouses, async (req, res, next) => {
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

  router.delete("/:id", requireAuth, requireWarehouses, async (req, res, next) => {
    const qty = await db.get("SELECT COALESCE(SUM(quantity),0) AS q FROM warehouse_stock WHERE warehouse_id = ?", [req.params.id]);
    if (Math.abs(Number(qty?.q) || 0) > 0.0001) {
      return res.status(400).json({ error: "لا يمكن حذف مستودع به مخزون", code: "NON_EMPTY" });
    }
    await db.run("DELETE FROM warehouses WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Stock report ════════════

  router.get("/stock", requireAuth, requireWarehouseReport, async (req, res, next) => {
    try {
      res.json(await listWarehouseStock(db, catalogQuery(req)));
    } catch (e) {
      next(e);
    }
  });

  // ════════════ Stock valuation report ════════════

  router.get("/valuation", requireAuth, requireWarehouseReport, async (req, res, next) => {
    try {
      res.json(await getWarehouseValuation(db, catalogQuery(req)));
    } catch (e) {
      next(e);
    }
  });

  // ════════════ Transfers ════════════

  router.get("/transfers", requireAuth, requireWarehouses, async (req, res, next) => {
    const rows = await db.all(
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name,
              (SELECT COUNT(*) FROM warehouse_transfer_items i WHERE i.transfer_id = t.id) AS item_count
       FROM warehouse_transfers t
       JOIN warehouses wf ON wf.id = t.from_warehouse_id
       JOIN warehouses wt ON wt.id = t.to_warehouse_id
       ORDER BY t.created_at DESC${listLimitSql(req.query).sql}`
    );
    res.json(rows);
  });

  router.get("/transfers/:id", requireAuth, requireWarehouses, async (req, res, next) => {
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

  router.post("/transfers", requireAuth, requireWarehouses, async (req, res, next) => {
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
    try {
      const row = await withTransaction(db, async () => {
        const noRow = await db.get("SELECT MAX(transfer_no) AS mx FROM warehouse_transfers");
        const no = (Number(noRow?.mx) || 0) + 1;
        const ins = await db.run(
          `INSERT INTO warehouse_transfers (transfer_no, from_warehouse_id, to_warehouse_id, transfer_date, status, notes, created_by)
           VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
          [no, from, to, transfer_date || shopTodayYmd(), notes || null, req.user.id]
        );
        for (const it of norm) {
          await db.run(
            "INSERT INTO warehouse_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)",
            [ins.lastID, it.product_id, it.quantity]
          );
        }
        return db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [ins.lastID]);
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  router.post("/transfers/:id/post", requireAuth, requireWarehouses, async (req, res, next) => {
    const t = await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "التحويل غير موجود", code: "NOT_FOUND" });
    if (t.status === "posted") return res.status(400).json({ error: "مرحّل بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?", [t.id]);
    if (items.length === 0) return res.status(400).json({ error: "لا توجد أصناف", code: "EMPTY" });

    try {
      const row = await withTransaction(db, async () => {
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
        return db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [t.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/transfers/:id", requireAuth, requireWarehouses, async (req, res, next) => {
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
    try {
      const row = await withTransaction(db, async () => {
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
        return db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [t.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/transfers/:id", requireAuth, requireWarehouses, async (req, res, next) => {
    const t = await db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    if (!t) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (t.status === "posted") return res.status(400).json({ error: "لا يمكن حذف تحويل مرحّل", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM warehouse_transfers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
