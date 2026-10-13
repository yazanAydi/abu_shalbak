import { Router } from "express";
import { requireAuth, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { effectiveInventoryDay } from "../utils/businessDay.js";
import { getAppSettings } from "../utils/settings.js";
import { listLimitSql } from "../utils/listQuery.js";
import { withTransaction } from "../utils/dbTx.js";
import { listWarehouseStock, resolveWarehouseCatalog } from "../utils/warehouseInventory.js";
import { getWarehouseValuationReport } from "../utils/warehouseValuationHistory.js";
import { interpretExpiryInput } from "../utils/expiryDate.js";
import { recordBatchAllocation } from "../services/stockBatchService.js";
import { listReturnsWarehouseLots } from "../services/stockSourceService.js";
import {
  applyPostedTransfer,
  expiredOnMain,
  listWarehouseSources,
  operationalWarehouses,
  reconcileProductLocations,
} from "../services/warehouseBatchStock.js";

const OPERATIONAL_TYPES = ["main", "returns"];

function normalizeTransferItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("أصناف مطلوبة");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  const norm = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const q = Number(it.quantity);
    if (!pid || !Number.isFinite(q) || q <= 0) {
      const err = new Error("كمية غير صالحة");
      err.status = 400;
      err.code = "VALIDATION_ERROR";
      throw err;
    }
    const parsed = interpretExpiryInput(it.expiry_date);
    if (!parsed.ok) {
      const err = new Error("تاريخ الصلاحية غير صالح");
      err.status = 400;
      err.code = "INVALID_EXPIRY";
      throw err;
    }
    let batchSource = it.batch_source == null || String(it.batch_source).trim() === ""
      ? null
      : String(it.batch_source).trim();
    if (batchSource && batchSource !== "dated" && batchSource !== "undated") {
      const err = new Error("مصدر الدفعة غير صالح");
      err.status = 400;
      err.code = "VALIDATION_ERROR";
      throw err;
    }
    if (!batchSource && parsed.date) batchSource = "dated";
    const sourceLotId = Number(it.source_lot_id) > 0 ? Number(it.source_lot_id) : null;
    if (batchSource === "undated") {
      norm.push({ product_id: pid, quantity: q, expiry_date: null, batch_source: "undated", source_lot_id: sourceLotId });
    } else if (batchSource === "dated") {
      if (!parsed.date) {
        const err = new Error("تاريخ صلاحية الدفعة غير صالح");
        err.status = 400;
        err.code = "INVALID_EXPIRY";
        throw err;
      }
      norm.push({ product_id: pid, quantity: q, expiry_date: parsed.date, batch_source: "dated", source_lot_id: sourceLotId });
    } else {
      norm.push({ product_id: pid, quantity: q, expiry_date: null, batch_source: null, source_lot_id: sourceLotId });
    }
  }
  return norm;
}

function isBakeryMembership(req) {
  const raw = String(req.query?.membership || req.query?.workspace || "").trim().toLowerCase();
  return raw === "bakery";
}

