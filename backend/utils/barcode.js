/**
 * Normalize scanner / manual input (trim, strip invisible chars, Arabic digits → Latin).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeBarcodeInput(raw) {
  if (raw == null) return "";
  let t = String(raw).trim();
  t = t.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  t = t.replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
  t = t.replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
  return t;
}

/** @param {unknown} value */
export function valueToText(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }

  return String(value);
}

/** @param {unknown} value */
export function normalizeArabicDigits(value) {
  return valueToText(value)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

/**
 * @param {unknown} value
 * @param {string | null} [fallbackLabel]
 * @returns {{ barcode: string, label: string | null }[]}
 */
export function extractBarcodeEntries(value, fallbackLabel = null) {
  const text = normalizeArabicDigits(value);
  /** @type {{ barcode: string, label: string | null }[]} */
  const entries = [];

  const labeledRegex = /(?:^|\r?\n)\s*([^:\n\r\d]{0,40}?)\s*[:：]\s*(\d{4,14})(?!\d)/g;

  let match;
  while ((match = labeledRegex.exec(text)) !== null) {
    entries.push({
      barcode: String(match[2]).trim(),
      label: match[1]?.trim() || fallbackLabel,
    });
  }

  const numberRegex = /(^|[^\d])(\d{4,14})(?!\d)/g;

  while ((match = numberRegex.exec(text)) !== null) {
    const barcode = String(match[2]).trim();

    if (!entries.some((e) => e.barcode === barcode)) {
      entries.push({
        barcode,
        label: fallbackLabel,
      });
    }
  }

  return entries;
}

/**
 * @param {{ barcode: string, label?: string | null }[]} entries
 * @returns {{ barcode: string, label: string | null }[]}
 */
export function uniqueBarcodeEntries(entries) {
  const seen = new Set();
  /** @type {{ barcode: string, label: string | null }[]} */
  const result = [];

  for (const entry of entries) {
    if (!entry.barcode) continue;
    if (seen.has(entry.barcode)) continue;

    seen.add(entry.barcode);
    result.push({
      barcode: String(entry.barcode).trim(),
      label: entry.label ?? null,
    });
  }

  return result;
}

/** @param {unknown} value */
export function parsePrice(value) {
  const text = normalizeArabicDigits(valueToText(value)).replace(/شبقل|₪|شيكل|shekel/gi, " ");
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

const UNIT_LINE_RE = /(?:^|\r?\n)\s*([^:\n\r\d]{0,40}?)\s*[:：]\s*([^\r\n]+)/g;
const BARCODE_TOKEN_RE = /\d{4,14}/g;

/**
 * Parse unit barcode lines: unit_name : barcode1 barcode2 ...
 * @param {unknown} value
 * @returns {{ unitName: string, barcodes: string[] }[]}
 */
export function parseUnitBarcodeLines(value) {
  const text = normalizeArabicDigits(valueToText(value)).replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  /** @type {{ unitName: string, barcodes: string[] }[]} */
  const lines = [];
  let match;
  const lineRe = new RegExp(UNIT_LINE_RE.source, "g");
  while ((match = lineRe.exec(text)) !== null) {
    const unitName = String(match[1] ?? "").trim();
    const afterColon = String(match[2] ?? "");
    const barcodes = [];
    let bm;
    const tokenRe = new RegExp(BARCODE_TOKEN_RE.source, "g");
    while ((bm = tokenRe.exec(afterColon)) !== null) {
      const code = bm[0];
      if (!barcodes.includes(code)) barcodes.push(code);
    }
    if (barcodes.length) {
      lines.push({ unitName, barcodes });
    }
  }
  return lines;
}

/** @param {unknown} value */
export function scientificToInteger(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)[eE]\+?(\d+)$/);
  if (!match) return text;

  const mantissa = match[1].replace("+", "");
  const exponent = Number(match[2]);

  const parts = mantissa.split(".");
  const beforeDecimal = parts[0];
  const afterDecimal = parts[1] || "";
  const digits = beforeDecimal + afterDecimal;
  const decimalPlaces = afterDecimal.length;
  const zerosToAdd = exponent - decimalPlaces;

  if (zerosToAdd >= 0) {
    return digits + "0".repeat(zerosToAdd);
  }

  return digits.slice(0, digits.length + zerosToAdd);
}

/** Digits only — for matching ": 2100002" vs scanned "2100002" */
export function digitsOnly(s) {
  return String(s ?? "").replace(/\D/g, "");
}

/**
 * String barcode for DB storage — avoids float/scientific corruption; preserves leading zeros.
 * @param {unknown} raw
 * @returns {string}
 */
export function preserveBarcodeString(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") {
    if (Number.isInteger(raw)) return raw.toFixed(0);
    return String(raw);
  }
  return normalizeBarcodeInput(raw);
}

/**
 * Lookup keys for barcode index (exact digits + leading-zero-stripped variant).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function barcodeIndexKeys(raw) {
  const digits = digitsOnly(preserveBarcodeString(raw));
  if (!digits) return [];
  const keys = new Set([digits]);
  const stripped = digits.replace(/^0+/, "") || "0";
  if (stripped !== digits) keys.add(stripped);
  return [...keys];
}

const DIGIT_EXTRACT_RE = /(^|[^\d])(\d{4,14})(?!\d)/g;
const LABEL_PAIR_RE = /([\u0600-\u06FF]+)\s*[:：]\s*(\d{4,14})/g;

/**
 * Extract digit barcodes from a single cell value (import path).
 * @param {unknown} value
 * @returns {string[]}
 */
