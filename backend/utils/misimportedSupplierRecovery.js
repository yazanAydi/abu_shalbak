import {
  normalizeArabicNameForMatch,
  isBalanceSummaryRow,
  customerHasLedgerActivity,
} from "./balanceSheetImport.js";
import { getBalanceGroupIdForImportType } from "./balanceGroups.js";
import {
  parseSupplierBalanceFile,
  applySupplierBalanceImport,
  SUPPLIER_IMPORT_DESTINATION,
  SUPPLIER_IMPORT_DESTINATION_LABEL,
} from "./supplierImport.js";
import { ABU_SHALBAK_SUPPLIER_LIST_RECOVERY_ERROR } from "./importDetect.js";
import { ABU_SHALBAK_SUPPLIER_LIST_TYPE } from "./supplierListTransfer.js";
import { withTransaction } from "./dbTx.js";

export const RECOVERY_TYPE = "misimported_supplier_recovery";

/**
 * Linked sales / debts / payments / requests — broader than customerHasLedgerActivity.
 * @param {object} db
 * @param {number} customerId
 * @returns {Promise<string[]>}
 */
export async function listCustomerLinkedRecordReasons(db, customerId) {
  const checks = [
    [`SELECT COUNT(*) AS n FROM transactions WHERE customer_id = ?`, "مبيعات"],
    [`SELECT COUNT(*) AS n FROM sales_invoices WHERE customer_id = ?`, "فواتير مبيعات"],
    [`SELECT COUNT(*) AS n FROM refunds WHERE customer_id = ?`, "مرتجعات"],
    [`SELECT COUNT(*) AS n FROM voucher_lines WHERE customer_id = ?`, "سندات"],
    [`SELECT COUNT(*) AS n FROM on_account_requests WHERE customer_id = ?`, "طلبات ذمة"],
    [`SELECT COUNT(*) AS n FROM bank_checks WHERE customer_id = ?`, "شيكات"],
    [`SELECT COUNT(*) AS n FROM sales_deliveries WHERE customer_id = ?`, "توصيل"],
  ];
  const reasons = [];
  for (const [sql, label] of checks) {
    try {
      const row = await db.get(sql, [customerId]);
      if (Number(row?.n) > 0) reasons.push(label);
    } catch {
      // table may be absent on very old DBs
    }
  }
  if (!reasons.length && (await customerHasLedgerActivity(db, customerId))) {
    reasons.push("حركات محاسبية");
  }
  return reasons;
}

/**
 * Import fingerprint for the mistaken customer upload (not Excel ID).
 * Customer import allocated a new customer_code and set credit + zaboon + zero balances.
 * @param {object} customer
 * @param {number|null} zaboonGroupId
 */
export function customerMatchesMisimportFingerprint(customer, zaboonGroupId) {
  if (!customer) return false;
  if (String(customer.price_category || "") !== "credit") return false;
  if (Math.abs(Number(customer.opening_balance) || 0) >= 0.009) return false;
  if (Math.abs(Number(customer.balance) || 0) >= 0.009) return false;
  if (String(customer.notes || "").trim()) return false;
  if (zaboonGroupId != null && Number(customer.balance_group_id) !== Number(zaboonGroupId)) {
    return false;
  }
  return true;
}

/**
 * @param {object} db
 * @param {string} name
 */
async function findCustomersByExactNormalizedName(db, name) {
  const normalized = normalizeArabicNameForMatch(name);
  if (!normalized) return [];
  const all = await db.all(
    `SELECT id, name, customer_code, price_category, notes, opening_balance, balance, balance_group_id, created_at
     FROM customers`
  );
  return all.filter((c) => normalizeArabicNameForMatch(c.name) === normalized);
}

/**
 * @param {object} db
 * @param {string} code
 */
async function findSupplierByCode(db, code) {
  if (!code) return null;
  return db.get(`SELECT * FROM suppliers WHERE supplier_code = ?`, [code]);
}

