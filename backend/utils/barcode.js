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
  const text = normalizeArabicDigits(valueToText(value));
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
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
