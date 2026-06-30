import { Router } from "express";
import bcrypt from "bcrypt";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { isValidRole, USER_ROLES } from "../utils/roles.js";
import {
  csvBufferToRecords,
  normalizeProductRow,
  xlsxBufferToHeaderRows,
  DEBUG_IMPORT_PRODUCT_NAME,
  DEBUG_BARCODE,
} from "../utils/productImport.js";
import { detectFromBuffer } from "../utils/importDetect.js";
import { importUploadMiddleware, requireImportFile } from "../utils/importUpload.js";
import { importPriceListFromBuffer } from "../utils/priceListImport.js";
import {
  handleCustomerBalanceUpload,
  handleSupplierBalanceUpload,
  handleSupplierBalancePreview,
  handleSupplierBalanceConfirm,
} from "./hesabatiUploadHandlers.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { assignEntityCodeIfMissing, ensureEntityCode, renumberAllEntityCodesBatch } from "../utils/entityCodes.js";
import { createBackup } from "../utils/backup.js";
import { syncProductsPrimaryBarcode } from "../utils/productBarcodes.js";
import { persistProductImportRows } from "../utils/productUnitsImport.js";
import { repairProductUnitPrices } from "../utils/productUnits.js";
import { looksLikePackOnlyProduct } from "../utils/unitNames.js";
import { digitsOnly, normalizeBarcodeInput } from "../utils/barcode.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Prefer primary-barcode matches before unit-barcode aliases (avoids wrong product merge).
 * @param {object} db
 * @param {string} primaryBc
 * @param {{ barcode: string }[]} barcodes
 */
async function resolveImportProductId(db, primaryBc, barcodes) {
  const primary = String(primaryBc ?? "").trim();

  if (primary) {
    const fromProducts = await db.get(
      `SELECT id AS product_id FROM products WHERE CAST(barcode AS TEXT) = ?`,
      [primary]
    );
    if (fromProducts) return fromProducts.product_id;

    const fromPrimaryPb = await db.get(
      `SELECT product_id FROM product_barcodes WHERE barcode = ? AND is_primary = 1`,
      [primary]
    );
    if (fromPrimaryPb) return fromPrimaryPb.product_id;
  }

  for (const { barcode: bc } of barcodes) {
    const hit = await db.get(
      `SELECT pb.product_id FROM product_barcodes pb WHERE pb.barcode = ?`,
      [bc]
    );
    if (hit) return hit.product_id;
  }

  for (const { barcode: bc } of barcodes) {
    const hit = await db.get(
      `SELECT id AS product_id FROM products WHERE CAST(barcode AS TEXT) = ?`,
      [bc]
    );
    if (hit) return hit.product_id;
  }

  return null;
}

/**
 * @param {object} db
 * @param {string} primaryBc
 * @param {number} productId
 */
async function findPrimaryBarcodeOwner(db, primaryBc, productId) {
  const primary = String(primaryBc ?? "").trim();
  if (!primary) return null;
  return db.get(
    `SELECT id, name FROM products WHERE CAST(barcode AS TEXT) = ? AND id != ?`,
    [primary, productId]
  );
}