async function operationalWarehouse(db, id) {
  return db.get(
    `SELECT id FROM warehouses
      WHERE id = ? AND active = 1 AND type IN ('main', 'returns')`,
    [Number(id)]
  );
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
    res.json(await db.all(
      `SELECT * FROM warehouses
        WHERE active = 1 AND type IN ('main', 'returns')
        ORDER BY CASE type WHEN 'main' THEN 0 ELSE 1 END, id`
    ));
  });

  router.post("/", requireAuth, requireWarehouses, async (_req, res) => {
    res.status(400).json({
      error: "المستودعات التشغيلية هي المخزن الرئيسي والمرتجعات فقط",
      code: "WAREHOUSE_NOT_OPERATIONAL",
    });
  });

  router.put("/:id", requireAuth, requireWarehouses, async (req, res, next) => {
    const ex = await db.get("SELECT * FROM warehouses WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (!OPERATIONAL_TYPES.includes(ex.type)) {
      return res.status(400).json({
        error: "لا يمكن إعادة مستودع متقاعد إلى التشغيل",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    const b = req.body || {};
    if (b.type !== undefined && b.type !== ex.type) {
      return res.status(400).json({
        error: "نوع المستودع التشغيلي ثابت",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    if (b.active !== undefined && !b.active) {
      return res.status(400).json({
        error: "لا يمكن إيقاف المخزن الرئيسي أو المرتجعات",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    await db.run(
      "UPDATE warehouses SET name = ?, code = ? WHERE id = ?",
      [
        b.name !== undefined ? String(b.name).trim() : ex.name,
        b.code !== undefined ? (b.code || null) : ex.code,
        req.params.id,
      ]
    );
    res.json(await db.get("SELECT * FROM warehouses WHERE id = ?", [req.params.id]));
  });

  router.delete("/:id", requireAuth, requireWarehouses, async (req, res) => {
    const ex = await db.get("SELECT * FROM warehouses WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    const refs = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM warehouse_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ?) AS docs,
         (SELECT COALESCE(SUM(ABS(quantity)), 0) FROM warehouse_stock WHERE warehouse_id = ?) AS qty`,
      [req.params.id, req.params.id, req.params.id]
    );
    if (OPERATIONAL_TYPES.includes(ex.type) || Number(refs?.docs) > 0 || Number(refs?.qty) > 0.0001) {
      return res.status(400).json({
        error: "لا يمكن حذف مستودع مستخدم أو تشغيلي",
        code: "WAREHOUSE_RETAINED",
      });
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

  router.get("/returns-stock", requireAuth, requireWarehouseReport, async (req, res, next) => {
    const unknownOnly = String(req.query.unknown || "") === "1";
    const supplierId = Number(req.query.supplier_id);
    if (!unknownOnly && !supplierId) {
      return res.status(400).json({ error: "اختر المورد", code: "VALIDATION_ERROR" });
    }
    try {
      const { returns } = await operationalWarehouses(db);
      if (!returns) {
        return res.status(400).json({ error: "مستودع المرتجعات غير موجود", code: "WAREHOUSE_NOT_OPERATIONAL" });
      }
      const catalog = await resolveWarehouseCatalog(db, catalogQuery(req));
      const page = listLimitSql(req.query, 25, req.user?.role);
      res.json(await listReturnsWarehouseLots(db, {
        warehouseId: returns.id,
        supplierId: unknownOnly ? null : supplierId,
        unknownOnly,
        catalogSql: catalog.sql,
        catalogParams: catalog.params,
        limit: page.limit,
        offset: page.offset,
      }));
    } catch (e) {
      next(e);
    }
  });

  // ════════════ Stock valuation report ════════════

  router.get("/valuation", requireAuth, requireWarehouseReport, async (req, res, next) => {
    try {
      const report = await getWarehouseValuationReport(db, {
        ...catalogQuery(req),
        asOf: req.query.as_of,
      });
      if (report.error) return res.status(report.status || 400).json({ error: report.error, code: "VALIDATION_ERROR" });
      res.json(report);
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
      `SELECT i.*, p.name, p.barcode, s.name AS supplier_name, pi.invoice_no
         FROM warehouse_transfer_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN purchase_invoices pi ON pi.id = (
           SELECT purchase_invoice_id FROM stock_source_lots WHERE id = i.source_lot_id
         )
        WHERE i.transfer_id = ?`,
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
    if (!(await operationalWarehouse(db, from)) || !(await operationalWarehouse(db, to))) {
      return res.status(400).json({
        error: "التحويل متاح فقط بين المخزن الرئيسي والمرتجعات",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "أصناف مطلوبة", code: "VALIDATION_ERROR" });
    let norm;
    try {
      norm = normalizeTransferItems(items);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || "VALIDATION_ERROR" });
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
            `INSERT INTO warehouse_transfer_items
               (transfer_id, product_id, quantity, expiry_date, batch_source, source_lot_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ins.lastID, it.product_id, it.quantity, it.expiry_date, it.batch_source, it.source_lot_id || null]
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
    if (!(await operationalWarehouse(db, t.from_warehouse_id)) || !(await operationalWarehouse(db, t.to_warehouse_id))) {
      return res.status(400).json({
        error: "التحويل متاح فقط بين المخزن الرئيسي والمرتجعات",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    const items = await db.all("SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?", [t.id]);
    if (items.length === 0) return res.status(400).json({ error: "لا توجد أصناف", code: "EMPTY" });

    try {
      const row = await withTransaction(db, async () => {
        const resolved = await applyPostedTransfer(db, {
          fromWarehouseId: t.from_warehouse_id,
          toWarehouseId: t.to_warehouse_id,
          items,
        });
        await db.run("DELETE FROM warehouse_transfer_items WHERE transfer_id = ?", [t.id]);
        for (const it of resolved) {
          await db.run(
            `INSERT INTO warehouse_transfer_items
               (transfer_id, product_id, quantity, expiry_date, batch_source, source_lot_id, supplier_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [t.id, it.product_id, it.quantity, it.expiry_date, it.batch_source, it.source_lot_id || null, it.supplier_id || null]
          );
          if (it.legacy) continue;
          const sourceFields = {
            supplier_id: it.supplier_id || null,
            purchase_invoice_id: it.purchase_invoice_id || null,
            purchase_invoice_item_id: it.purchase_invoice_item_id || null,
            source_provenance: it.source_provenance || null,
          };
          await recordBatchAllocation(db, {
            expiry_date: it.expiry_date,
            quantity: it.quantity,
            warehouse_id: t.from_warehouse_id,
            source_lot_id: it.origin_lot_id || null,
            ...sourceFields,
          }, {
            productId: it.product_id,
            direction: "out",
            referenceType: "warehouse_transfer",
            referenceId: t.id,
            warehouseId: t.from_warehouse_id,
          });
          await recordBatchAllocation(db, {
            expiry_date: it.expiry_date,
            quantity: it.quantity,
            warehouse_id: t.to_warehouse_id,
            source_lot_id: it.source_lot_id || null,
            ...sourceFields,
          }, {
            productId: it.product_id,
            direction: "in",
            referenceType: "warehouse_transfer",
            referenceId: t.id,
            warehouseId: t.to_warehouse_id,
          });
        }
        const settings = await getAppSettings(db);
        const inventoryDay = effectiveInventoryDay(
          String(t.transfer_date || "").slice(0, 10),
          new Date().toISOString(),
          settings.business_day_cutoff_hour
        );
        await db.run(
          "UPDATE warehouse_transfers SET status = 'posted', posted_at = datetime('now'), inventory_business_day = ? WHERE id = ?",
          [inventoryDay, t.id]
        );
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
    if (!(await operationalWarehouse(db, from)) || !(await operationalWarehouse(db, to))) {
      return res.status(400).json({
        error: "التحويل متاح فقط بين المخزن الرئيسي والمرتجعات",
        code: "WAREHOUSE_NOT_OPERATIONAL",
      });
    }
    let norm;
    try {
      norm = normalizeTransferItems(items);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || "VALIDATION_ERROR" });
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
            `INSERT INTO warehouse_transfer_items
               (transfer_id, product_id, quantity, expiry_date, batch_source, source_lot_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [t.id, it.product_id, it.quantity, it.expiry_date, it.batch_source, it.source_lot_id || null]
          );
        }
        return db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [t.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.get("/:id/sources", requireAuth, requireWarehouseLookup, async (req, res, next) => {
    const warehouseId = Number(req.params.id);
    const productId = Number(req.query.product_id);
    if (!warehouseId || !productId) {
      return res.status(400).json({ error: "المستودع والصنف مطلوبان", code: "VALIDATION_ERROR" });
    }
    try {
      res.json(await listWarehouseSources(db, warehouseId, productId, {
        supplierId: req.query.supplier_id ? Number(req.query.supplier_id) : null,
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/transfers/expired", requireAuth, requireWarehouses, async (req, res, next) => {
    const { main, returns } = await operationalWarehouses(db);
    if (!main || !returns) {
      return res.status(400).json({ error: "المستودعات التشغيلية غير مكتملة", code: "WAREHOUSE_NOT_OPERATIONAL" });
    }
    let norm;
    try {
      norm = normalizeTransferItems(req.body?.items || []);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code || "VALIDATION_ERROR" });
    }
    try {
      const row = await withTransaction(db, async () => {
        const noRow = await db.get("SELECT MAX(transfer_no) AS mx FROM warehouse_transfers");
        const no = (Number(noRow?.mx) || 0) + 1;
        const ins = await db.run(
          `INSERT INTO warehouse_transfers
             (transfer_no, from_warehouse_id, to_warehouse_id, transfer_date, status, notes, created_by)
           VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
          [no, main.id, returns.id, req.body?.transfer_date || shopTodayYmd(), "نقل المنتهي إلى مرتجعات", req.user.id]
        );
        for (const it of norm) {
          await db.run(
            `INSERT INTO warehouse_transfer_items
               (transfer_id, product_id, quantity, expiry_date, batch_source, source_lot_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ins.lastID, it.product_id, it.quantity, it.expiry_date, it.batch_source, it.source_lot_id || null]
          );
        }
        const items = await db.all("SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?", [ins.lastID]);
        const resolved = await applyPostedTransfer(db, {
          fromWarehouseId: main.id,
          toWarehouseId: returns.id,
          items,
        });
        await db.run("DELETE FROM warehouse_transfer_items WHERE transfer_id = ?", [ins.lastID]);
        for (const it of resolved) {
          await db.run(
            `INSERT INTO warehouse_transfer_items
               (transfer_id, product_id, quantity, expiry_date, batch_source, source_lot_id, supplier_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ins.lastID, it.product_id, it.quantity, it.expiry_date, it.batch_source, it.source_lot_id || null, it.supplier_id || null]
          );
          const sourceFields = {
            supplier_id: it.supplier_id || null,
            purchase_invoice_id: it.purchase_invoice_id || null,
            purchase_invoice_item_id: it.purchase_invoice_item_id || null,
            source_provenance: it.source_provenance || null,
          };
          await recordBatchAllocation(db, {
            expiry_date: it.expiry_date, quantity: it.quantity, warehouse_id: main.id,
            source_lot_id: it.origin_lot_id || null, ...sourceFields,
          }, {
            productId: it.product_id,
            direction: "out",
            referenceType: "warehouse_transfer",
            referenceId: ins.lastID,
            warehouseId: main.id,
          });
          await recordBatchAllocation(db, {
            expiry_date: it.expiry_date, quantity: it.quantity, warehouse_id: returns.id,
            source_lot_id: it.source_lot_id || null, ...sourceFields,
          }, {
            productId: it.product_id,
            direction: "in",
            referenceType: "warehouse_transfer",
            referenceId: ins.lastID,
            warehouseId: returns.id,
          });
        }
        const settings = await getAppSettings(db);
        const inventoryDay = effectiveInventoryDay(
          String(req.body?.transfer_date || shopTodayYmd()).slice(0, 10),
          new Date().toISOString(),
          settings.business_day_cutoff_hour
        );
        await db.run(
          "UPDATE warehouse_transfers SET status = 'posted', posted_at = datetime('now'), inventory_business_day = ? WHERE id = ?",
          [inventoryDay, ins.lastID]
        );
        return db.get("SELECT * FROM warehouse_transfers WHERE id = ?", [ins.lastID]);
      });
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  });

  router.get("/expired-on-main", requireAuth, requireWarehouseLookup, async (req, res, next) => {
    try {
      res.json(await expiredOnMain(db, req.query.product_id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reconcile", requireAuth, requireWarehouses, async (req, res, next) => {
    try {
      const result = await withTransaction(db, async () => reconcileProductLocations(
        db,
        req.body?.product_id,
        req.body?.lines
      ));
      res.json(result);
    } catch (err) {
      next(err);
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