export function extractBarcodesFromValue(value) {
  if (value === null || value === undefined) return [];

  let text = normalizeArabicDigits(value);
  text = text.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");

  text = text.replace(/[+-]?\d+(?:\.\d+)?[eE]\+?\d+/g, (token) => scientificToInteger(token));

  const results = [];
  const regex = new RegExp(DIGIT_EXTRACT_RE.source, "g");

  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push(match[2]);
  }

  return [...new Set(results)];
}

/**
 * Extract barcode + optional label from messy cell text (import / multi-barcode rows).
 * @param {unknown} text
 * @returns {{ barcode: string, label: string | null }[]}
 */
export function extractBarcodesFromText(text) {
  if (text === null || text === undefined || String(text).trim() === "") return [];

  const normalized = normalizeArabicDigits(text).replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");

  /** @type {Map<string, string | null>} */
  const byCode = new Map();

  let m;
  const labelRe = new RegExp(LABEL_PAIR_RE.source, "g");
  while ((m = labelRe.exec(normalized)) !== null) {
    const code = m[2];
    if (code.length < 4 || code.length > 14) continue;
    const label = String(m[1]).trim().replace(/[:：]+$/, "").trim() || null;
    if (!byCode.has(code)) byCode.set(code, label);
  }

  for (const code of extractBarcodesFromValue(normalized)) {
    if (!byCode.has(code)) byCode.set(code, null);
  }

  return [...byCode.entries()].map(([barcode, label]) => ({ barcode, label }));
}

/** EAN-13 prefix for scale-printed weight-embedded barcodes (prefix + 5-digit item + 5-digit grams + check). */
export const WEIGHT_BARCODE_PREFIX = "21";

/**
 * Parse a scale weight-embedded EAN-13 barcode.
 * Example: 2100003015504 → productCode 2100003, weightKg 1.550
 * @param {unknown} rawCode
 * @returns {{ productCode: string, weightKg: number, weightGrams: number } | null}
 */
export function parseWeightBarcode(rawCode) {
  const code = digitsOnly(normalizeBarcodeInput(rawCode));
  if (code.length !== 13) return null;
  if (!code.startsWith(WEIGHT_BARCODE_PREFIX)) return null;

  const productCode = code.slice(0, 7);
  const weightGrams = Number(code.slice(7, 12));
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) return null;

  const weightKg = weightGrams / 1000;
  return { productCode, weightGrams, weightKg };
}

export function barcodeLookupKeys(key) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  push(key);
  if (!/^\d+$/.test(key)) return out;

  const stripped = key.replace(/^0+/, "") || "0";
  push(stripped);

  if (key.length === 12) push("0" + key);
  if (key.length === 13 && key.startsWith("0")) push(key.slice(1));

  const d = digitsOnly(key);
  if (d.length >= 4 && d.length <= 14 && d !== key) push(d);

  return out;
}

/**
 * Pick primary barcode: longest 8+ digit code, else first extracted.
 * @param {{ barcode: string }[]} barcodes
 * @returns {string | null}
 */
export function pickPrimaryBarcode(barcodes) {
  if (!barcodes?.length) return null;
  const long = barcodes.filter((b) => b.barcode.length >= 8);
  if (long.length) {
    return long.sort((a, b) => b.barcode.length - a.barcode.length)[0].barcode;
  }
  return barcodes[0].barcode;
}

/**
 * @param {object} db
 * @param {unknown} rawCode
 */
export async function findProductByBarcode(db, rawCode) {
  const scannedBarcode = normalizeBarcodeInput(rawCode);
  if (!scannedBarcode) return null;

  const keys = barcodeLookupKeys(scannedBarcode);

  for (const k of keys) {
    const row = await db.get(
      `SELECT pb.id AS product_barcode_id, pb.barcode AS matched_barcode, pb.is_primary,
              p.*
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [k]
    );
    if (row) {
      return {
        product: row,
        matchedBarcode: row.matched_barcode,
        productBarcodeId: row.product_barcode_id,
        scannedBarcode,
      };
    }
  }

  const d = digitsOnly(scannedBarcode);
  if (d.length >= 4 && d.length <= 14) {
    const row = await db.get(
      `SELECT pb.id AS product_barcode_id, pb.barcode AS matched_barcode, pb.is_primary,
              p.*
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [d]
    );
    if (row) {
      return {
        product: row,
        matchedBarcode: row.matched_barcode,
        productBarcodeId: row.product_barcode_id,
        scannedBarcode,
      };
    }
  }

  let row = null;
  for (const k of keys) {
    row = await db.get("SELECT * FROM products WHERE barcode = ?", [k]);
    if (row) break;
  }
  if (!row) {
    if (d.length >= 4 && d.length <= 14) {
      row = await db.get(
        `SELECT * FROM products WHERE
           trim(replace(replace(replace(replace(barcode, char(58), ''), ' ', ''), char(10), ''), char(13), '')) = ?
           OR barcode = ?`,
        [d, d]
      );
    }
  }
  if (!row) {
    if (d.length >= 8) {
      row = await db.get(
        `SELECT * FROM products WHERE barcode LIKE '%' || ? || '%' ESCAPE '\\'`,
        [d]
      );
    }
  }
  if (!row) return null;

  const pbRow = await db.get(
    "SELECT id, barcode FROM product_barcodes WHERE product_id = ? AND barcode = ?",
    [row.id, row.barcode]
  );

  return {
    product: row,
    matchedBarcode: pbRow?.barcode ?? row.barcode,
    productBarcodeId: pbRow?.id ?? null,
    scannedBarcode,
  };
}
