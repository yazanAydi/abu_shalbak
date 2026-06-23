import { parse } from "csv-parse/sync";
import XLSX from "xlsx";

/** @typedef {{ barcode: string, name: string, price: number, cost: number, category: string | null, stock: number }} ProductRow */

/** Hard cap on data rows accepted from a single import file (DoS guard). */
export const MAX_IMPORT_ROWS = 50000;

/** Keys that must never be copied from untrusted input (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenKey(key) {
  return FORBIDDEN_KEYS.has(String(key).trim().toLowerCase());
}

const HEADER_PATTERNS = [
  /* Before main "barcode" — column "باركود الوحدات" must not match as barcode */
  { field: "barcode_units", re: /^باركود الوحدات$|باركود الوحدات|وحدات الباركود/i },
  {
    field: "barcode",
    re: /^باركود$|barcode|الباركود|الكود|^code$|sku|رقم الصنف|رقم المنتج|رقم المادة|كود|bk\.?code/i,
  },
  { field: "name", re: /name|الاسم|^الاسم$|المادة|البيان|الصنف|صنف|وصف|المنتج|description|item|اسم المنتج/i },
  { field: "name_en", re: /name_en|الاسم الإنجليزي|الاسم انجليزي|english name/i },
  {
    field: "price",
    re: /price|السعر|سعر|سعر البيع|بيع|المبيع|المبلغ|مفرق|تسعيرة|amount|قيمة|شيكل|₪/i,
  },
  { field: "cost", re: /cost|التكلفة|تكلفة|شراء|سعر الشراء/i },
  { field: "stock", re: /stock|المخزون|الكمية|كمية|qty|quantity|رصيد/i },
  { field: "category", re: /category|cat|التصنيف|الفئة|فئة|قسم|نوع/i },
  { field: "tax_rate", re: /tax_rate|^tax$|الضريبة|نسبة الضريبة|ضريبة/i },
  { field: "unit", re: /^unit$|الوحدة|وحدة القياس|unit_name|الحجم/i },
  { field: "expiry_date", re: /expiry|صلاحية|تاريخ الانتهاء|تاريخ الصلاحية/i },
  { field: "min_price", re: /min_price|السعر الأدنى|أدنى سعر/i },
  { field: "max_price", re: /max_price|السعر الأقصى|أقصى سعر/i },
];

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function classifyHeader(raw) {
  const s = String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!s) return null;
  // Sequence / line number columns — not product barcode
  if (/^الرقم$/i.test(s) || /^#$/i.test(s) || /^م\s*$/i.test(s) || /^no\.?$/i.test(s)) {
    return null;
  }
  for (const { field, re } of HEADER_PATTERNS) {
    if (re.test(s)) return field;
  }
  return null;
}

/**
 * @param {unknown[][]} matrix
 * @returns {{ headerRow: number, colMap: Record<string, number> } | null}
 */
function detectHeaderAndColumns(matrix) {
  let best = null;
  for (let r = 0; r < Math.min(matrix.length, 30); r++) {
    const row = matrix[r] || [];
    /** @type {Record<string, number>} */
    const colMap = {};
    /** Prefer real barcode column over stray matches: باركود before generic كود */
    const candidates = [];
    for (let c = 0; c < row.length; c++) {
      const field = classifyHeader(row[c]);
      if (field) candidates.push({ field, c, h: String(row[c] ?? "").trim() });
    }
    const pickFirst = (f) => {
      const list = candidates.filter((x) => x.field === f);
      if (list.length === 0) return;
      const preferBar = list.find((x) => /باركود/i.test(x.h));
      colMap[f] = (preferBar || list[0]).c;
    };
    pickFirst("barcode_units");
    pickFirst("barcode");
    pickFirst("name");
    pickFirst("name_en");
    pickFirst("price");
    pickFirst("cost");
    pickFirst("stock");
    pickFirst("category");
    pickFirst("tax_rate");
    pickFirst("unit");
    pickFirst("expiry_date");
    pickFirst("min_price");
    pickFirst("max_price");
    for (const { field, c } of candidates) {
      if (colMap[field] === undefined) colMap[field] = c;
    }
    const score = Object.keys(colMap).length;
    if (score >= 2 && (!best || score > best.score)) {
      best = { headerRow: r, colMap, score };
    }
  }
  if (!best || !best.colMap.barcode || !best.colMap.name) {
    return null;
  }
  return { headerRow: best.headerRow, colMap: best.colMap };
}

