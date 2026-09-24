/**
 * Scale-label layout. Must stay aligned with backend/utils/barcode.js
 * parseWeightBarcode — PLU checks round-trip that decoder, they do not
 * invent a second code width.
 */
export const WEIGHT_BARCODE_PREFIX = "21";
export const WEIGHT_LABEL_LENGTH = 13;
export const WEIGHT_GRAMS_LENGTH = 5;
export const WEIGHT_CHECK_LENGTH = 1;

export function scaleProductCodeLength() {
  return WEIGHT_LABEL_LENGTH - WEIGHT_GRAMS_LENGTH - WEIGHT_CHECK_LENGTH;
}

function digitsOnly(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Same shape as backend parseWeightBarcode. */
export function parseWeightBarcode(rawCode) {
  const code = digitsOnly(rawCode);
  if (code.length !== WEIGHT_LABEL_LENGTH) return null;
  if (!code.startsWith(WEIGHT_BARCODE_PREFIX)) return null;
  const productCodeLength = scaleProductCodeLength();
  const productCode = code.slice(0, productCodeLength);
  const gramsText = code.slice(productCodeLength, productCodeLength + WEIGHT_GRAMS_LENGTH);
  const weightGrams = Number(gramsText);
  if (!/^\d+$/.test(gramsText) || !Number.isFinite(weightGrams) || weightGrams <= 0) return null;
  return { productCode, weightGrams, weightKg: weightGrams / 1000 };
}

/** Keep the PLU as text, including zeros. Never Number(). */
export function normalizeScaleProductCode(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return "";
    return String(raw);
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return "";
  return text;
}

export function isValidScaleProductCode(raw) {
  const code = normalizeScaleProductCode(raw);
  if (!code || code.length !== scaleProductCodeLength()) return false;
  const grams = "1".padStart(WEIGHT_GRAMS_LENGTH, "0");
  const check = "0".repeat(WEIGHT_CHECK_LENGTH);
  const parsed = parseWeightBarcode(`${code}${grams}${check}`);
  return parsed != null && parsed.productCode === code;
}
