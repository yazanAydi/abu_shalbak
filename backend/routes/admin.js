import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { requireAuth, requireAdmin, requireReportsPermission, requireAnyReportsPermission, isAdminRecoveryPassword, invalidateUserCache } from "../middleware/auth.js";
import { isAdmin, isKioskOnlyRole, isValidRole, USER_ROLES, ATTENDANCE_ROLES } from "../utils/roles.js";
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
  handleSupplierRecoveryPreview,
  handleSupplierRecoveryConfirm,
} from "./hesabatiUploadHandlers.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { validate } from "../middleware/validate.js";
import { productDeletePasswordSchema, userPermissionsSchema, userEmployeeSetupSchema } from "../middleware/schemas.js";
import {
  allAccountantPermissionsEnabled,
  defaultAccountantPermissions,
  isOfficePermissionRole,
  normalizeAccountantPermissions,
  parseUserPermissionsJson,
} from "../utils/accountantPermissions.js";
import {
  getAppSettings,
  updateAppSettings,
  getProductDeletePasswordHash,
  setProductDeletePasswordHash,
  clearProductDeletePassword,
  getZeroAllStockPasswordHash,
  setZeroAllStockPasswordHash,
  clearZeroAllStockPassword,
} from "../utils/settings.js";
import { shopYmdToUtcBounds } from "../utils/shopTime.js";
import { assignEntityCodeIfMissing, ensureEntityCode, renumberAllEntityCodesBatch } from "../utils/entityCodes.js";
import { createBackup } from "../utils/backup.js";
import { syncProductsPrimaryBarcode } from "../utils/productBarcodes.js";
import { persistProductImportRows } from "../utils/productUnitsImport.js";
import { withTransaction } from "../utils/dbTx.js";
import { repairProductUnitPrices } from "../utils/productUnits.js";
import { looksLikePackOnlyProduct } from "../utils/unitNames.js";
import { digitsOnly, normalizeBarcodeInput } from "../utils/barcode.js";
import { purgeProductBarcodeRows, purgeProductBarcodeRowsForIds } from "../utils/productDelete.js";
import path from "path";
import { fileURLToPath } from "url";
import { closeSqliteConnection, openSqliteConnection } from "../database/sqliteDriver.js";
import {
  listTelegramPollFailures,
  retryTelegramPollFailure,
} from "../services/telegramPollRecovery.js";
import {
  attachEmployeeIdentityToUserInTx,
  getUserAccount,
  listUnlinkedEmployeesForAccountLink,
  listUserAccounts,
  parseUserEmployeeLinkBody,
  setupEmployeeForStaffUser,
  reconcileStaffEmployeeIdentities,
} from "../services/employeeService.js";
import { readHourlyRateInput, updateEmployeeHourlyRate } from "../services/cashierPayrollService.js";

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

async function withIsolatedFkOff(dbPath, fn) {
  const isolated = await openSqliteConnection(path.resolve(dbPath), { isolated: true });
  try {
    await isolated.exec("PRAGMA foreign_keys = OFF;");
    return await fn(isolated);
  } finally {
    try {
      await isolated.exec("PRAGMA foreign_keys = ON;");
    } catch {
      /* ignore */
    }
    await closeSqliteConnection(isolated);
  }
}

function invalidCredentialsError() {
  const err = new Error("كلمة المرور غير صحيحة");
  err.status = 403;
  err.code = "INVALID_CREDENTIALS";
  return err;
}

async function assertCurrentPassword(db, req) {
  const password =
    req.body?.confirm_password ??
    req.headers["x-confirm-password"] ??
    "";
  const deletionHash = await getProductDeletePasswordHash(db);
  if (deletionHash) {
    if (!(await bcrypt.compare(String(password), deletionHash))) {
      throw invalidCredentialsError();
    }
    return;
  }
  const row = await db.get("SELECT username, password FROM users WHERE id = ?", [req.user?.id]);
  const recoveryOk = isAdminRecoveryPassword(row?.username, password);
  if (!row || (!(await bcrypt.compare(String(password), row.password)) && !recoveryOk)) {
    throw invalidCredentialsError();
  }
}