/**
 * @param {unknown[][]} matrix
 * @param {number} headerRow
 * @param {Record<string, number>} colMap
 * @returns {Record<string, string>[]}
 */
function rowsFromMatrix(matrix, headerRow, colMap) {
  const out = [];
  if (matrix.length - headerRow - 1 > MAX_IMPORT_ROWS) {
    throw new Error(
      `الملف يحتوي صفوفاً أكثر من الحد المسموح (${MAX_IMPORT_ROWS}). قسّم الملف إلى أجزاء أصغر.`
    );
  }
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const line = matrix[r] || [];
    /** @type {Record<string, string>} */
    const o = {};
    for (const [k, idx] of Object.entries(colMap)) {
      const v = line[idx];
      o[k] = v === undefined || v === null ? "" : String(v).trim();
    }
    out.push(o);
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, string>[]}
 */
export function xlsxBufferToHeaderRows(buffer) {
  // cellFormula:false → never parse/evaluate spreadsheet formulas; we only read
  // cached cell values as plain data.
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    bookVBA: false,
  });
  const name = wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (!Array.isArray(matrix) || matrix.length === 0) return [];

  const det = detectHeaderAndColumns(matrix);
  if (!det) {
    throw new Error(
      "تعذّر العثور على أعمدة الباركود واسم المنتج. أضف عناوين مثل: barcode, name, price أو ما يعادلها بالعربية."
    );
  }
  return rowsFromMatrix(matrix, det.headerRow, det.colMap);
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, string>[]}
 */
export function csvBufferToRecords(buffer) {
  const raw = buffer.toString("utf8").trim();
  if (!raw) return [];
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (records.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `الملف يحتوي صفوفاً أكثر من الحد المسموح (${MAX_IMPORT_ROWS}). قسّم الملف إلى أجزاء أصغر.`
    );
  }
  // Strip any prototype-pollution keys that a crafted header could introduce.
  return records.map((rec) => {
    const clean = {};
    for (const [k, v] of Object.entries(rec)) {
      if (isForbiddenKey(k)) continue;
      clean[k] = v;
    }
    return clean;
  });
}

/**
 * Excel sometimes exports long barcodes as scientific strings.
 * @param {unknown} val
 * @returns {string}
 */
function normalizeBarcodeValue(val) {
  if (val === undefined || val === null || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val)) {
    if (Math.abs(val) >= 1e6) return String(Math.round(val));
    return String(val);
  }
  let s = String(val).trim().replace(/,/g, "");
  if (/^[\d.]+[eE][+-]?\d+$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? String(Math.round(n)) : s;
  }
  return s;
}

/**
 * Parse numbers from cells like "12 شبقل", "1.5 شبقل", or plain "3.50"
 * @param {unknown} val
 * @returns {number}
 */
/**
 * Long EANs in "باركود الوحدات" as text: "علبة : 6253503521433"
 * @param {string} text
 * @returns {string | null}
 */
/**
 * Longest run of 4–14 digits (EAN/UPC/local codes). Picks real code from ": 2100002" or "علبة: 625…".
 * @param {string} text
 * @returns {string | null}
 */
