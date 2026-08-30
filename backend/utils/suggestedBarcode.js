import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import { formatProductSku, parseNumericCode, PRODUCT_SKU_LENGTH } from "./entityCodes.js";

export const SUGGESTED_BARCODE_LENGTH = PRODUCT_SKU_LENGTH;
export const SUGGESTED_BARCODE_MAX_DIGITS = PRODUCT_SKU_LENGTH;

export { formatProductSku, PRODUCT_SKU_LENGTH };

/**
 * @param {number} n
 * @returns {string}
 */
export function padSuggestedBarcode(n) {
  const formatted = formatProductSku(n);
  if (!formatted) {
    throw new Error("Suggested barcode must be a positive integer");
  }
  return formatted;
}

/**
 * True when a barcode value is only the product رقم (same numeric value).
 * Used by the repair migration and the create-time warning — never to hide or
 * rewrite a legitimate barcode that happens to look like a رقم.
 * @param {unknown} barcode
 * @param {unknown} sku
 */
export function isProductNumberShaped(barcode, sku) {
  const b = formatProductSku(barcode);
  const s = formatProductSku(sku);
  return Boolean(b && s && b === s);
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

/**
 * Next 11-digit رقم المنتج. Always one past the high-water mark — never the lowest
 * free number, so a رقم released by deleting a product is not handed out again.
 * Does not inspect barcode tables — barcode and رقم are independent.
 *
 * entity_code_sequences.last_seq is the authority; ensureEntityCode reserves every
 * code it issues, so it already covers all live rows. MAX(sku) is only a fallback
 * for rows written before reservation existed. Both are read numerically because a
 * TEXT MAX would rank '5' above '00000000010'.
 * @param {object} db
 * @returns {Promise<string>}
 */
export async function getNextProductNumber(db) {
  const seqRow = await db.get(
    "SELECT last_seq FROM entity_code_sequences WHERE entity_type = 'product'"
  );
  const maxRow = await db.get(
    "SELECT MAX(CAST(sku AS INTEGER)) AS mx FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''"
  );
  const maxSku = parseNumericCode(maxRow?.mx) ?? 0;
  const lastSeq = Number(seqRow?.last_seq ?? 0);
  const next = Math.max(lastSeq, maxSku) + 1;
  return formatProductSku(next);
}

/** @deprecated Use getNextProductNumber — the value is a رقم, not a barcode. */
export const getNextSuggestedBarcode = getNextProductNumber;