/**
 * Plan recovery from a supplier-balances Excel (or missing-suppliers.xlsx).
 * Never treats Excel الرقم as customers.id or customers.customer_code.
 *
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function planMisimportedSupplierRecovery(db, buffer, filename = "") {
  const rows = parseSupplierBalanceFile(buffer, filename);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  if (rows.some((r) => r.importType === ABU_SHALBAK_SUPPLIER_LIST_TYPE)) {
    throw new Error(ABU_SHALBAK_SUPPLIER_LIST_RECOVERY_ERROR);
  }

  const zaboonGroupId = await getBalanceGroupIdForImportType(db, "hesabati_customer_balances");
  const audits = await db.all(
    `SELECT created_at FROM audit_logs WHERE action = 'CUSTOMER_BALANCE' ORDER BY id DESC LIMIT 10`
  ).catch(() => []);

  /** @type {object[]} */
  const planRows = [];
  let suppliersToCreate = 0;
  let suppliersExisting = 0;
  let customersSafeToDelete = 0;
  let customersReview = 0;
  let customersNotFound = 0;
  let rejected = 0;

  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const excelCode = row.code != null ? String(row.code).trim() : "";

    if (!name || isBalanceSummaryRow(name) || row.balanceStatus === "missing" || row.balanceStatus === "invalid") {
      rejected++;
      planRows.push({
        excelRow: row.rowNum,
        excelCode: excelCode || null,
        name,
        supplierAction: "skip",
        customerAction: "rejected",
        reason: !name
          ? "الاسم مفقود"
          : isBalanceSummaryRow(name)
            ? "صف إجمالي — ليس مورداً"
            : row.balanceStatus === "invalid"
              ? "الرصيد غير صالح"
              : "الرصيد مفقود",
      });
      continue;
    }

    const existingSupplier = await findSupplierByCode(db, excelCode);
    const supplierAction = existingSupplier ? "existing" : "create";
    if (existingSupplier) suppliersExisting++;
    else suppliersToCreate++;

    const nameMatches = await findCustomersByExactNormalizedName(db, name);
    /** Do not match Excel الرقم to customer.id or customer_code. */
    const fingerprintMatches = nameMatches.filter((c) =>
      customerMatchesMisimportFingerprint(c, zaboonGroupId)
    );

    let customerAction = "not_found";
    let reason = "لا يوجد زبون مطابق لبصمة الاستيراد الخاطئ";
    /** @type {object|null} */
    let customer = null;
    /** @type {string[]} */
    let links = [];

    if (fingerprintMatches.length > 1) {
      customerAction = "review_ambiguous";
      reason = "أكثر من زبون بنفس الاسم وبصمة الاستيراد — للمراجعة";
      customersReview++;
    } else if (fingerprintMatches.length === 1) {
      customer = fingerprintMatches[0];
      links = await listCustomerLinkedRecordReasons(db, customer.id);
      if (links.length) {
        customerAction = "review_linked";
        reason = `زبون مطابق للبصمة لكن له حركات: ${links.join("، ")}`;
        customersReview++;
      } else {
        customerAction = "delete_safe";
        reason = "زبون مطابق للبصمة (آجل، رصيد صفر، فئة الزبون، بدون ملاحظات) ولا حركات مرتبطة";
        customersSafeToDelete++;
      }
    } else if (nameMatches.length > 0) {
      customerAction = "review_mismatch";
      reason =
        "الاسم مطابق حرفياً لكن الزبون لا يحمل بصمة الاستيراد الخاطئ (فئة/رصيد/ملاحظات/مجموعة مختلفة)";
      customersReview++;
      customer = nameMatches[0];
      links = await listCustomerLinkedRecordReasons(db, customer.id);
    } else {
      customersNotFound++;
    }

    const nearAudit =
      customer &&
      audits.some((a) => customerCreatedNearAudit(customer.created_at, a.created_at));

    planRows.push({
      excelRow: row.rowNum,
      excelCode: excelCode || null,
      name,
      supplierAction,
      supplierId: existingSupplier?.id ?? null,
      customerAction,
      customerId: customer?.id ?? null,
      customerCode: customer?.customer_code ?? null,
      excelCodeEqualsCustomerId: customer ? String(customer.id) === excelCode : false,
      excelCodeEqualsCustomerCode: customer ? String(customer.customer_code || "") === excelCode : false,
      usedExcelIdAsCustomerKey: false,
      links,
      nearCustomerImportAudit: Boolean(nearAudit),
      reason,
    });
  }

  return {
    type: RECOVERY_TYPE,
    destination: SUPPLIER_IMPORT_DESTINATION,
    destinationLabel: SUPPLIER_IMPORT_DESTINATION_LABEL,
    filename: filename || null,
    stats: {
      excelRows: rows.length,
      suppliersToCreate,
      suppliersExisting,
      customersSafeToDelete,
      customersReview,
      customersNotFound,
      rejected,
    },
    rows: planRows,
    review: planRows.filter((r) => String(r.customerAction).startsWith("review")),
    message:
      "المعاينة فقط — لن يُحذف أي زبون ولن يُفترض أن رقم Excel يساوي رقم الزبون في قاعدة البيانات.",
  };
}

