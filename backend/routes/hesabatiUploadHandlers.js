import { detectFromBuffer, filenameSuggestsCustomerBalances, filenameSuggestsSupplierBalances } from "../utils/importDetect.js";
import { requireImportFile } from "../utils/importUpload.js";
import { importCustomerBalancesFromBuffer } from "../utils/customerImport.js";
import {
  importSupplierBalancesFromBuffer,
  previewSupplierBalancesFromBuffer,
} from "../utils/supplierImport.js";
import {
  planMisimportedSupplierRecovery,
  applyMisimportedSupplierRecovery,
} from "../utils/misimportedSupplierRecovery.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { shopTodayYmd } from "../utils/shopTime.js";

/**
 * @param {import('express').Request} req
 */
function parseSupplierImportOptions(req) {
  return {
    importZeroBalances: String(req.query.import_zero_balances || "") === "1",
    force: String(req.query.force || "") === "1",
    overwriteExistingOpeningBalances:
      String(req.query.overwrite_existing_opening_balances || "") === "1",
    openingBalanceDate: String(req.query.opening_balance_date || "").trim() || null,
    includeTestRows: String(req.query.include_test_rows || "") === "1",
  };
}

/**
 * @param {string|null} dateStr
 */
function supplierFileDestinationWarning(filename, detectedType) {
  if (filenameSuggestsSupplierBalances(filename)) return null;
  if (filenameSuggestsCustomerBalances(filename) || detectedType === "hesabati_customer_balances") {
    return "اسم الملف يشير إلى أرصدة زبائن/عملاء. هذا المسار ينشئ بطاقات في إدارة الموردين فقط — لن يُنشئ زبائن.";
  }
  return null;
}

function validateOpeningBalanceDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  return dateStr;
}

/**
 * @param {object} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleCustomerBalanceUpload(db, req, res) {
  const file = requireImportFile(req, res);
  if (!file) return;

  const detected = detectFromBuffer(file.buffer, file.originalname || "");

  try {
    const importZeroBalances = String(req.query.import_zero_balances || "") === "1";
    const force = String(req.query.force || "") === "1";
    const balanceGroupIdRaw = req.query.balance_group_id;
    const balanceGroupId =
      balanceGroupIdRaw != null && String(balanceGroupIdRaw).trim() !== ""
        ? Number(balanceGroupIdRaw)
        : null;
    const importType =
      detected.type === "hesabati_operator_balances" ||
      detected.type === "hesabati_building_balances"
        ? detected.type
        : "hesabati_customer_balances";
    const summary = await importCustomerBalancesFromBuffer(db, file.buffer, file.originalname || "", {
      importZeroBalances,
      force,
      importType,
      balanceGroupId: Number.isFinite(balanceGroupId) ? balanceGroupId : null,
    });
    await logAudit(db, req, AUDIT_ACTIONS.CUSTOMER_BALANCE, "customers", null, null, {
      import_type: summary.type,
      created: summary.created,
      updated: summary.updated,
    });
    res.json({ success: true, ...summary, detected_type: detected.type, label: detected.label });
  } catch (e) {
    res.status(400).json({ error: e.message || "فشل استيراد أرصدة الزبائن" });
  }
}

/**
 * @param {object} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleSupplierBalancePreview(db, req, res) {
  const file = requireImportFile(req, res);
  if (!file) return;

  const detected = detectFromBuffer(file.buffer, file.originalname || "");
  const opts = parseSupplierImportOptions(req);

  try {
    const plan = await previewSupplierBalancesFromBuffer(db, file.buffer, file.originalname || "", opts);
    res.json({
      success: true,
      ...plan,
      destinationWarning: plan.destinationWarning || supplierFileDestinationWarning(file.originalname || "", detected.type),
      detected_type: detected.type,
      label: detected.label,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "فشل معاينة أرصدة الموردين" });
  }
}

/**
 * @param {object} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleSupplierBalanceConfirm(db, req, res) {
  const file = requireImportFile(req, res);
  if (!file) return;

  const detected = detectFromBuffer(file.buffer, file.originalname || "");
  const opts = parseSupplierImportOptions(req);
  const openingBalanceDate =
    validateOpeningBalanceDate(opts.openingBalanceDate) || shopTodayYmd();

  try {
    const summary = await importSupplierBalancesFromBuffer(db, file.buffer, file.originalname || "", {
      importZeroBalances: opts.importZeroBalances,
      force: opts.force,
      overwriteExistingOpeningBalances: opts.overwriteExistingOpeningBalances,
      openingBalanceDate,
      includeTestRows: opts.includeTestRows,
    });
    await logAudit(db, req, AUDIT_ACTIONS.SUPPLIER_BALANCE, "suppliers", null, null, {
      import_type: summary.type,
      created: summary.created,
      updated: summary.updated,
      opening_balance_date: openingBalanceDate,
    });
    res.json({
      success: true,
      ...summary,
      detected_type: detected.type,
      label: detected.label,
      opening_balance_date: openingBalanceDate,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "فشل استيراد أرصدة الموردين" });
  }
}

/**
 * @param {object} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleSupplierBalanceUpload(db, req, res) {
  const opts = parseSupplierImportOptions(req);
  if (!opts.openingBalanceDate) {
    req.query.opening_balance_date = shopTodayYmd();
  }
  await handleSupplierBalanceConfirm(db, req, res);
}

/**
 * Dry-run: missing suppliers + mistaken credit customers from a supplier Excel.
 */
export async function handleSupplierRecoveryPreview(db, req, res) {
  const file = requireImportFile(req, res);
  if (!file) return;

  try {
    const plan = await planMisimportedSupplierRecovery(db, file.buffer, file.originalname || "");
    res.json({ success: true, ...plan });
  } catch (e) {
    res.status(400).json({ error: e.message || "فشلت معاينة الاسترداد" });
  }
}

/**
 * Create missing suppliers. Deletes mistaken customers only when delete_customers=1.
 */
export async function handleSupplierRecoveryConfirm(db, req, res) {
  const file = requireImportFile(req, res);
  if (!file) return;

  const deleteCustomers = String(req.query.delete_customers || "") === "1";
  const opts = parseSupplierImportOptions(req);
  const openingBalanceDate =
    validateOpeningBalanceDate(opts.openingBalanceDate) || shopTodayYmd();

  try {
    const summary = await applyMisimportedSupplierRecovery(db, file.buffer, file.originalname || "", {
      deleteCustomers,
      openingBalanceDate,
    });
    await logAudit(db, req, AUDIT_ACTIONS.SUPPLIER_BALANCE, "suppliers", null, null, {
      import_type: summary.type,
      created: summary.suppliersCreated,
      existing: summary.suppliersExisting,
      customers_deleted: summary.customersDeleted,
      delete_customers: deleteCustomers,
    });
    res.json({ success: true, ...summary, opening_balance_date: openingBalanceDate });
  } catch (e) {
    res.status(400).json({ error: e.message || "فشل استرداد الموردين" });
  }
}
