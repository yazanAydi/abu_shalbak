import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import { parseNumericCode } from "./entityCodes.js";

export const SUGGESTED_BARCODE_LENGTH = 11;
export const SUGGESTED_BARCODE_MAX_DIGITS = 11;

/**
 * @param {number} n
 * @returns {string}
 */
export function padSuggestedBarcode(n) {
  const value = Math.floor(Number(n));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Suggested barcode must be a positive integer");
  }
  return String(value).padStart(SUGGESTED_BARCODE_LENGTH, "0");
}

/**
 * Keep a product رقم as 11-digit zero-padded text when it is numeric.
 * @param {unknown} code
 * @returns {string | null}
 */
export function formatProductSku(code) {
  if (code == null) return null;
  const s = String(code).trim();
  if (!s) return null;
  const n = parseNumericCode(s);
  return n != null ? padSuggestedBarcode(n) : s;
}

/**
 * True when barcode is only the product رقم (same numeric value, often 11-digit padded).
 * @param {unknown} barcode
 * @param {unknown} sku
 */
export function isSkuShapedBarcode(barcode, sku) {
  const b = formatProductSku(barcode);
  const s = formatProductSku(sku);
  return Boolean(b && s && b === s);
}

/**
 * Prefer a real scanned barcode over a generated رقم stored in products.barcode.
 * @param {unknown} primary
 * @param {unknown} sku
 * @param {unknown[]} [extras]
 * @returns {string}
 */
export function pickDisplayBarcode(primary, sku, extras = []) {
  for (const raw of [primary, ...extras]) {
    const code = raw != null ? String(raw).trim() : "";
    if (!code) continue;
    if (!isSkuShapedBarcode(code, sku)) return code;
  }
  return "";
}

/**
 * Set barcode_display on each product row from primary + unit/alias barcodes.
 * @param {object} db
 * @param {object[]} rows
 */
export async function attachDisplayBarcodes(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;
  const ids = [...new Set(list.map((r) => Number(r.id)).filter((n) => n > 0))];
  /** @type {Map<number, string[]>} */
  const extrasById = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const [fromBarcodes, fromUnits] = await Promise.all([
      db.all(
        `SELECT product_id, barcode FROM product_barcodes WHERE product_id IN (${placeholders})`,
        ids
      ),
      db.all(
        `SELECT product_id, barcode FROM product_units
         WHERE product_id IN (${placeholders}) AND barcode IS NOT NULL AND TRIM(barcode) != ''`,
        ids
      ),
    ]);
    for (const row of [...fromBarcodes, ...fromUnits]) {
      const id = Number(row.product_id);
      if (!extrasById.has(id)) extrasById.set(id, []);
      extrasById.get(id).push(row.barcode);
    }
  }
  for (const row of list) {
    row.barcode_display = pickDisplayBarcode(
      row.barcode,
      row.sku,
      extrasById.get(Number(row.id)) || []
    );
  }
  return list;
}

/**
 * Parse a barcode as a short numeric candidate (1–11 digits).
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseShortNumericBarcode(raw) {
  const digits = digitsOnly(normalizeBarcodeInput(raw));
  if (!digits || digits.length > SUGGESTED_BARCODE_MAX_DIGITS) return null;
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

const BARCODE_SOURCES_SQL = `
  SELECT barcode FROM products
  UNION
  SELECT barcode FROM product_barcodes
  UNION
  SELECT barcode FROM product_units
  UNION
  SELECT barcode FROM product_unit_barcodes
`;

/**
 * Collect numeric values already used by short barcodes (1–11 digits).
 * @param {object} db
 * @returns {Promise<{ used: Set<number>, max: number }>}
 */
export async function collectShortNumericBarcodes(db) {
  const rows = await db.all(BARCODE_SOURCES_SQL);
  /** @type {Set<number>} */
  const used = new Set();
  let max = 0;

  for (const row of rows) {
    const n = parseShortNumericBarcode(row?.barcode);
    if (n == null) continue;
    used.add(n);
    max = Math.max(max, n);
  }

  return { used, max };
}

/**
 * Product order baseline: how many products exist and the highest numeric SKU (الرقم).
 * @param {object} db
 * @returns {Promise<number>}
 */
export async function getProductOrderBaseline(db) {
  const countRow = await db.get("SELECT COUNT(*) AS c FROM products");
  const productCount = Number(countRow?.c ?? 0);

  const skuRows = await db.all(
    "SELECT sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''"
  );
  let maxSku = 0;
  for (const row of skuRows) {
    const n = parseNumericCode(row.sku);
    if (n != null) maxSku = Math.max(maxSku, n);
  }

  return Math.max(productCount, maxSku);
}

/**
 * Next free 11-digit zero-padded barcode based on product order and existing codes.
 * @param {object} db
 * @returns {Promise<string>}
 */
export async function getNextSuggestedBarcode(db) {
  const { used } = await collectShortNumericBarcodes(db);
  const orderBaseline = await getProductOrderBaseline(db);
  let candidate = orderBaseline > 0 ? orderBaseline + 1 : 1;

  while (used.has(candidate)) {
    candidate += 1;
  }

  return padSuggestedBarcode(candidate);
}
