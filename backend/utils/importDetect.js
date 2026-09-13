import { isArabicRetailFormat, findArabicRetailHeaderRow } from "./productImport.js";
import {
  findHeaderRowIndex,
  normalizeHeaderCell,
  previewMatrixRows,
  readXlsxMatrix,
} from "./xlsxHelpers.js";

/** @typedef {'hesabati_price_list' | 'hesabati_supplier_balances' | 'hesabati_customer_balances' | 'hesabati_operator_balances' | 'hesabati_building_balances' | 'abu_shalbak_supplier_list' | 'arabic_retail' | 'generic_products' | 'unknown'} ImportType */

export const IMPORT_TYPE_LABELS = {
  hesabati_price_list: "قائمة الأسعار — حساباتي",
  hesabati_supplier_balances: "أرصدة الموردين — حساباتي",
  hesabati_customer_balances: "أرصدة الزبائن — حساباتي",
  hesabati_operator_balances: "أرصدة المشغلين — حساباتي",
  hesabati_building_balances: "أرصدة العمارة — حساباتي",
  abu_shalbak_supplier_list: "قائمة الموردين — أبو شلبك (نقل بين الأجهزة)",
  arabic_retail: "بطاقة الأصناف — حساباتي",
  generic_products: "منتجات (CSV/Excel عام)",
  unknown: "غير معروف",
};

const BALANCE_HEADER_RE = /^الرصيد$|^رصيد|^الرصيد\s*الحالي|^balance$/i;
const NAME_HEADER_RE = /^الاسم$|^اسم|^اسم\s*الزبون|^اسم\s*العميل|^اسم\s*المورد|^البيان$/i;
const BARCODE_HEADER_RE = /^باركود$|^الباركود$|^كود\s*الصنف$/i;
const PRICE_TIER_RE = /^مفرق$|^جملة$|^نصف\s*جملة$|^السعر$|^سعر\s*البيع$/i;

/**
 * @param {string} filename
 */
