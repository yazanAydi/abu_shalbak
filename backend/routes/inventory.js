import bcrypt from "bcrypt";
import { createSafeRouter } from "../utils/asyncHandler.js";
import { requireAuth, requireAdmin, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import { recordMovement, applyStockDelta } from "../utils/inventory.js";
import { round2 } from "../utils/tax.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { interpretExpiryInput } from "../utils/expiryDate.js";
import { withTransaction } from "../utils/dbTx.js";
import { listLimitSql } from "../utils/listQuery.js";
import { getZeroAllStockPasswordHash } from "../utils/settings.js";
import { forbidden, conflict } from "../utils/httpError.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import {
  parseCountDepartment,
  classifyCountProduct,
  productFitsCountDepartment,
  countProductMatchSql,
  otherOpenCountForProduct,
} from "../utils/countDepartment.js";
import { resolveBakeryReportCategories } from "../services/bakeryReportService.js";
import { bakeryMembershipSql, parseBakeryKind } from "../utils/bakeryMembership.js";
import { assignDatedQuantityFromUnknown, listPhysicalSources, recordBatchAllocation, applyStockAdjustmentBatches, zeroProductBatchSources, moveUndatedOnMain, applyCountedDatedQuantity } from "../services/stockBatchService.js";
import { operationalWarehouses } from "../services/warehouseBatchStock.js";
import { round6 } from "../utils/purchaseInventoryCost.js";
import { badRequest } from "../utils/httpError.js";
import { listOfficeExpiryReport } from "../services/expiryAlertService.js";
import { assignUnknownSource } from "../services/stockSourceService.js";
const ADJ_TYPES = ["in", "out", "damage", "consumption", "correction"];

function adjustmentDelta(adjustmentType, quantity) {
  const qty = round6(quantity);
  if (adjustmentType === "correction") return qty;
  const sign = ADJ_MOVEMENT[adjustmentType]?.sign;
  if (sign == null) return qty;
  return round6(sign * Math.abs(qty));
}

function readAdjustmentItem(it) {
  const pid = Number(it.product_id);
  const q = Number(it.quantity);
  if (!pid || !Number.isFinite(q) || q === 0) return null;
  const batchSource = it.batch_source == null || String(it.batch_source).trim() === ""
    ? null
    : String(it.batch_source).trim();
  const expiry = it.expiry_date == null || String(it.expiry_date).trim() === ""
    ? null
    : String(it.expiry_date).trim();
  return {
    product_id: pid,
    quantity: q,
    unit_cost: it.unit_cost != null ? round2(Number(it.unit_cost)) : null,
    notes: it.notes || null,
    batch_source: batchSource,
    expiry_date: expiry,
  };
}

async function postAdjustmentLines(db, adj, items, userId) {
  const map = ADJ_MOVEMENT[adj.adjustment_type];
  for (const it of items) {
    const delta = adjustmentDelta(adj.adjustment_type, it.quantity);
    await applyStockAdjustmentBatches(db, {
      productId: it.product_id,
      adjustmentType: adj.adjustment_type,
      delta,
      batchSource: it.batch_source,
      expiryDate: it.expiry_date,
      referenceId: adj.id,
    });
    await recordMovement(db, {
      productId: it.product_id,
      movementType: map.type,
      quantity: delta,
      unitCost: it.unit_cost,
      refType: "stock_adjustment",
      refId: adj.id,
      notes: `تسوية #${adj.adjustment_no ?? adj.id} (${adj.adjustment_type})`,
      userId,
      applyStock: true,
      businessDay: adj.adjustment_date,
    });
  }
}

function sameQty(a, b) {
  return Math.abs(round6(a) - round6(b)) <= 1e-6;
}

function countSourceKey(batchSource, expiryDate) {
  if (batchSource === "dated") {
    const parsed = interpretExpiryInput(expiryDate);
    const date = parsed.ok && parsed.date ? parsed.date : String(expiryDate || "").trim();
    return `dated:${date}`;
  }
  if (batchSource === "undated") return "undated";
  return "product";
}

function normalizeCountEntry(entry) {
  if (entry?.counted_qty === undefined || entry?.counted_qty === null || entry?.counted_qty === "") {
    throw badRequest("الكمية المعدودة مطلوبة", "VALIDATION_ERROR");
  }
  const qty = Number(entry.counted_qty);
  if (!Number.isFinite(qty) || qty < 0) {
    throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
  }
  const parsed = interpretExpiryInput(entry?.expiry_date);
  if (!parsed.ok) throw badRequest("تاريخ الصلاحية غير صالح", "INVALID_EXPIRY");
  const rawSource = entry?.batch_source == null || String(entry.batch_source).trim() === ""
    ? null
    : String(entry.batch_source).trim();
  if (rawSource && rawSource !== "dated" && rawSource !== "undated") {
    throw badRequest("مصدر الدفعة غير صالح", "VALIDATION_ERROR");
  }
  let batchSource = null;
  let expiryDate = null;
  if (rawSource === "undated") {
    if (parsed.date) throw badRequest("المخزون غير المحدد لا يحمل تاريخ صلاحية", "EXPIRY_UNEXPECTED");
    batchSource = "undated";
  } else if (parsed.date) {
    batchSource = "dated";
    expiryDate = parsed.date;
  } else if (rawSource === "dated") {
    throw badRequest("تاريخ الصلاحية غير صالح", "INVALID_EXPIRY");
  }
  return { batchSource, expiryDate, qty, warehouse_id: entry?.warehouse_id };
}

