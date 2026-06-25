import { detectFromBuffer } from "../utils/importDetect.js";
import { requireImportFile } from "../utils/importUpload.js";
import { importCustomerBalancesFromBuffer } from "../utils/customerImport.js";
import {
  importSupplierBalancesFromBuffer,
  previewSupplierBalancesFromBuffer,
} from "../utils/supplierImport.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

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
  };
}

/**
 * @param {string|null} dateStr
 */
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
    validateOpeningBalanceDate(opts.openingBalanceDate) || new Date().toISOString().slice(0, 10);

  try {
    const summary = await importSupplierBalancesFromBuffer(db, file.buffer, file.originalname || "", {
      importZeroBalances: opts.importZeroBalances,
      force: opts.force,
      overwriteExistingOpeningBalances: opts.overwriteExistingOpeningBalances,
      openingBalanceDate,
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
    req.query.opening_balance_date = new Date().toISOString().slice(0, 10);
  }
  await handleSupplierBalanceConfirm(db, req, res);
}