export function createAdminRouter(db, dbPath) {
  const router = Router();

  router.use(requireAuth, requireAdmin);

  router.post("/import/detect", importUploadMiddleware(), async (req, res) => {
    const file = requireImportFile(req, res);
    if (!file) return;
    try {
      const detected = detectFromBuffer(file.buffer, file.originalname || "");
      res.json({ success: true, ...detected });
    } catch (e) {
      res.status(400).json({ error: e.message || "فشل تحليل الملف" });
    }
  });

  router.post("/customers/upload", importUploadMiddleware(), async (req, res) => {
    await handleCustomerBalanceUpload(db, req, res);
  });

  router.post("/suppliers/upload", importUploadMiddleware(), async (req, res) => {
    await handleSupplierBalanceUpload(db, req, res);
  });

  router.post("/import/supplier-balances/preview", importUploadMiddleware(), async (req, res) => {
    await handleSupplierBalancePreview(db, req, res);
  });

  router.post("/import/supplier-balances/confirm", importUploadMiddleware(), async (req, res) => {
    await handleSupplierBalanceConfirm(db, req, res);
  });

  router.post(
    "/products/upload",
    importUploadMiddleware(),
    async (req, res, next) => {
    const file = requireImportFile(req, res);
    if (!file) return;

    const name = String(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "");
    const isXlsx =
      name.endsWith(".xlsx") ||
      mime ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    if (isXlsx) {
      const detected = detectFromBuffer(file.buffer, file.originalname || "");
      if (detected.type === "hesabati_price_list") {
        try {
          const summary = await importPriceListFromBuffer(db, file.buffer, file.originalname || "");
          await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_UPDATE, "products", null, null, {
            import_type: summary.type,
            updated: summary.updated,
            created: summary.created,
          });
          return res.json({ success: true, ...summary });
        } catch (e) {
          return res.status(400).json({ error: e.message || "فشل استيراد قائمة الأسعار" });
        }
      }
    }

    let records;
    try {
      if (isXlsx) {
        records = xlsxBufferToHeaderRows(file.buffer);
      } else {
        records = csvBufferToRecords(file.buffer);
      }
    } catch (e) {
      return res.status(400).json({
        error: isXlsx ? "فشل تحليل ملف Excel" : "فشل تحليل ملف CSV",
        detail: e.message,
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "لا توجد صفوف بيانات" });
    }

    const errors = [];
    let products_created = 0;
    let products_updated = 0;
    let barcodes_added = 0;
    let duplicate_barcodes_skipped = 0;
    let short_internal_codes_added = 0;
    let scientific_notation_cells_detected = 0;
    let rows_no_barcode_found = 0;
    let skipped = 0;
    /** @type {{ row: number, barcode: string, existing_product_id: number, existing_product_name: string }[]} */
    const barcode_conflicts = [];

    const seenInFile = new Set();

    /** @type {{ rowNum: number, row: object }[]} */
    const validRows = [];
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const norm = normalizeProductRow(row);
      const rowNum = i + 2;

      if (!norm.ok) {
        if (norm.noBarcode) rows_no_barcode_found++;
        scientific_notation_cells_detected += Number(row._scientificCellsDetected) || 0;
        console.info(
          `[import] row=${rowNum} name="${row.name ?? ""}" rawCells=${JSON.stringify(norm._barcodeRawCells ?? row._barcodeRawCells ?? [])} extracted=${JSON.stringify(norm._barcodesExtracted ?? [])} skipped=validation reason="${norm.reason}"`
        );
        errors.push({ row: rowNum, reason: norm.reason });
        skipped++;
        continue;
      }

      scientific_notation_cells_detected += norm.row.scientificCellsDetected || 0;

      /** @type {{ barcode: string, label: string | null, is_primary?: boolean }[]} */
      const rowBarcodes = norm.row.barcodes;
      const filteredBarcodes = [];
      for (const entry of rowBarcodes) {
        const bc = String(entry.barcode ?? "").trim();
        if (!bc) continue;
        if (seenInFile.has(bc)) {
          errors.push({
            row: rowNum,
            barcode: bc,
            reason: "باركود مكرر في الملف — تُركت أول مرة",
          });
          continue;
        }
        filteredBarcodes.push({ ...entry, barcode: bc });
      }

      if (filteredBarcodes.length === 0) {
        const primaryBc = digitsOnly(normalizeBarcodeInput(norm.row.barcode));
        if (primaryBc && seenInFile.has(primaryBc) && looksLikePackOnlyProduct(norm.row.name)) {
          validRows.push({
            rowNum,
            row: {
              ...norm.row,
              barcodes: [{ barcode: primaryBc, label: null, is_primary: true }],
              _packLinkRow: true,
            },
          });
        } else {
          skipped++;
        }
        continue;
      }

      for (const { barcode: bc } of filteredBarcodes) {
        seenInFile.add(bc);
      }
      validRows.push({
        rowNum,
        row: { ...norm.row, barcodes: filteredBarcodes },
      });
    }

    /** @type {Awaited<ReturnType<typeof persistProductImportRows>> | null} */
    let importResult = null;
    try {
      await db.run("BEGIN IMMEDIATE");
      importResult = await persistProductImportRows(db, validRows);
      products_created = importResult.products_created;
      products_updated = importResult.products_updated;
      barcodes_added = importResult.barcodes_added;
      duplicate_barcodes_skipped = importResult.duplicate_barcodes_skipped;
      barcode_conflicts.push(...importResult.barcode_conflicts);
      if (importResult.row_errors?.length) {
        errors.push(...importResult.row_errors);
        skipped += importResult.row_errors.length;
      }
      await db.run("COMMIT");
    } catch (e) {
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
      return next(e);
    }

    const inserted = products_created;
    res.json({
      success: true,
      inserted,
      products_created,
      products_updated,
      units_upserted: importResult?.units_upserted ?? 0,
      needs_review_count: importResult?.needs_review_count ?? 0,
      absorbed_rows: importResult?.absorbed_rows ?? 0,
      barcodes_added,
      short_internal_codes_added,
      scientific_notation_cells_detected,
      rows_no_barcode_found,
      duplicate_barcodes_skipped,
      barcode_conflicts,
      skipped,
      errors,
      message: `تم استيراد ${products_created} منتجاً جديداً وتحديث ${products_updated} — ${importResult?.units_upserted ?? 0} وحدة`,
    });
    }
  );

  router.post("/products/repair-unit-prices", async (_req, res, next) => {
    try {
      const result = await repairProductUnitPrices(db);
      res.json({
        success: true,
        updated: result.updated,
        needs_review_count: result.needs_review_count,
        message: `تم تحديث ${result.updated} وحدة`,
      });
    } catch (e) {
      next(e);
    }
  });

  // Delete a product while preserving all related history rows (sales,
  // inventory, purchases, etc.). Those child rows reference products(id) and
  // most are NOT NULL, so we drop the product with foreign-key enforcement
  // temporarily disabled, leaving the historical records intact. FK enforcement
  // is per-connection, so we always restore it in `finally`.
  router.delete("/products/:id", async (req, res, next) => {
    try {
      const existing = await db.get("SELECT * FROM products WHERE id = ?", [req.params.id]);
      if (!existing) return res.status(404).json({ error: "غير موجود" });
      let info;
      await db.exec("PRAGMA foreign_keys = OFF;");
      try {
        info = await db.run("DELETE FROM products WHERE id = ?", [req.params.id]);
      } finally {
        await db.exec("PRAGMA foreign_keys = ON;");
      }
      if (info.changes === 0) return res.status(404).json({ error: "غير موجود" });
      await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_DELETE, "products", req.params.id, existing, null);
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  // Bulk delete used by the "delete selected" / "delete all" buttons. Done in a
  // single request (with FK enforcement disabled once) to avoid racy per-request
  // PRAGMA toggling on the shared connection. Related history rows are kept.
  router.post("/products/bulk-delete", async (req, res, next) => {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) {
      return res.status(400).json({ error: "لا توجد منتجات للحذف" });
    }
    try {
      const placeholders = ids.map(() => "?").join(",");
      const existingRows = await db.all(
        `SELECT * FROM products WHERE id IN (${placeholders})`,
        ids
      );
      let deleted = 0;
      await db.exec("PRAGMA foreign_keys = OFF;");
      try {
        await db.exec("BEGIN");
        for (const id of ids) {
          const info = await db.run("DELETE FROM products WHERE id = ?", [id]);
          deleted += info.changes;
        }
        await db.exec("COMMIT");
      } catch (e) {
        await db.exec("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        await db.exec("PRAGMA foreign_keys = ON;");
      }
      for (const row of existingRows) {
        await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_DELETE, "products", row.id, row, null);
      }
      res.json({ success: true, deleted });
    } catch (e) {
      next(e);
    }
  });

  router.get("/roles", (_req, res) => {
    res.json({ roles: USER_ROLES });
  });

  router.get("/users", async (_req, res) => {
    const rows = await db.all(
      "SELECT id, username, role, created_at FROM users ORDER BY username"
    );
    res.json(rows);
  });

  router.post("/users", async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username?.trim() || !password || !role) {
      return res.status(400).json({ error: "اسم المستخدم وكلمة المرور والدور مطلوبة" });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ error: "دور غير صالح", allowed: USER_ROLES });
    }
    const hash = await bcrypt.hash(String(password), 10);
    try {
      const info = await db.run(
        "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
        [String(username).trim(), hash, role]
      );
      const row = await db.get(
        "SELECT id, username, role, created_at FROM users WHERE id = ?",
        [info.lastID]
      );
      await logAudit(db, req, AUDIT_ACTIONS.USER_CREATE, "users", row.id, null, { username: row.username, role: row.role });
      res.status(201).json(row);
    } catch (e) {
      if (e && e.code === "SQLITE_CONSTRAINT") {
        return res.status(409).json({ error: "اسم المستخدم موجود مسبقاً" });
      }
      throw e;
    }
  });

  router.patch("/users/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    const ex = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المستخدم غير موجود" });
    const { role, password } = req.body || {};
    if (role === undefined && (password === undefined || String(password) === "")) {
      return res.status(400).json({ error: "مطلوب تعديل الدور و/أو كلمة مرور جديدة" });
    }
    if (role !== undefined) {
      if (!isValidRole(role)) {
        return res.status(400).json({ error: "دور غير صالح", allowed: USER_ROLES });
      }
      if (ex.role === "admin" && role !== "admin") {
        const n = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
        if (n.c <= 1) {
          return res
            .status(400)
            .json({ error: "لا يمكن تغيير دور آخر مدير في النظام" });
        }
      }
    }
    if (role !== undefined) {
      await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    }
    if (password !== undefined && String(password).length > 0) {
      const hash = await bcrypt.hash(String(password), 10);
      await db.run("UPDATE users SET password = ? WHERE id = ?", [hash, id]);
    }
    const row = await db.get("SELECT id, username, role, created_at FROM users WHERE id = ?", [
      id,
    ]);
    await logAudit(db, req, AUDIT_ACTIONS.USER_UPDATE, "users", id, { role: ex.role }, { role: row.role });
    res.json(row);
  });

  router.delete("/users/:id", async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    if (id === req.user.id) {
      return res.status(400).json({ error: "لا يمكنك حذف حسابك" });
    }
    const ex = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (ex.role === "admin") {
      const n = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
      if (n.c <= 1) {
        return res.status(400).json({ error: "لا يمكن حذف آخر مدير في النظام" });
      }
    }
    const tx = await db.get("SELECT COUNT(*) as c FROM transactions WHERE cashier_id = ?", [id]);
    if (tx.c > 0) {
      return res
        .status(400)
        .json({ error: "لا يمكن حذف مستخدم له سجل مبيعات؛ غيّر الدور بدلاً من ذلك" });
    }
    await db.run("DELETE FROM users WHERE id = ?", [id]);
    await logAudit(db, req, AUDIT_ACTIONS.USER_DELETE, "users", id, { username: ex.username, role: ex.role }, null);
    res.status(204).send();
  });

  router.get("/audit-logs", async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const { action, user_id, entity_type, date_from, date_to } = req.query;

      let sql = "SELECT * FROM audit_logs WHERE 1=1";
      const params = [];
      if (action) {
        sql += " AND action = ?";
        params.push(String(action));
      }
      if (user_id) {
        sql += " AND user_id = ?";
        params.push(Number(user_id));
      }
      if (entity_type) {
        sql += " AND entity_type = ?";
        params.push(String(entity_type));
      }
      if (date_from) {
        sql += " AND date(created_at) >= ?";
        params.push(String(date_from));
      }
      if (date_to) {
        sql += " AND date(created_at) <= ?";
        params.push(String(date_to));
      }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const rows = await db.all(sql, params);
      res.json({ rows, limit, offset });
    } catch (e) {
      next(e);
    }
  });

  router.post("/backup", async (req, res, next) => {
    try {
      const resolvedPath =
        dbPath ||
        path.resolve(__dirname, "..", "..", "data", "supermarket.db");
      const result = await createBackup(resolvedPath);
      await logAudit(db, req, AUDIT_ACTIONS.BACKUP_CREATE, "backup", null, null, result);
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post("/renumber-entity-codes", async (req, res, next) => {
    try {
      const raw = req.body?.types ?? req.body?.type ?? "product";
      const types = Array.isArray(raw) ? raw : [raw];
      const counts = await renumberAllEntityCodesBatch(db, types);
      await logAudit(db, req, AUDIT_ACTIONS.SETTINGS_UPDATE, "entity_codes", null, null, counts);
      res.json({
        message: "تم إعادة ترقيم السجلات",
        counts,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
