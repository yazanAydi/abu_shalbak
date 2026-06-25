import { isArabicRetailFormat, findArabicRetailHeaderRow } from "./productImport.js";
import {
  findHeaderRowIndex,
  normalizeHeaderCell,
  previewMatrixRows,
  readXlsxMatrix,
} from "./xlsxHelpers.js";

/** @typedef {'hesabati_price_list' | 'hesabati_supplier_balances' | 'hesabati_customer_balances' | 'hesabati_operator_balances' | 'hesabati_building_balances' | 'arabic_retail' | 'generic_products' | 'unknown'} ImportType */

export const IMPORT_TYPE_LABELS = {
  hesabati_price_list: "قائمة الأسعار — حساباتي",
  hesabati_supplier_balances: "أرصدة الموردين — حساباتي",
  hesabati_customer_balances: "أرصدة الزبائن — حساباتي",
  hesabati_operator_balances: "أرصدة المشغلين — حساباتي",
  hesabati_building_balances: "أرصدة العمارة — حساباتي",
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
  if (n.includes("أرصدة زبون") || n.includes("ارصدة زبون") || n.includes("أرصدة الزبون")) {
    return "hesabati_customer_balances";
  }
  return null;
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