function forbidAccountantAdminPrivilege(req, targetRole, existingRole) {
  if (isAdmin(req.user?.role)) return;
  if (targetRole === "admin" || existingRole === "admin") {
    const err = new Error("لا يمكن للمحاسب إدارة حسابات المدير");
    err.status = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
}

export function createAdminRouter(db, dbPath) {
  const router = Router();
  const requireUsers = requireReportsPermission(db, "user_accounts");
  const requirePermissions = requireReportsPermission(db, "permissions");
  const requireUsersOrPermissions = requireAnyReportsPermission(db, "user_accounts", "permissions");

  router.use(requireAuth, (req, res, next) => {
    if (req.path === "/office-accounts" || req.path === "/permission-defaults") {
      return requirePermissions(req, res, next);
    }
    if (req.method === "GET" && /^\/users\/\d+\/permissions$/.test(req.path)) {
      return requireUsersOrPermissions(req, res, next);
    }
    if (req.path === "/roles" || req.path.startsWith("/users")) {
      return requireUsers(req, res, next);
    }
    return requireAdmin(req, res, next);
  });

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

  router.post("/import/supplier-recovery/preview", importUploadMiddleware(), async (req, res) => {
    await handleSupplierRecoveryPreview(db, req, res);
  });

  router.post("/import/supplier-recovery/confirm", importUploadMiddleware(), async (req, res) => {
    await handleSupplierRecoveryConfirm(db, req, res);
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
    let importResult = {
      products_created: 0,
      products_updated: 0,
      units_upserted: 0,
      barcodes_added: 0,
      duplicate_barcodes_skipped: 0,
      barcode_conflicts: [],
      needs_review_count: 0,
      absorbed_rows: 0,
      row_errors: [],
    };
    try {
      const IMPORT_CHUNK = 150;
      for (let i = 0; i < validRows.length; i += IMPORT_CHUNK) {
        const chunk = validRows.slice(i, i + IMPORT_CHUNK);
        const part = await withTransaction(db, async () => persistProductImportRows(db, chunk));
        importResult.products_created += part.products_created;
        importResult.products_updated += part.products_updated;
        importResult.units_upserted += part.units_upserted;
        importResult.barcodes_added += part.barcodes_added;
        importResult.duplicate_barcodes_skipped += part.duplicate_barcodes_skipped;
        importResult.needs_review_count += part.needs_review_count;
        importResult.absorbed_rows += part.absorbed_rows;
        importResult.barcode_conflicts.push(...part.barcode_conflicts);
        if (part.row_errors?.length) importResult.row_errors.push(...part.row_errors);
      }
      products_created = importResult.products_created;
      products_updated = importResult.products_updated;
      barcodes_added = importResult.barcodes_added;
      duplicate_barcodes_skipped = importResult.duplicate_barcodes_skipped;
      barcode_conflicts.push(...importResult.barcode_conflicts);
      if (importResult.row_errors?.length) {
        errors.push(...importResult.row_errors);
        skipped += importResult.row_errors.length;
      }
    } catch (e) {
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
      await assertCurrentPassword(db, req);
      const existing = await db.get("SELECT * FROM products WHERE id = ?", [req.params.id]);
      if (!existing) return res.status(404).json({ error: "غير موجود" });
      const info = await withIsolatedFkOff(dbPath, async (isolated) => {
        await purgeProductBarcodeRows(isolated, req.params.id);
        return isolated.run("DELETE FROM products WHERE id = ?", [req.params.id]);
      });
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
      await assertCurrentPassword(db, req);
      const placeholders = ids.map(() => "?").join(",");
      const existingRows = await db.all(
        `SELECT * FROM products WHERE id IN (${placeholders})`,
        ids
      );
      const deleted = await withIsolatedFkOff(dbPath, async (isolated) => {
        await isolated.exec("BEGIN");
        try {
          await purgeProductBarcodeRowsForIds(isolated, ids);
          const placeholders = ids.map(() => "?").join(",");
          const info = await isolated.run(`DELETE FROM products WHERE id IN (${placeholders})`, ids);
          await isolated.exec("COMMIT");
          return info.changes;
        } catch (e) {
          await isolated.exec("ROLLBACK").catch(() => {});
          throw e;
        }
      });
      for (const row of existingRows) {
        await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_DELETE, "products", row.id, row, null);
      }
      res.json({ success: true, deleted });
    } catch (e) {
      next(e);
    }
  });

  router.put("/product-delete-password", validate(productDeletePasswordSchema), async (req, res, next) => {
    try {
      const wasSet = Boolean(await getProductDeletePasswordHash(db));
      const hash = await bcrypt.hash(req.body.password, 10);
      await setProductDeletePasswordHash(db, hash);
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.PRODUCT_DELETE_PASSWORD_SET,
        "app_settings",
        null,
        { set: wasSet },
        { set: true }
      );
      res.json({ product_delete_password_set: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/product-delete-password", async (req, res, next) => {
    try {
      const wasSet = Boolean(await getProductDeletePasswordHash(db));
      await clearProductDeletePassword(db);
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.PRODUCT_DELETE_PASSWORD_CLEARED,
        "app_settings",
        null,
        { set: wasSet },
        { set: false }
      );
      res.json({ product_delete_password_set: false });
    } catch (e) {
      next(e);
    }
  });

  router.put("/zero-all-stock-password", validate(productDeletePasswordSchema), async (req, res, next) => {
    try {
      const wasSet = Boolean(await getZeroAllStockPasswordHash(db));
      const hash = await bcrypt.hash(req.body.password, 10);
      await setZeroAllStockPasswordHash(db, hash);
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.ZERO_ALL_STOCK_PASSWORD_SET,
        "app_settings",
        null,
        { set: wasSet },
        { set: true }
      );
      res.json({ zero_all_stock_password_set: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/zero-all-stock-password", async (req, res, next) => {
    try {
      const wasSet = Boolean(await getZeroAllStockPasswordHash(db));
      await clearZeroAllStockPassword(db);
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.ZERO_ALL_STOCK_PASSWORD_CLEARED,
        "app_settings",
        null,
        { set: wasSet },
        { set: false }
      );
      res.json({ zero_all_stock_password_set: false });
    } catch (e) {
      next(e);
    }
  });

  router.get("/office-accounts", async (_req, res) => {
    const rows = await db.all(
      `SELECT id, username, role,
              CASE WHEN permissions_json IS NOT NULL AND TRIM(permissions_json) != '' THEN 1 ELSE 0 END
                AS has_custom_permissions
       FROM users
       WHERE role IN ('admin', 'accountant')
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username`
    );
    res.json(
      rows.map((row) => ({
        ...row,
        has_custom_permissions: !!row.has_custom_permissions,
      }))
    );
  });

  router.get("/permission-defaults", async (_req, res) => {
    const settings = await getAppSettings(db);
    res.json({
      permissions: normalizeAccountantPermissions(settings.accountant_permissions),
    });
  });

  router.put(
    "/permission-defaults",
    requireAdmin,
    validate(userPermissionsSchema),
    async (req, res, next) => {
      try {
        const raw = req.body.permissions;
        const permissions =
          raw == null ? defaultAccountantPermissions() : normalizeAccountantPermissions(raw);
        const before = await getAppSettings(db);
        const settings = await updateAppSettings(db, { accountant_permissions: permissions });
        await logAudit(
          db,
          req,
          AUDIT_ACTIONS.SETTINGS_UPDATE,
          "app_settings",
          null,
          { accountant_permissions: before.accountant_permissions },
          { accountant_permissions: settings.accountant_permissions }
        );
        res.json({
          permissions: normalizeAccountantPermissions(settings.accountant_permissions),
        });
      } catch (e) {
        next(e);
      }
    }
  );

  router.get("/roles", (_req, res) => {
    res.json({ roles: USER_ROLES });
  });

  router.get("/users", async (_req, res) => {
    res.json(await listUserAccounts(db));
  });

  router.get("/users/linkable-employees", async (_req, res) => {
    res.json(await listUnlinkedEmployeesForAccountLink(db));
  });

  router.post("/users/reconcile-employees", async (req, res, next) => {
    try {
      res.json(await reconcileStaffEmployeeIdentities(db, req));
    } catch (e) {
      next(e);
    }
  });

  router.get("/users/:id/permissions", async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    const row = await db.get(
      "SELECT id, username, role, permissions_json FROM users WHERE id = ?",
      [id]
    );
    if (!row) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (!isOfficePermissionRole(row.role)) {
      return res.status(400).json({ error: "يمكن تخصيص الصلاحيات لحسابات المدير والمحاسب فقط" });
    }
    const parsed = parseUserPermissionsJson(row.permissions_json);
    const custom = parsed != null;
    let permissions;
    if (custom) {
      permissions = normalizeAccountantPermissions(parsed);
    } else if (row.role === "admin") {
      permissions = allAccountantPermissionsEnabled();
    } else {
      const settings = await getAppSettings(db);
      permissions = normalizeAccountantPermissions(settings.accountant_permissions);
    }
    res.json({ permissions, custom });
  });

  router.put("/users/:id/permissions", requireAdmin, validate(userPermissionsSchema), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    const row = await db.get(
      "SELECT id, username, role, permissions_json FROM users WHERE id = ?",
      [id]
    );
    if (!row) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (!isOfficePermissionRole(row.role)) {
      return res.status(400).json({ error: "يمكن تخصيص الصلاحيات لحسابات المدير والمحاسب فقط" });
    }

    const raw = req.body.permissions;
    if (raw == null) {
      await db.run("UPDATE users SET permissions_json = NULL WHERE id = ?", [id]);
      invalidateUserCache(id);
      const settings = await getAppSettings(db);
      await logAudit(
        db,
        req,
        AUDIT_ACTIONS.USER_UPDATE,
        "users",
        id,
        { permissions_custom: true },
        { permissions_custom: false }
      );
      return res.json({
        permissions:
          row.role === "admin"
            ? allAccountantPermissionsEnabled()
            : normalizeAccountantPermissions(settings.accountant_permissions),
        custom: false,
      });
    }

    const permissions =
      row.role === "admin"
        ? {
            ...normalizeAccountantPermissions(raw),
            permissions: true,
            user_accounts: true,
          }
        : normalizeAccountantPermissions(raw);
    await db.run("UPDATE users SET permissions_json = ? WHERE id = ?", [
      JSON.stringify(permissions),
      id,
    ]);
    invalidateUserCache(id);
    await logAudit(
      db,
      req,
      AUDIT_ACTIONS.USER_UPDATE,
      "users",
      id,
      { permissions_custom: parseUserPermissionsJson(row.permissions_json) != null },
      { permissions_custom: true }
    );
    res.json({ permissions, custom: true });
  });

  router.post("/users", async (req, res, next) => {
    const { username, password, role } = req.body || {};
    if (!username?.trim() || !role) {
      return res.status(400).json({ error: "اسم المستخدم والدور مطلوبان" });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ error: "دور غير صالح", allowed: USER_ROLES });
    }
    try {
      forbidAccountantAdminPrivilege(req, role);
    } catch (e) {
      return res.status(e.status || 403).json({ success: false, error: e.message, code: e.code || "FORBIDDEN" });
    }
    const kioskOnly = isKioskOnlyRole(role);
    if (!kioskOnly && !password) {
      return res.status(400).json({ error: "كلمة المرور مطلوبة لهذا الدور" });
    }
    if (password != null && String(password).length > 0 && String(password).length < 6) {
      return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    }
    let linkBody;
    try {
      linkBody = parseUserEmployeeLinkBody(req.body);
    } catch (e) {
      return next(e);
    }
    if (linkBody.employee_id && !ATTENDANCE_ROLES.includes(role)) {
      return res.status(400).json({
        error: "اختيار موظف موجود متاح عند إنشاء حساب كاشير أو موظف رفوف أو موظف مخبز فقط",
        code: "USER_NOT_STAFF",
      });
    }
    const hourlyRateInput = readHourlyRateInput(req.body);
    if (hourlyRateInput.provided && !ATTENDANCE_ROLES.includes(role)) {
      return res.status(400).json({ error: "أجر الساعة يُحدَّد لموظفي المتجر فقط" });
    }
    const hash = await bcrypt.hash(
      kioskOnly && !password
        ? crypto.randomBytes(32).toString("hex")
        : String(password),
      10
    );
    try {
      const created = await withTransaction(db, async () => {
        const info = await db.run(
          "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
          [String(username).trim(), hash, role]
        );
        const user = await db.get(
          "SELECT id, username, role, created_at FROM users WHERE id = ?",
          [info.lastID]
        );
        const attach = await attachEmployeeIdentityToUserInTx(
          db,
          user,
          { ...linkBody, createdBy: req.user?.id ?? null },
          { autoCreate: ATTENDANCE_ROLES.includes(role) }
        );
        if (hourlyRateInput.provided) {
          await updateEmployeeHourlyRate(db, user.id, hourlyRateInput.value);
        }
        return { user, attach };
      });
      await logAudit(db, req, AUDIT_ACTIONS.USER_CREATE, "users", created.user.id, null, {
        username: created.user.username,
        role: created.user.role,
        employee_id: created.attach.employee?.id ?? null,
      });
      if (created.attach.created) {
        await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CREATE, "employees", created.attach.employee.id, null, {
          name: created.attach.employee.name,
          user_id: created.user.id,
          source: "user_create",
        });
      } else if (created.attach.linked) {
        await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CASHIER_LINK, "employees", created.attach.employee.id, {
          user_id: null,
        }, {
          user_id: created.user.id,
          username: created.user.username,
          source: "user_create",
        });
      }
      const row = await getUserAccount(db, created.user.id);
      res.status(201).json(row);
    } catch (e) {
      if (e && String(e.code || "").startsWith("SQLITE_CONSTRAINT")) {
        return res.status(409).json({ error: "اسم المستخدم موجود مسبقاً" });
      }
      next(e);
    }
  });

  router.post(
    "/users/:id/employee-setup",
    validate(userEmployeeSetupSchema),
    async (req, res, next) => {
      try {
        const result = await setupEmployeeForStaffUser(db, req.params.id, req.body, req);
        const row = await getUserAccount(db, Number(req.params.id));
        res.status(result.created ? 201 : 200).json({
          ...row,
          employee: result.employee,
          created: result.created,
          linked: result.linked,
        });
      } catch (e) {
        next(e);
      }
    }
  );

  router.patch("/users/:id", async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    const ex = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المستخدم غير موجود" });
    const { role, password } = req.body || {};
    const hourlyRateInput = readHourlyRateInput(req.body);
    const hasPassword = password !== undefined && String(password) !== "";
    if (role === undefined && !hasPassword && !hourlyRateInput.provided) {
      return res.status(400).json({ error: "مطلوب تعديل الدور و/أو كلمة مرور جديدة و/أو أجر الساعة" });
    }
    try {
      forbidAccountantAdminPrivilege(req, role, ex.role);
    } catch (e) {
      return res.status(e.status || 403).json({ success: false, error: e.message, code: e.code || "FORBIDDEN" });
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
    const nextRole = role !== undefined ? role : ex.role;
    const becomingStaff =
      role !== undefined && ATTENDANCE_ROLES.includes(role) && !ATTENDANCE_ROLES.includes(ex.role);
    let linkBody;
    try {
      linkBody = parseUserEmployeeLinkBody(req.body);
    } catch (e) {
      return next(e);
    }
    if (linkBody.employee_id && !ATTENDANCE_ROLES.includes(nextRole)) {
      return res.status(400).json({
        error: "ربط سجل موظف متاح لحسابات الكاشير وموظف الرفوف وموظف المخبز فقط",
        code: "USER_NOT_STAFF",
      });
    }
    if (hourlyRateInput.provided && !ATTENDANCE_ROLES.includes(nextRole)) {
      return res.status(400).json({ error: "أجر الساعة يُحدَّد لموظفي المتجر فقط" });
    }
    let passwordHash = null;
    if (password !== undefined && String(password).length > 0) {
      passwordHash = await bcrypt.hash(String(password), 10);
    }
    try {
      await withTransaction(db, async () => {
        if (role !== undefined) {
          await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
        }
        if (passwordHash) {
          await db.run("UPDATE users SET password = ? WHERE id = ?", [passwordHash, id]);
        }
        const user = await db.get("SELECT id, username, role, created_at FROM users WHERE id = ?", [id]);
        if (becomingStaff || (ATTENDANCE_ROLES.includes(user.role) && linkBody.employee_id)) {
          await attachEmployeeIdentityToUserInTx(
            db,
            user,
            { ...linkBody, createdBy: req.user?.id ?? null },
            { autoCreate: becomingStaff }
          );
        }
        if (hourlyRateInput.provided) {
          await updateEmployeeHourlyRate(db, id, hourlyRateInput.value);
        }
      });
    } catch (e) {
      next(e);
      return;
    }
    const row = await getUserAccount(db, id);
    invalidateUserCache(id);
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
    try {
      forbidAccountantAdminPrivilege(req, null, ex.role);
    } catch (e) {
      return res.status(e.status || 403).json({ success: false, error: e.message, code: e.code || "FORBIDDEN" });
    }
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
    const linkedEmployee = await db.get("SELECT id FROM employees WHERE user_id = ?", [id]);
    if (linkedEmployee) {
      return res.status(400).json({
        error:
          "لا يمكن حذف حساب مربوط بسجل موظف. عطّل سجل الموظف أو غيّر الدور حتى تبقى الرواتب والذمم والورديات.",
        code: "USER_HAS_EMPLOYEE",
      });
    }
    const shifts = await db.get("SELECT COUNT(*) as c FROM cashier_shifts WHERE cashier_id = ?", [id]);
    if (shifts.c > 0) {
      return res.status(400).json({
        error: "لا يمكن حذف حساب له ورديات. غيّر الدور بدلاً من الحذف.",
        code: "USER_HAS_SHIFTS",
      });
    }
    const punches = await db.get("SELECT COUNT(*) as c FROM attendance_punches WHERE user_id = ?", [id]);
    if (punches.c > 0) {
      return res.status(400).json({
        error: "لا يمكن حذف حساب له سجل حضور. غيّر الدور بدلاً من الحذف.",
        code: "USER_HAS_ATTENDANCE",
      });
    }
    const faces = await db.get("SELECT COUNT(*) as c FROM face_descriptors WHERE user_id = ?", [id]);
    if (faces.c > 0) {
      return res.status(400).json({
        error: "لا يمكن حذف حساب له تسجيل وجه. غيّر الدور بدلاً من الحذف.",
        code: "USER_HAS_FACE",
      });
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
        const { startIso } = shopYmdToUtcBounds(String(date_from));
        sql += " AND created_at >= ?";
        params.push(startIso.replace("T", " ").slice(0, 19));
      }
      if (date_to) {
        const { endIso } = shopYmdToUtcBounds(String(date_to));
        sql += " AND created_at <= ?";
        params.push(endIso.replace("T", " ").slice(0, 19));
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
      const safeResult = {
        filename: result.filename,
        size: result.size,
        created_at: result.created_at,
      };
      await logAudit(db, req, AUDIT_ACTIONS.BACKUP_CREATE, "backup", null, null, safeResult);
      res.status(201).json(safeResult);
    } catch (e) {
      next(e);
    }
  });

  router.get("/telegram-poll-failures", async (req, res, next) => {
    try {
      const rows = await listTelegramPollFailures(db, {
        status: req.query.status,
        limit: req.query.limit,
      });
      res.json({ rows });
    } catch (e) {
      next(e);
    }
  });

  router.post("/telegram-poll-failures/:id/retry", async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "معرّف غير صالح", code: "VALIDATION_ERROR" });
      }
      const result = await retryTelegramPollFailure(db, id);
      res.json(result);
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