function longestDigitBarcode(text) {
  const s = String(text ?? "");
  const matches = s.match(/\d{4,14}/g);
  if (!matches) return null;
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

function parseMoneyCell(val) {
  if (val === undefined || val === null || val === "") return NaN;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const s = String(val).trim().replace(/,/g, ".");
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return NaN;
  return Number(m[0].replace(",", "."));
}

/**
 * Map spreadsheet/CSV row keys to canonical fields (English or Arabic headers).
 * @param {Record<string, unknown>} row
 * @returns {Record<string, string>}
 */
function canonicalizeRow(row) {
  /** @type {Record<string, string>} */
  const canon = {};
  for (const [k, v] of Object.entries(row)) {
    const field = classifyHeader(k);
    if (field && canon[field] === undefined) {
      canon[field] = v === undefined || v === null ? "" : String(v).trim();
    }
  }
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(row)) {
    if (isForbiddenKey(k)) continue;
    lower[String(k).trim().toLowerCase()] = v;
  }
  const pick = (key) =>
    canon[key] !== undefined && canon[key] !== ""
      ? canon[key]
      : lower[key] !== undefined && lower[key] !== null
        ? String(lower[key]).trim()
        : "";
  const mainRaw = pick("barcode");
  const unitsRaw = pick("barcode_units");
  const mergedDigits = longestDigitBarcode(`${unitsRaw} ${mainRaw}`);
  const mainDigits = longestDigitBarcode(mainRaw);
  const unitDigits = longestDigitBarcode(unitsRaw);
  let barcode = "";
  if (unitDigits && unitDigits.length >= 8) {
    barcode = unitDigits;
  } else if (mergedDigits) {
    barcode = mergedDigits;
  } else if (mainDigits) {
    barcode = mainDigits;
  } else if (unitDigits) {
    barcode = unitDigits;
  } else {
    barcode = normalizeBarcodeValue(mainRaw);
  }
  return {
    barcode,
    name: pick("name"),
    name_en: pick("name_en"),
    price: pick("price"),
    cost: pick("cost"),
    stock: pick("stock"),
    category: pick("category"),
    tax_rate: pick("tax_rate"),
    unit: pick("unit"),
    expiry_date: pick("expiry_date"),
    min_price: pick("min_price"),
    max_price: pick("max_price"),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ ok: true, row: ProductRow } | { ok: false, reason: string }}
 */
export function normalizeProductRow(row) {
  const c = canonicalizeRow(row);
  const barcode = normalizeBarcodeValue(c.barcode);
  const name = c.name;
  const price = c.price !== "" ? parseMoneyCell(c.price) : NaN;
  const stockRaw = c.stock !== "" ? parseMoneyCell(c.stock) : NaN;
  const stock = Number.isNaN(stockRaw) ? 0 : Math.max(0, Math.floor(stockRaw));
  const cost = c.cost !== "" ? parseMoneyCell(c.cost) : 0;
  const category =
    c.category != null && String(c.category).trim() !== ""
      ? String(c.category).trim()
      : null;

  if (!barcode || !name || Number.isNaN(price)) {
    return { ok: false, reason: "الباركود أو الاسم أو السعر الصالح مفقود" };
  }

  const taxRateRaw = c.tax_rate !== "" ? parseMoneyCell(c.tax_rate) : null;
  let tax_rate = null;
  if (taxRateRaw !== null && Number.isFinite(taxRateRaw)) {
    tax_rate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw;
  }
  const name_en = c.name_en && c.name_en !== "" ? c.name_en : null;
  const unit = c.unit && c.unit !== "" ? c.unit : null;
  const expiry_date = c.expiry_date && c.expiry_date !== "" ? c.expiry_date : null;
  const minPriceRaw = c.min_price !== "" ? parseMoneyCell(c.min_price) : null;
  const maxPriceRaw = c.max_price !== "" ? parseMoneyCell(c.max_price) : null;
  const min_price = minPriceRaw !== null && Number.isFinite(minPriceRaw) ? minPriceRaw : null;
  const max_price = maxPriceRaw !== null && Number.isFinite(maxPriceRaw) ? maxPriceRaw : null;

  return {
    ok: true,
    row: {
      barcode,
      name,
      name_en,
      price,
      cost: Number.isNaN(Number(cost)) ? 0 : Number(cost),
      category,
      stock,
      tax_rate,
      unit,
      expiry_date,
      min_price,
      max_price,
    },
  };
}