async function saveCountLine(db, sessionId, product, entry) {
  const picture = await listPhysicalSources(db, product.id);
  const batchSource = entry.batchSource;
  const expiryDate = entry.expiryDate;
  const qty = entry.qty;
  if (!batchSource && picture.has_dated_batches) {
    throw badRequest(
      "حدد الدفعة أو المخزون غير المحدد. لا يُختار مصدر تلقائياً",
      "BATCH_SOURCE_REQUIRED"
    );
  }

  let systemQty;
  if (batchSource === "dated") {
    const source = picture.sources.find((row) => row.batch_source === "dated" && row.expiry_date === expiryDate);
    systemQty = source ? Number(source.quantity) || 0 : 0;
  } else if (batchSource === "undated") {
    systemQty = picture.has_dated_batches
      ? Number(picture.unknown_quantity) || 0
      : Number(product.stock) || 0;
  } else {
    systemQty = Number(product.stock) || 0;
  }
  const variance = round6(qty - systemQty);
  const { main } = await operationalWarehouses(db);
  const warehouseId = Number(entry.warehouse_id) || main?.id || null;
  const existing = await db.get(
    `SELECT id FROM stock_count_lines
      WHERE session_id = ? AND product_id = ?
        AND IFNULL(warehouse_id, 0) = ?
        AND IFNULL(batch_source, 'product') = ?
        AND IFNULL(expiry_date, '') = ?`,
    [sessionId, product.id, warehouseId || 0, batchSource || "product", expiryDate || ""]
  );
  if (existing) {
    await db.run(
      "UPDATE stock_count_lines SET system_qty = ?, counted_qty = ?, variance = ?, batch_source = ?, expiry_date = ?, warehouse_id = ? WHERE id = ?",
      [systemQty, qty, variance, batchSource, expiryDate, warehouseId, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO stock_count_lines
         (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date, warehouse_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, product.id, systemQty, qty, variance, batchSource, expiryDate, warehouseId]
    );
  }
}

function requiredCountSources(picture, stock) {
  if (picture.has_dated_batches) return picture.sources || [];
  const qty = Number(stock) || 0;
  if (Math.abs(qty) <= 1e-6) return [];
  return [{ batch_source: "undated", expiry_date: null, quantity: qty }];
}

async function recordCountParts(db, parts, { productId, sessionId, direction }) {
  for (const part of parts) {
    await recordBatchAllocation(db, part, {
      productId,
      direction,
      referenceType: "stock_count",
      referenceId: sessionId,
    });
  }
}
// Maps adjustment type -> ledger movement_type and sign of stock change.
const ADJ_MOVEMENT = {
  in: { type: "adjust_in", sign: 1 },
  out: { type: "adjust_out", sign: -1 },
  damage: { type: "damage", sign: -1 },
  consumption: { type: "consumption", sign: -1 },
  correction: { type: "correction", sign: 1 }, // signed quantity supplied by user
};

export function createInventoryRouter(db) {
  const router = createSafeRouter();
  const requireExpiry = requireReportsPermission(db, "expiry");
  const requireStockCount = requireReportsPermission(db, "stock_count");
  const requireStockOrBakery = requireAnyReportsPermission(db, "stock_count", "bakery_supplies");
  const requireExpiryOrBakery = requireAnyReportsPermission(db, "expiry", "bakery_supplies");
  const requireStockRead = requireAnyReportsPermission(db, "stock_count", "bakery_supplies", "bakery");
  const requireExpiryRead = requireAnyReportsPermission(db, "expiry", "bakery_supplies", "bakery");

  async function membershipProductFilter(req, alias = "p") {
    const raw = String(req.query?.membership || "").trim().toLowerCase();
    if (raw !== "bakery") return { sql: "", params: [] };
    const resolved = await resolveBakeryReportCategories(db);
    const names = (resolved.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
    const kind = parseBakeryKind(req.query?.kind, "workspace");
    return bakeryMembershipSql(names, { alias, kind });
  }

  async function assertCountDepartmentPermission(req, department) {
    if (req.user?.role === "shelves_employee") {
      if (department !== "retail") throw forbidden("صلاحيات غير كافية", "FORBIDDEN");
      return;
    }
    if (department === "bakery") {
      const stock = await userHasAccountantPermission(db, req.user, "stock_count");
      const supplies = await userHasAccountantPermission(db, req.user, "bakery_supplies");
      if (!stock && !supplies) throw forbidden("صلاحيات غير كافية", "FORBIDDEN");
      return;
    }
    if (!(await userHasAccountantPermission(db, req.user, "stock_count"))) {
      throw forbidden("صلاحيات غير كافية", "FORBIDDEN");
    }
  }

  function countWriteDenied(res, session, requested) {
    if (!session) {
      res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
      return true;
    }
    if (!session.department) {
      res.status(409).json({
        error: "هذا الجرد فيه أصناف لا يمكن نسبها لقسم واحد، وبقي دون ترحيل حتى يُحسم.",
        code: "COUNT_DEPARTMENT_UNRESOLVED",
        session_id: session.id,
      });
      return true;
    }
    if (requested && requested !== session.department) {
      res.status(409).json({
        error: "جلسة الجرد لا تطابق القسم المفتوح على الشاشة.",
        code: "COUNT_DEPARTMENT_MISMATCH",
        session_id: session.id,
        department: session.department,
      });
      return true;
    }
    return false;
  }

  function sendCountAuthError(res, err) {
    const status = err?.status || err?.statusCode || 500;
    res.status(status).json({
      error: err.message || "صلاحيات غير كافية",
      code: err.code || "FORBIDDEN",
    });
  }

  function openCountConflict(err) {
    const message = String(err?.message || "");
    return message.includes("idx_sc_open_department")
      || message.includes("UNIQUE constraint failed: stock_count_sessions.department");
  }

  function overlapCountConflict(err) {
    return String(err?.message || "").includes("product is already on another open count");
  }

  // ───── Stock Count Sessions ─────

  router.get("/counts", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const department = parseCountDepartment(req.query?.department);
    if (!department) {
      return res.status(400).json({ error: "حدد قسم الجرد", code: "DEPARTMENT_REQUIRED" });
    }
    try {
      await assertCountDepartmentPermission(req, department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }
    const match = countProductMatchSql(department, "p");
    const rows = await db.all(
      `SELECT sc.*, u.username as created_by_name
       FROM stock_count_sessions sc
       LEFT JOIN users u ON sc.created_by = u.id
       WHERE sc.department = ?
          OR (
            sc.department IS NULL
            AND sc.status IN ('posted', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM stock_count_lines scl
              JOIN products p ON p.id = scl.product_id
              WHERE scl.session_id = sc.id AND ${match.sql}
            )
          )
       ORDER BY sc.created_at DESC LIMIT 100`,
      [department, ...match.params]
    );
    res.json(rows);
  });

  router.post("/counts", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const department = parseCountDepartment(req.body?.department);
    if (!department) {
      return res.status(400).json({ error: "حدد قسم الجرد", code: "DEPARTMENT_REQUIRED" });
    }
    try {
      await assertCountDepartmentPermission(req, department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }
    const open = await db.get(
      "SELECT id FROM stock_count_sessions WHERE status = 'open' AND department = ? LIMIT 1",
      [department]
    );
    if (open) {
      return res.status(400).json({
        error: "يوجد جرد مفتوح لهذا القسم، يرجى إغلاقه أولاً",
        code: "OPEN_COUNT_EXISTS",
        session_id: open.id,
        department,
      });
    }
    try {
      const ins = await db.run(
        "INSERT INTO stock_count_sessions (notes, created_by, department) VALUES (?, ?, ?)",
        [req.body?.notes || null, req.user.id, department]
      );
      const row = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [ins.lastID]);
      res.status(201).json(row);
    } catch (err) {
      if (openCountConflict(err)) {
        const again = await db.get(
          "SELECT id FROM stock_count_sessions WHERE status = 'open' AND department = ? LIMIT 1",
          [department]
        );
        return res.status(400).json({
          error: "يوجد جرد مفتوح لهذا القسم، يرجى إغلاقه أولاً",
          code: "OPEN_COUNT_EXISTS",
          session_id: again?.id || null,
          department,
        });
      }
      return next(err);
    }
  });

  router.get("/counts/:id", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const requested = parseCountDepartment(req.query?.department);
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "الجلسة غير موجودة", code: "NOT_FOUND" });
    if (session.department && requested && requested !== session.department) {
      return res.status(409).json({
        error: "جلسة الجرد لا تطابق القسم المفتوح على الشاشة.",
        code: "COUNT_DEPARTMENT_MISMATCH",
        session_id: session.id,
        department: session.department,
      });
    }
    if (!session.department && session.status === "open") {
      return res.status(409).json({
        error: "هذا الجرد فيه أصناف لا يمكن نسبها لقسم واحد، وبقي دون ترحيل حتى يُحسم.",
        code: "COUNT_DEPARTMENT_UNRESOLVED",
        session_id: session.id,
      });
    }
    const department = session.department || requested;
    if (!department) {
      return res.status(400).json({ error: "حدد قسم الجرد", code: "DEPARTMENT_REQUIRED" });
    }
    try {
      await assertCountDepartmentPermission(req, department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }
    const params = [req.params.id];
    let scopeSql = "";
    if (!session.department) {
      const match = countProductMatchSql(department, "p");
      scopeSql = ` AND ${match.sql}`;
      params.push(...match.params);
    }
    const lines = await db.all(
      `SELECT scl.*, p.name, p.barcode, p.unit,
              COALESCE(p.inventory_scope, 'retail') AS inventory_scope
       FROM stock_count_lines scl
       JOIN products p ON scl.product_id = p.id
       WHERE scl.session_id = ?${scopeSql}
       ORDER BY p.name, scl.id`,
      params
    );
    res.json({
      ...session,
      lines,
      ...(session.department ? {} : { lines_filtered: true }),
    });
  });

  router.post("/counts/:id/lines", requireAuth, (req, res, next) => {
    // Shelf employees scan supermarket counts; office roles need a count permission.
    if (req.user?.role === "shelves_employee") return next();
    return requireStockOrBakery(req, res, next);
  }, async (req, res, next) => {
    const requested = parseCountDepartment(req.body?.department ?? req.query?.department);
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (countWriteDenied(res, session, requested)) return;
    if (session.status !== "open") {
      return res.status(400).json({ error: "لا يمكن تعديل جلسة مغلقة", code: "SESSION_CLOSED" });
    }
    try {
      await assertCountDepartmentPermission(req, session.department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }

    const { product_id } = req.body || {};
    if (!product_id) {
      return res.status(400).json({ error: "product_id و counted_qty مطلوبان", code: "VALIDATION_ERROR" });
    }
    const product = await db.get("SELECT * FROM products WHERE id = ?", [Number(product_id)]);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    try {
      const rawEntries = Array.isArray(req.body?.sources)
        ? req.body.sources
        : [{ batch_source: req.body?.batch_source, expiry_date: req.body?.expiry_date, counted_qty: req.body?.counted_qty, warehouse_id: req.body?.warehouse_id }];
      const entries = rawEntries.map((entry) => normalizeCountEntry(entry));
      const seen = new Set();
      for (const entry of entries) {
        const key = countSourceKey(entry.batchSource, entry.expiryDate);
        if (seen.has(key)) {
          throw badRequest("سطر مكرر لنفس الصنف وتاريخ الصلاحية. لن يُحسب الجرد مرتين", "DUPLICATE_SOURCE");
        }
        seen.add(key);
      }
      const namesWholeProduct = entries.some((entry) => !entry.batchSource);
      if (namesWholeProduct && entries.length !== 1) {
        throw badRequest("لا يُجمع جرد الصنف كاملاً مع جرد الدفعات", "COUNT_SHAPE");
      }
      const clearing = Array.isArray(req.body?.sources) && entries.length === 0;
      await withTransaction(db, async () => {
        const live = await db.get(
          "SELECT status, department FROM stock_count_sessions WHERE id = ?",
          [session.id]
        );
        if (!live || live.status !== "open" || live.department !== session.department) {
          throw conflict("جلسة الجرد لا تطابق القسم المفتوح على الشاشة.", "COUNT_DEPARTMENT_MISMATCH");
        }
        const allowed = productFitsCountDepartment(classifyCountProduct(product), live.department);
        if (!allowed && !clearing) {
          throw badRequest(`الصنف ${product.name || ""} لا يتبع قسم هذا الجرد`, "COUNT_SCOPE");
        }
        if (allowed && !clearing) {
          const other = await otherOpenCountForProduct(db, session.id, product.id);
          if (other) {
            throw conflict(
              "هذا الصنف موجود في جرد مفتوح آخر. لن يُغيَّر المخزون من الجردين معاً.",
              "COUNT_PRODUCT_OVERLAP"
            );
          }
        }
        if (Array.isArray(req.body?.sources) || !allowed) {
          await db.run(
            "DELETE FROM stock_count_lines WHERE session_id = ? AND product_id = ?",
            [session.id, product.id]
          );
        }
        if (allowed) {
          for (const entry of entries) {
            await saveCountLine(db, session.id, product, entry);
          }
        }
      });
    } catch (e) {
      if (overlapCountConflict(e)) {
        return res.status(409).json({
          error: "هذا الصنف موجود في جرد مفتوح آخر. لن يُغيَّر المخزون من الجردين معاً.",
          code: "COUNT_PRODUCT_OVERLAP",
        });
      }
      if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code || "VALIDATION_ERROR" });
      return next(e);
    }
    const updated = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [session.id]);
    const lines = await db.all("SELECT * FROM stock_count_lines WHERE session_id = ?", [session.id]);
    res.json({ ...updated, lines });
  });

  router.post("/counts/:id/post", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const requested = parseCountDepartment(req.body?.department ?? req.query?.department);
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (countWriteDenied(res, session, requested)) return;
    if (session.status !== "open") {
      return res.status(400).json({ error: "الجلسة ليست مفتوحة", code: "SESSION_CLOSED" });
    }
    try {
      await assertCountDepartmentPermission(req, session.department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }

    let postedLines = [];
    try {
      await withTransaction(db, async () => {
        const live = await db.get(
          "SELECT status, department FROM stock_count_sessions WHERE id = ?",
          [session.id]
        );
        if (!live || live.status !== "open" || live.department !== session.department) {
          throw conflict("جلسة الجرد لا تطابق القسم المفتوح على الشاشة.", "COUNT_DEPARTMENT_MISMATCH");
        }
        const lines = await db.all("SELECT * FROM stock_count_lines WHERE session_id = ?", [session.id]);
        if (lines.length === 0) {
          throw badRequest("لا توجد أسطر جرد", "EMPTY_SESSION");
        }
        const seenProducts = new Set();
        for (const line of lines) {
          const product = await db.get(
            "SELECT id, name, inventory_scope FROM products WHERE id = ?",
            [line.product_id]
          );
          if (!productFitsCountDepartment(classifyCountProduct(product), live.department)) {
            throw badRequest(
              `الصنف ${product?.name || line.product_id} لا يتبع قسم هذا الجرد`,
              "COUNT_SCOPE"
            );
          }
          if (seenProducts.has(line.product_id)) continue;
          seenProducts.add(line.product_id);
          const other = await otherOpenCountForProduct(db, session.id, line.product_id);
          if (other) {
            throw conflict(
              "هذا الصنف موجود في جرد مفتوح آخر. لن يُغيَّر المخزون من الجردين معاً.",
              "COUNT_PRODUCT_OVERLAP"
            );
          }
        }
        postedLines = lines;
        const byProduct = new Map();
        for (const line of lines) {
          const list = byProduct.get(line.product_id) || [];
          list.push(line);
          byProduct.set(line.product_id, list);
        }
        for (const [productId, productLines] of byProduct) {
          const picture = await listPhysicalSources(db, productId);
          const product = await db.get("SELECT name, stock FROM products WHERE id = ?", [productId]);
          const name = product?.name || String(productId);
          const productLevel = !picture.has_dated_batches
            && productLines.length === 1
            && !productLines[0].batch_source;
          if (productLevel) {
            const liveStock = Number(product?.stock) || 0;
            const counted = Number(productLines[0].counted_qty);
            const delta = counted - liveStock;
            await db.run(
              "UPDATE stock_count_lines SET system_qty = ?, variance = ? WHERE id = ?",
              [liveStock, delta, productLines[0].id]
            );
            if (delta !== 0) {
              await moveUndatedOnMain(db, productId, delta);
              await applyStockDelta(db, productId, delta, {
                movementType: "count",
                referenceType: "stock_count_session",
                referenceId: session.id,
                userId: req.user.id,
                notes: `جرد #${session.id}`,
              });
            }
            continue;
          }

          const seenKeys = new Set();
          for (const line of productLines) {
            const key = countSourceKey(line.batch_source, line.expiry_date);
            if (seenKeys.has(key)) {
              throw badRequest(
                "سطر مكرر لنفس الصنف وتاريخ الصلاحية. لن يُحسب الجرد مرتين",
                "DUPLICATE_SOURCE"
              );
            }
            seenKeys.add(key);
          }

          const incomplete = `الجرد غير مكتمل للصنف ${name}. سجّل كمية لكل دفعة وللمخزون غير المحدد، بما فيها الصفر.`;
          const stale = `تغير رصيد ${name} منذ حفظ الجرد. حدّث الكميات وأعد الجرد قبل الترحيل.`;
          const matched = new Set();
          for (const source of requiredCountSources(picture, product?.stock)) {
            const key = countSourceKey(source.batch_source, source.expiry_date);
            const line = productLines.find((row) => countSourceKey(row.batch_source, row.expiry_date) === key);
            if (!line) throw badRequest(incomplete, "INCOMPLETE_COUNT");
            if (!sameQty(source.quantity, line.system_qty)) throw badRequest(stale, "STALE_COUNT");
            matched.add(key);
          }
          for (const line of productLines) {
            const key = countSourceKey(line.batch_source, line.expiry_date);
            if (matched.has(key)) continue;
            const parsed = interpretExpiryInput(line.expiry_date);
            if (line.batch_source !== "dated" || !parsed.ok || !parsed.date) {
              throw badRequest(`سطر جرد لا يطابق مصدراً حالياً للصنف ${name}`, "COUNT_SHAPE");
            }
            const live = (picture.sources || []).find(
              (row) => row.batch_source === "dated" && row.expiry_date === parsed.date
            );
            if (!sameQty(live ? Number(live.quantity) || 0 : 0, line.system_qty)) {
              throw badRequest(stale, "STALE_COUNT");
            }
          }

          const undatedLine = productLines.find((line) => line.batch_source === "undated");
          const undatedPrev = undatedLine
            ? (picture.has_dated_batches ? Number(picture.unknown_quantity) || 0 : Number(product?.stock) || 0)
            : 0;
          const undatedNext = undatedLine ? round6(undatedLine.counted_qty) : undatedPrev;
          let undatedBudget = round6(Math.max(0, undatedPrev - undatedNext));
          let fundedTotal = 0;
          let countedTotal = 0;
          for (const line of productLines) {
            countedTotal = round6(countedTotal + round6(line.counted_qty));
            if (line.batch_source !== "dated") continue;
            const applied = await applyCountedDatedQuantity(
              db,
              productId,
              line.expiry_date,
              line.counted_qty,
              { fundFromUndated: undatedBudget }
            );
            undatedBudget = round6(Math.max(0, undatedBudget - (applied.funded || 0)));
            fundedTotal = round6(fundedTotal + (applied.funded || 0));
            await db.run("UPDATE stock_count_lines SET variance = ? WHERE id = ?", [applied.delta, line.id]);
            if (applied.delta !== 0) {
              const rows = applied.parts?.length
                ? applied.parts
                : [{ expiry_date: applied.expiry_date, quantity: Math.abs(applied.delta) }];
              await recordCountParts(db, rows, {
                productId,
                sessionId: session.id,
                direction: applied.delta > 0 ? "in" : "out",
              });
            }
          }
          if (undatedLine) {
            const rawDelta = round6(undatedNext - undatedPrev);
            const warehouseDelta = round6(rawDelta + fundedTotal);
            await db.run("UPDATE stock_count_lines SET variance = ? WHERE id = ?", [rawDelta, undatedLine.id]);
            let parts = [];
            if (warehouseDelta !== 0) parts = (await moveUndatedOnMain(db, productId, warehouseDelta)) || [];
            if (rawDelta !== 0) {
              const covered = round6(parts.reduce((sum, part) => sum + (Number(part.quantity) || 0), 0));
              const rows = [...parts];
              const missing = round6(Math.abs(rawDelta) - covered);
              if (missing > 1e-9) rows.push({ expiry_date: null, quantity: missing });
              await recordCountParts(db, rows, {
                productId,
                sessionId: session.id,
                direction: rawDelta > 0 ? "in" : "out",
              });
            }
          }
          const stockDelta = round6(countedTotal - (Number(product?.stock) || 0));
          if (stockDelta !== 0) {
            await applyStockDelta(db, productId, stockDelta, {
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
      });
      await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_COUNT, "stock_count_sessions", session.id, { status: "open" }, { status: "posted", lines: postedLines.length });
    } catch (e) {
      return next(e);
    }

    const updated = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [session.id]);
    res.json(updated);
  });

  router.delete("/counts/:id", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const requested = parseCountDepartment(req.body?.department ?? req.query?.department);
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (countWriteDenied(res, session, requested)) return;
    try {
      await assertCountDepartmentPermission(req, session.department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }
    if (session.status === "posted") {
      return res.status(400).json({ error: "لا يمكن حذف جلسة مرحّلة", code: "ALREADY_POSTED" });
    }
    const removed = await db.run(
      "DELETE FROM stock_count_sessions WHERE id = ? AND status != 'posted'",
      [session.id]
    );
    if (!Number(removed?.changes)) {
      return res.status(400).json({ error: "لا يمكن حذف جلسة مرحّلة", code: "ALREADY_POSTED" });
    }
    res.json({ success: true, id: session.id, department: session.department });
  });

  router.post("/counts/:id/cancel", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const requested = parseCountDepartment(req.body?.department ?? req.query?.department);
    const session = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [req.params.id]);
    if (countWriteDenied(res, session, requested)) return;
    try {
      await assertCountDepartmentPermission(req, session.department);
    } catch (err) {
      if (err?.status) return sendCountAuthError(res, err);
      return next(err);
    }
    if (session.status !== "open") {
      return res.status(400).json({ error: "الجلسة ليست مفتوحة", code: "SESSION_CLOSED" });
    }
    const cancelled = await db.run(
      "UPDATE stock_count_sessions SET status = 'cancelled' WHERE id = ? AND status = 'open'",
      [session.id]
    );
    if (!Number(cancelled?.changes)) {
      return res.status(400).json({ error: "الجلسة ليست مفتوحة", code: "SESSION_CLOSED" });
    }
    const updated = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [session.id]);
    res.json(updated);
  });

  // ───── Zero all product stock (from الجرد) ─────

  router.post("/zero-all-stock", requireAuth, requireAdmin, requireStockCount, async (req, res, next) => {
    try {
      const hash = await getZeroAllStockPasswordHash(db);
      if (hash) {
        const password =
          req.body?.confirm_password ??
          req.headers["x-confirm-password"] ??
          "";
        if (!(await bcrypt.compare(String(password), hash))) {
          throw forbidden("كلمة المرور غير صحيحة", "INVALID_CREDENTIALS");
        }
      }

      let productsZeroed = 0;
      let skipped = 0;
      await withTransaction(db, async () => {
        const products = await db.all("SELECT id, stock FROM products");
        for (const p of products) {
          const stock = round6(Number(p.stock) || 0);
          const batchesChanged = await zeroProductBatchSources(db, p.id);
          if (stock === 0 && !batchesChanged) {
            skipped += 1;
            continue;
          }
          if (stock !== 0) {
            await applyStockDelta(db, p.id, -stock, {
              movementType: "count",
              referenceType: "zero_all_stock",
              userId: req.user.id,
              notes: "تصفير كل الكميات",
            });
          }
          productsZeroed += 1;
        }
      });
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.INVENTORY_COUNT,
        "products",
        null,
        null,
        { products_zeroed: productsZeroed, skipped }
      );

      res.json({ products_zeroed: productsZeroed, skipped });
    } catch (e) {
      return next(e);
    }
  });

  router.post("/source-lots/assign", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const result = await withTransaction(db, async () => assignUnknownSource(db, {
        sourceLotId: req.body?.source_lot_id,
        supplierId: req.body?.supplier_id,
        purchaseInvoiceItemId: req.body?.purchase_invoice_item_id,
        quantity: req.body?.quantity,
        userId: req.user?.id,
        note: req.body?.note,
      }));
      await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "stock_source_lots", result.to_lot_id, null, result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ───── Expiry Reports ─────

  router.get("/expiry", requireAuth, requireExpiryRead, async (req, res, next) => {
    try {
    const membership = await membershipProductFilter(req, "p");
    const page = listLimitSql(req.query, 500);
    const rows = await listOfficeExpiryReport(db, {
      days: req.query.days,
      membershipSql: membership.sql,
      membershipParams: membership.params,
      limit: page.limit,
      offset: page.offset,
    });
    res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ───── Stock Adjustments ─────

  router.get("/adjustments", requireAuth, requireStockOrBakery, async (_req, res) => {
    const rows = await db.all(
      `SELECT a.*, u.username AS created_by_name,
              (SELECT COUNT(*) FROM stock_adjustment_items ai WHERE ai.adjustment_id = a.id) AS item_count
       FROM stock_adjustments a LEFT JOIN users u ON u.id = a.created_by
       ORDER BY a.created_at DESC LIMIT 200`
    );
    res.json(rows);
  });

  router.get("/adjustments/:id", requireAuth, requireStockOrBakery, async (req, res) => {
    const adj = await db.get(
      `SELECT a.*, COALESCE(NULLIF(TRIM(e.name), ''), u.username) AS created_by_name
       FROM stock_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN employees e ON e.user_id = a.created_by
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!adj) return res.status(404).json({ error: "التسوية غير موجودة", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT ai.*, p.name, p.barcode, p.sku, p.unit FROM stock_adjustment_items ai
       JOIN products p ON p.id = ai.product_id WHERE ai.adjustment_id = ?`,
      [adj.id]
    );
    res.json({ ...adj, items });
  });

  router.post("/adjustments", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const { adjustment_type, adjustment_date, notes, items, post } = req.body || {};
    if (!ADJ_TYPES.includes(adjustment_type)) {
      return res.status(400).json({ error: "نوع التسوية غير صالح", code: "VALIDATION_ERROR" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "أصناف التسوية مطلوبة", code: "VALIDATION_ERROR" });
    }
    const norm = [];
    for (const it of items) {
      const row = readAdjustmentItem(it);
      if (!row) return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      norm.push(row);
    }

    try {
      const row = await withTransaction(db, async () => {
        const noRow = await db.get("SELECT MAX(adjustment_no) AS mx FROM stock_adjustments");
        const no = (Number(noRow?.mx) || 0) + 1;
        const documentDate = adjustment_date || shopTodayYmd();
        const ins = await db.run(
          `INSERT INTO stock_adjustments (adjustment_no, adjustment_date, adjustment_type, status, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [no, documentDate, adjustment_type, post ? "posted" : "draft", notes || null, req.user.id]
        );
        const adjId = ins.lastID;
        for (const it of norm) {
          await db.run(
            `INSERT INTO stock_adjustment_items
               (adjustment_id, product_id, quantity, unit_cost, notes, batch_source, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [adjId, it.product_id, it.quantity, it.unit_cost, it.notes, it.batch_source, it.expiry_date]
          );
        }
        if (post) {
          const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adjId]);
          const stored = await db.all("SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?", [adjId]);
          await postAdjustmentLines(db, adj, stored, req.user.id);
          await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "stock_adjustments", adjId, null, { adjustment_no: no, type: adjustment_type });
        }
        return db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adjId]);
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  router.post("/adjustments/:id/post", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "التسوية غير موجودة", code: "NOT_FOUND" });
    if (adj.status === "posted") return res.status(400).json({ error: "مرحّلة بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?", [adj.id]);
    try {
      const row = await withTransaction(db, async () => {
        const fresh = await db.get("SELECT status FROM stock_adjustments WHERE id = ?", [adj.id]);
        if (fresh?.status === "posted") {
          throw badRequest("مرحّلة بالفعل", "ALREADY_POSTED");
        }
        await postAdjustmentLines(db, adj, items, req.user.id);
        await db.run("UPDATE stock_adjustments SET status = 'posted', posted_at = datetime('now') WHERE id = ?", [adj.id]);
        await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "stock_adjustments", adj.id, { status: "draft" }, { status: "posted" });
        return db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adj.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/adjustments/:id", requireAuth, requireStockOrBakery, async (req, res, next) => {
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
      const row = readAdjustmentItem(it);
      if (!row) return res.status(400).json({ error: "كمية غير صالحة", code: "VALIDATION_ERROR" });
      norm.push(row);
    }

    try {
      const row = await withTransaction(db, async () => {
        await db.run(
          `UPDATE stock_adjustments SET adjustment_type = ?, adjustment_date = ?, notes = ? WHERE id = ?`,
          [adjustment_type, adjustment_date || adj.adjustment_date, notes || null, adj.id]
        );
        await db.run("DELETE FROM stock_adjustment_items WHERE adjustment_id = ?", [adj.id]);
        for (const it of norm) {
          await db.run(
            `INSERT INTO stock_adjustment_items
               (adjustment_id, product_id, quantity, unit_cost, notes, batch_source, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [adj.id, it.product_id, it.quantity, it.unit_cost, it.notes, it.batch_source, it.expiry_date]
          );
        }
        return db.get("SELECT * FROM stock_adjustments WHERE id = ?", [adj.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/adjustments/:id", requireAuth, requireStockOrBakery, async (req, res) => {
    const adj = await db.get("SELECT * FROM stock_adjustments WHERE id = ?", [req.params.id]);
    if (!adj) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (adj.status === "posted") return res.status(400).json({ error: "لا يمكن حذف تسوية مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM stock_adjustments WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Movement ledger ─────

  router.get("/movements", requireAuth, requireStockRead, async (req, res, next) => {
    try {
    const { product_id, type, from, to, scope } = req.query;
    const membership = await membershipProductFilter(req, "p");
    let sql = `SELECT m.id, m.product_id, m.movement_type, m.quantity_delta AS quantity,
                      m.qty_before, m.qty_after, m.reference_type AS ref_type, m.reference_id AS ref_id,
                      m.notes, m.user_id AS created_by, m.created_at,
                      p.name AS product_name, p.barcode, u.username AS created_by_name
               FROM inventory_ledger m
               JOIN products p ON p.id = m.product_id
               LEFT JOIN users u ON u.id = m.user_id WHERE 1=1`;
    const params = [];
    if (product_id) { sql += " AND m.product_id = ?"; params.push(Number(product_id)); }
    if (type) { sql += " AND m.movement_type = ?"; params.push(type); }
    if (from) { sql += " AND date(m.created_at) >= ?"; params.push(from); }
    if (to) { sql += " AND date(m.created_at) <= ?"; params.push(to); }
    if (membership.sql) {
      sql += membership.sql;
      params.push(...membership.params);
    } else if (scope === "bakery" || scope === "retail") {
      sql += " AND COALESCE(p.inventory_scope, 'retail') = ?";
      params.push(scope);
    }
    sql += " ORDER BY m.created_at DESC, m.id DESC LIMIT 500";
    res.json(await db.all(sql, params));
    } catch (e) {
      next(e);
    }
  });

  // ───── Product batches (batch + expiry tracking) ─────

  router.get("/batches", requireAuth, requireStockRead, async (req, res, next) => {
    try {
    const { product_id } = req.query;
    const membership = await membershipProductFilter(req, "p");
    let sql = `SELECT b.*, p.name AS product_name, p.barcode,
                 CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
               FROM product_batches b JOIN products p ON p.id = b.product_id WHERE 1=1`;
    const params = [];
    if (product_id) { sql += " AND b.product_id = ?"; params.push(Number(product_id)); }
    if (membership.sql) {
      sql += membership.sql;
      params.push(...membership.params);
    }
    sql += " ORDER BY b.expiry_date IS NULL, b.expiry_date ASC LIMIT 500";
    res.json(await db.all(sql, params));
    } catch (e) {
      next(e);
    }
  });

  router.post("/batches", requireAuth, requireStockOrBakery, async (req, res, next) => {
    const { product_id, batch_no, expiry_date, quantity, cost, notes } = req.body || {};
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: "المنتج مطلوب", code: "VALIDATION_ERROR" });
    try {
      const row = await withTransaction(db, () =>
        assignDatedQuantityFromUnknown(db, {
          productId: pid,
          expiryDate: expiry_date,
          quantity,
          cost: cost != null && cost !== "" ? round2(Number(cost)) : null,
          batchNo: batch_no,
          notes,
        })
      );
      res.status(201).json(row);
    } catch (e) {
      if (e?.status) {
        return res.status(e.status).json({ error: e.message, code: e.code, available: e.available });
      }
      next(e);
    }
  });

  router.get("/stock-sources", requireAuth, requireStockRead, async (req, res, next) => {
    try {
      const productId = Number(req.query.product_id);
      if (!productId) return res.status(400).json({ error: "المنتج مطلوب", code: "VALIDATION_ERROR" });
      const product = await db.get(
        "SELECT id, name, barcode, stock, unit, expiry_date FROM products WHERE id = ?",
        [productId]
      );
      if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
      const picture = await listPhysicalSources(db, productId);
      const productExpiry = interpretExpiryInput(product.expiry_date);
      res.json({
        ...picture,
        name: product.name,
        barcode: product.barcode,
        unit: product.unit,
        product_expiry_date: productExpiry.ok ? productExpiry.date : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/batches/:id", requireAuth, requireStockOrBakery, async (req, res, next) => {
    try {
      const row = await db.get("SELECT * FROM product_batches WHERE id = ?", [req.params.id]);
      if (!row) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      if (round6(row.quantity) > 1e-9) {
        return res.status(400).json({
          error: "لا يمكن حذف دفعة ما زالت فيها كمية. استخدم سند إخراج أو جرداً لإخراج الكمية أولاً.",
          code: "BATCH_HAS_QUANTITY",
        });
      }
      const history = await db.get(
        `SELECT COUNT(*) AS n FROM stock_batch_allocations
          WHERE product_id = ? AND IFNULL(expiry_date, '') = IFNULL(?, '')`,
        [row.product_id, row.expiry_date]
      );
      if (Number(history?.n) > 0) {
        return res.status(400).json({
          error: "لا يمكن حذف دفعة مرتبطة بسجل حركة. أبقِ السطر حتى يبقى السجل مقروءاً.",
          code: "BATCH_HAS_HISTORY",
        });
      }
      await db.run("DELETE FROM product_batches WHERE id = ?", [row.id]);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });

  router.get("/adjustment-types", requireAuth, (_req, res) => {
    res.json({
      types: ADJ_TYPES,
      labels: { in: "إدخال مخزون", out: "إخراج مخزون", damage: "تالف", consumption: "استهلاك", correction: "تصحيح" },
    });
  });

  // ───── Low Stock ─────

  router.get("/low-stock", requireAuth, requireExpiryRead, async (req, res, next) => {
    try {
    const { threshold = 10, scope } = req.query;
    const t = Math.max(0, Number(threshold) || 10);
    const membership = await membershipProductFilter(req, "");
    let sql = `SELECT id, barcode, sku, name, unit, stock, category, min_stock,
                      COALESCE(inventory_scope, 'retail') AS inventory_scope
               FROM products WHERE (
                 (min_stock IS NOT NULL AND stock <= min_stock)
                 OR (min_stock IS NULL AND stock <= ?)
               )`;
    const params = [t];
    if (membership.sql) {
      sql += membership.sql;
      params.push(...membership.params);
    } else if (scope === "bakery" || scope === "retail") {
      sql += " AND COALESCE(inventory_scope, 'retail') = ?";
      params.push(scope);
    }
    sql += " ORDER BY stock ASC, name";
    sql += listLimitSql(req.query, 500).sql;
    const rows = await db.all(sql, params);
    res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ───── Negative Stock (oversold) ─────
  // Negative stock is allowed by design (selling below zero is permitted).
  // This report lets managers see which products were oversold so they can
  // reconcile/restock. It does NOT block or clamp anything.
  router.get("/negative-stock", requireAuth, requireStockCount, async (req, res) => {
    const rows = await db.all(
      `SELECT id, barcode, name, unit, stock, category
       FROM products WHERE COALESCE(stock, 0) < 0 ORDER BY stock ASC, name${listLimitSql(req.query, 500).sql}`
    );
    // count stays the true total even when the row list is capped.
    const totalRow = await db.get(
      "SELECT COUNT(*) AS c FROM products WHERE COALESCE(stock, 0) < 0"
    );
    res.json({ count: Number(totalRow?.c) || 0, products: rows });
  });

  return router;
}