export function normalizeFilename(filename) {
  return String(filename || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} filename
 * @returns {ImportType | null}
 */
export function detectTypeFromFilename(filename) {
  const n = normalizeFilename(filename);
  if (n.includes("قائمة الأسعار") || n.includes("قائمة الاسعار")) return "hesabati_price_list";
  if (n.includes("أرصدة الموردين") || n.includes("ارصدة الموردين")) return "hesabati_supplier_balances";
  if (n.includes("أرصدة المشغلين") || n.includes("ارصدة المشغلين")) return "hesabati_operator_balances";
  if (n.includes("أرصدة العمارة") || n.includes("ارصدة العمارة")) return "hesabati_building_balances";
  if (
    n.includes("أرصدة زبون") ||
    n.includes("ارصدة زبون") ||
    n.includes("أرصدة الزبون") ||
    n.includes("أرصدة العملاء") ||
    n.includes("ارصدة العملاء") ||
    n.includes("أرصدة الزبائن") ||
    n.includes("ارصدة الزبائن")
  ) {
    return "hesabati_customer_balances";
  }
  return null;
}

/**
 * Filename hints at Hesabati customer/party balances (not suppliers).
 * @param {string} filename
 */
export function filenameSuggestsCustomerBalances(filename) {
  return detectTypeFromFilename(filename) === "hesabati_customer_balances";
}

/**
 * Filename hints at Hesabati supplier balances.
 * @param {string} filename
 */
export function filenameSuggestsSupplierBalances(filename) {
  return detectTypeFromFilename(filename) === "hesabati_supplier_balances";
}

export const ABU_SHALBAK_SUPPLIER_LIST_EXPORT_ERROR =
  "هذا ملف تصدير قائمة الموردين من أبو شلبك. لنقل الموردين بين الأجهزة ارفعه من استيراد أرصدة الموردين. " +
  "استرداد الزبائن يحتاج ملف Excel من حساباتي أو missing-suppliers.xlsx.";

export const UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR =
  "هذا تصدير قديم بأرصدة مطلقة (₪) ولا يفرّق بين مستحق للمورد ودائن. " +
  "صدّر الملف من جديد من إدارة الموردين بعد التحديث ثم ارفعه.";

export const ABU_SHALBAK_SUPPLIER_LIST_RECOVERY_ERROR =
  "استرداد الموردين يعمل على ملف Excel من حساباتي أو missing-suppliers.xlsx، وليس تصدير قائمة الموردين. " +
  "لنقل الموردين بين الأجهزة استخدم استيراد أرصدة الموردين.";

/**
 * System CSV from إدارة الموردين (suppliers-YYYY-MM-DD.csv).
 * @param {unknown[][]} matrix
 * @param {string} [filename]
 */
export function isAbuShalbakSupplierListExport(matrix, filename = "") {
  const n = normalizeFilename(filename);
  if (/(^|[\\/])suppliers-\d{4}-\d{2}-\d{2}/i.test(n) || /(^|[\\/])supplier-balances-\d{4}-\d{2}-\d{2}/i.test(n)) {
    return true;
  }
  const headers = (Array.isArray(matrix) && matrix[0] ? matrix[0] : []).map(normalizeHeaderCell);
  if (!headers.length) return false;
  const hasName = headers.some((h) => /^الاسم$|^name$/i.test(h));
  const hasSystemBalance = headers.some((h) => /الرصيد\s*\(\s*مستحق\s*\)/.test(h));
  const hasPaymentTerms = headers.some((h) => /شروط\s*الدفع/.test(h));
  return hasName && (hasSystemBalance || hasPaymentTerms);
}

/**
 * @param {string[]} headers
 */
function headersHaveBalanceSheet(headers) {
  const hasBalance = headers.some((h) => BALANCE_HEADER_RE.test(h));
  const hasName = headers.some((h) => NAME_HEADER_RE.test(h));
  const hasBarcode = headers.some((h) => BARCODE_HEADER_RE.test(h));
  return hasBalance && hasName && !hasBarcode;
}

/**
 * @param {string[]} headers
 */
function headersHavePriceList(headers) {
  const hasBarcode = headers.some((h) => BARCODE_HEADER_RE.test(h) || /^رقم\s*الصنف$/i.test(h));
  const hasName = headers.some((h) => NAME_HEADER_RE.test(h) || /^الصنف$/i.test(h));
  const priceCols = headers.filter((h) => PRICE_TIER_RE.test(h)).length;
  return hasBarcode && hasName && priceCols >= 1;
}

/**
 * @param {string[]} headers
 */
function headersHaveGenericProducts(headers) {
  const hasBarcode = headers.some(
    (h) => BARCODE_HEADER_RE.test(h) || /^barcode$/i.test(h) || /^sku$/i.test(h)
  );
  const hasName = headers.some((h) => NAME_HEADER_RE.test(h) || /^name$/i.test(h));
  const hasPrice = headers.some((h) => /^price$/i.test(h) || /^السعر$/i.test(h) || /^مفرق$/i.test(h));
  return hasBarcode && hasName && hasPrice;
}

/**
 * @param {unknown[][]} matrix
 * @param {string} [filename]
 */
export function detectImportType(matrix, filename = "") {
  if (isAbuShalbakSupplierListExport(matrix, filename)) {
    return { type: "abu_shalbak_supplier_list", confidence: "headers", headerRowIndex: 0 };
  }

  const fromName = detectTypeFromFilename(filename);
  if (fromName) {
    return { type: fromName, confidence: "filename", headerRowIndex: findBalanceOrProductHeader(matrix, fromName) };
  }

  const retailHeaderRow = findArabicRetailHeaderRow(matrix);
  if (retailHeaderRow >= 0) {
    return { type: "arabic_retail", confidence: "headers", headerRowIndex: retailHeaderRow };
  }

  const balanceHeaderRow = findHeaderRowIndex(matrix, headersHaveBalanceSheet);
  if (balanceHeaderRow >= 0) {
    return { type: "hesabati_customer_balances", confidence: "headers", headerRowIndex: balanceHeaderRow };
  }

  const priceListRow = findHeaderRowIndex(matrix, headersHavePriceList);
  if (priceListRow >= 0) {
    const headers = (matrix[priceListRow] || []).map(normalizeHeaderCell);
    const tierCount = headers.filter((h) => PRICE_TIER_RE.test(h)).length;
    if (tierCount >= 2 || normalizeFilename(filename).includes("أسعار")) {
      return { type: "hesabati_price_list", confidence: "headers", headerRowIndex: priceListRow };
    }
    return { type: "generic_products", confidence: "headers", headerRowIndex: priceListRow };
  }

  const genericRow = findHeaderRowIndex(matrix, headersHaveGenericProducts);
  if (genericRow >= 0) {
    return { type: "generic_products", confidence: "headers", headerRowIndex: genericRow };
  }

  if (matrix.length > 0 && isArabicRetailFormat(matrix[0])) {
    return { type: "arabic_retail", confidence: "headers", headerRowIndex: 0 };
  }

  return { type: "unknown", confidence: "none", headerRowIndex: -1 };
}

/**
 * @param {unknown[][]} matrix
 * @param {ImportType} type
 */
function findBalanceOrProductHeader(matrix, type) {
  if (type === "arabic_retail" || type === "hesabati_price_list" || type === "generic_products") {
    const retail = findArabicRetailHeaderRow(matrix);
    if (retail >= 0) return retail;
    if (type === "hesabati_price_list") {
      const pl = findHeaderRowIndex(matrix, headersHavePriceList);
      if (pl >= 0) return pl;
    }
    const gen = findHeaderRowIndex(matrix, headersHaveGenericProducts);
    if (gen >= 0) return gen;
  }
  const bal = findHeaderRowIndex(matrix, headersHaveBalanceSheet);
  return bal >= 0 ? bal : 0;
}

/**
 * @param {Buffer} buffer
 * @param {string} [filename]
 */
export function detectFromBuffer(buffer, filename = "") {
  const { matrix } = readXlsxMatrix(buffer);
  if (!matrix.length) {
    return {
      type: "unknown",
      confidence: "none",
      headerRowIndex: -1,
      previewHeaders: [],
      previewRows: [],
      label: IMPORT_TYPE_LABELS.unknown,
    };
  }

  const { type, confidence, headerRowIndex } = detectImportType(matrix, filename);
  const headerIdx = headerRowIndex >= 0 ? headerRowIndex : 0;
  const { headers, rows } = previewMatrixRows(matrix, headerIdx, 5);

  return {
    type,
    confidence,
    headerRowIndex: headerIdx,
    previewHeaders: headers,
    previewRows: rows,
    label: IMPORT_TYPE_LABELS[type] || IMPORT_TYPE_LABELS.unknown,
  };
}
