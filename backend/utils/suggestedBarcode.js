import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import {
  formatProductSku,
  highestProductNumber,
  parseProductNumber,
  PRODUCT_SKU_LENGTH,
} from "./entityCodes.js";

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
    throw new Error("Suggested product number must be a positive integer");
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
 * Next رقم المنتج (plain integer text, no leading zeros). Always one past the
 * high-water mark — never the lowest free number, so a رقم released by deleting
 * a product is not handed out again. Does not inspect barcode tables — barcode
 * and رقم are independent.
 *
 * entity_code_sequences.last_seq is the authority; ensureEntityCode reserves every
 * code it issues, so it already covers all live rows. MAX(sku) is only a fallback
 * for rows written before reservation existed. Both are read numerically because a
 * TEXT MAX would rank '5' above '10'.
 * @param {object} db
 * @returns {Promise<string>}
 */
export async function getNextProductNumber(db) {
  const seqRow = await db.get(
    "SELECT last_seq FROM entity_code_sequences WHERE entity_type = 'product'"
  );
  const maxSku = await highestProductNumber(db);
  const lastSeq = parseProductNumber(seqRow?.last_seq) ?? 0;
  return formatProductSku(Math.max(lastSeq, maxSku) + 1);
}

/** @deprecated Use getNextProductNumber — the value is a رقم, not a barcode. */
export const getNextSuggestedBarcode = getNextProductNumber;