/**
 * @param {string|null} createdAt
 * @param {string|null} auditAt
 */
function customerCreatedNearAudit(createdAt, auditAt) {
  if (!createdAt || !auditAt) return false;
  const a = Date.parse(String(createdAt).replace(" ", "T") + "Z");
  const b = Date.parse(String(auditAt).replace(" ", "T") + "Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 15 * 60 * 1000;
}

/**
 * Create missing suppliers, then optionally delete only delete_safe customers.
 * Re-checks links inside the transaction. Does not overwrite existing supplier balances.
 *
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ deleteCustomers?: boolean, openingBalanceDate?: string }} [options]
 */
export async function applyMisimportedSupplierRecovery(db, buffer, filename = "", options = {}) {
  const deleteCustomers = Boolean(options.deleteCustomers);
  const plan = await planMisimportedSupplierRecovery(db, buffer, filename);

  const importResult = await applySupplierBalanceImport(
    db,
    parseSupplierBalanceFile(buffer, filename),
    {
      filename,
      overwriteExistingOpeningBalances: false,
      force: false,
      openingBalanceDate: options.openingBalanceDate || undefined,
      sourceId: filename || null,
    }
  );

  let customersDeleted = 0;
  const stillReview = [];
  const deleted = [];

  if (deleteCustomers) {
    await withTransaction(db, async () => {
      for (const row of plan.rows) {
        if (row.customerAction !== "delete_safe" || !row.customerId) continue;
        const links = await listCustomerLinkedRecordReasons(db, row.customerId);
        if (links.length) {
          stillReview.push({ ...row, customerAction: "review_linked", links, reason: `تُرك — ظهرت حركات: ${links.join("، ")}` });
          continue;
        }
        const current = await db.get(`SELECT id FROM customers WHERE id = ?`, [row.customerId]);
        if (!current) continue;
        await db.run(`DELETE FROM customers WHERE id = ?`, [row.customerId]);
        customersDeleted++;
        deleted.push({ customerId: row.customerId, name: row.name, excelCode: row.excelCode });
      }
    });
  }

  return {
    type: RECOVERY_TYPE,
    destination: SUPPLIER_IMPORT_DESTINATION,
    destinationLabel: SUPPLIER_IMPORT_DESTINATION_LABEL,
    suppliersCreated: importResult.created,
    suppliersExisting: importResult.existing,
    suppliersUpdated: importResult.updated,
    customersDeleted: deleteCustomers ? customersDeleted : 0,
    deleteCustomersApplied: deleteCustomers,
    review: [...plan.review, ...stillReview],
    deleted,
    import: importResult,
    stats: plan.stats,
    message: deleteCustomers
      ? `استرداد الموردين: ${importResult.created} مورد جديد، ${importResult.existing} موجود، حُذف ${customersDeleted} زبون آمن. ${plan.stats.customersReview} للمراجعة.`
      : `أُنشئ ${importResult.created} مورد جديد (${importResult.existing} موجود). لم يُحذف زبائن — أعد التأكيد مع delete_customers=1 بعد المراجعة.`,
  };
}
