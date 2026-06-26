import {
  barcodeIndexKeys,
  digitsOnly,
  normalizeBarcodeInput,
  preserveBarcodeString,
} from "./barcode.js";

/**
 * @typedef {{
 *   rowNum: number,
 *   name: string,
 *   barcode: string,
 *   priceFromMofraq: number,
 *   cost: number,
 *   category: string | null,
 *   stock: number,
 * }} SourceRow
 */

/**
 * @typedef {{
 *   byExactBarcode: Map<string, SourceRow>,
 *   byNormalizedKey: Map<string, SourceRow>,
 * }} SourceRowIndex
 */

/**
 * Pass 1: index every Excel row by its primary barcode (primary rows win on normalized keys).
 * @param {{ rowNum: number, row: object }[]} validRows
 * @returns {SourceRowIndex}
 */
export function buildSourceRowIndex(validRows) {
  /** @type {Map<string, SourceRow>} */
  const byExactBarcode = new Map();
  /** @type {Map<string, SourceRow>} */
  const byNormalizedKey = new Map();

  for (const { rowNum, row } of validRows) {
    const barcode = digitsOnly(normalizeBarcodeInput(preserveBarcodeString(row.barcode)));
    if (!barcode || barcode.length < 4 || barcode.length > 14) continue;

    const sourceRow = {
      rowNum,
      name: String(row.name ?? ""),
      barcode,
      priceFromMofraq: Number(row.price) || 0,
      cost: Number(row.cost) || 0,
      category: row.category ?? null,
      stock: Number(row.stock) || 0,
    };

    byExactBarcode.set(barcode, sourceRow);
    for (const key of barcodeIndexKeys(barcode)) {
      byNormalizedKey.set(key, sourceRow);
    }
  }

  return { byExactBarcode, byNormalizedKey };
}

/**
 * Merge indexes; later indexes overwrite earlier entries for the same key.
 * @param {...SourceRowIndex} indexes
 * @returns {SourceRowIndex}
 */
export function mergeSourceRowIndexes(...indexes) {
  /** @type {Map<string, SourceRow>} */
  const byExactBarcode = new Map();
  /** @type {Map<string, SourceRow>} */
  const byNormalizedKey = new Map();
  for (const idx of indexes) {
    for (const [k, v] of idx.byExactBarcode) byExactBarcode.set(k, v);
    for (const [k, v] of idx.byNormalizedKey) byNormalizedKey.set(k, v);
  }
  return { byExactBarcode, byNormalizedKey };
}

/**
 * @param {SourceRowIndex} sourceIndex
 * @returns {SourceRow | null}
 */
function lookupSourceRow(unitBarcode, sourceIndex) {
  const exact = digitsOnly(normalizeBarcodeInput(preserveBarcodeString(unitBarcode)));
  if (!exact) return null;

  const direct = sourceIndex.byExactBarcode.get(exact);
  if (direct) return direct;

  for (const key of barcodeIndexKeys(unitBarcode)) {
    const hit = sourceIndex.byNormalizedKey.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {string} a
 * @param {string} b
 */
function barcodesMatch(a, b) {
  const da = digitsOnly(normalizeBarcodeInput(preserveBarcodeString(a)));
  const db = digitsOnly(normalizeBarcodeInput(preserveBarcodeString(b)));
  if (!da || !db) return false;
  if (da === db) return true;
  const keysA = new Set(barcodeIndexKeys(a));
  for (const k of barcodeIndexKeys(b)) {
    if (keysA.has(k)) return true;
  }
  return false;
}

/**
 * Pass 2 price resolution for a unit barcode on a product row.
 * @param {{
 *   unitBarcode: string,
 *   currentRowNum: number,
 *   currentRowPrimary: string,
 *   currentRowPrice: number,
 *   sourceIndex: SourceRowIndex,
 * }} params
 * @returns {{ price: number, source: string, needsReview: boolean, matchedRowNum?: number }}
 */
export function resolveUnitPrice({
  unitBarcode,
  currentRowNum,
  currentRowPrimary,
  currentRowPrice,
  sourceIndex,
}) {
  const parentPrice = Number(currentRowPrice) || 0;

  if (barcodesMatch(unitBarcode, currentRowPrimary)) {
    return { price: parentPrice, source: "current_row", needsReview: false };
  }

  const matched = lookupSourceRow(unitBarcode, sourceIndex);
  if (matched) {
    if (matched.rowNum === currentRowNum) {
      return { price: parentPrice, source: "current_row", needsReview: false };
    }
    return {
      price: matched.priceFromMofraq,
      source: "matched_barcode_row",
      needsReview: false,
      matchedRowNum: matched.rowNum,
    };
  }

  return { price: parentPrice, source: "fallback_parent", needsReview: true };
}

/**
 * Build source index from existing products (for repair / migration).
 * @param {object} db
 * @returns {Promise<SourceRowIndex>}
 */
export async function buildSourceRowIndexFromProducts(db) {
  const products = await db.all(
    `SELECT id, barcode, name, price, cost, category, stock FROM products ORDER BY id ASC`
  );
  const validRows = products.map((p) => ({
    rowNum: p.id,
    row: {
      barcode: p.barcode,
      name: p.name,
      price: p.price,
      cost: p.cost,
      category: p.category,
      stock: p.stock,
    },
  }));
  return buildSourceRowIndex(validRows);
}
