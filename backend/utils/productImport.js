import { parse } from "csv-parse/sync";
import XLSX from "xlsx";
import {
  extractBarcodeEntries,
  extractBarcodesFromText,
  extractBarcodesFromValue,
  normalizeBarcodeInput,
  parsePrice,
  pickPrimaryBarcode,
  uniqueBarcodeEntries,
  valueToText,
} from "./barcode.js";

/** @typedef {{ barcode: string, label: string | null }[]} BarcodeEntry */
/** @typedef {{ col: number, header: string, raw: string, formatted: string, fromScientific: boolean }} BarcodeRawCell */
/**
 * @typedef {{
 *   barcode: string,
 *   barcodes: BarcodeEntry,
 *   name: string,
 *   price: number,
 *   cost: number,
 *   category: string | null,
 *   stock: number,
 *   shortCodes: string[],
 *   scientificCellsDetected: number,
 *   _barcodeRawCells?: BarcodeRawCell[],
 *   _barcodesExtracted?: string[],
 * }} ProductRow
 */

export const MAX_IMPORT_ROWS = 50000;

/** Log full import trace when product name matches this substring */
export const DEBUG_IMPORT_PRODUCT_NAME = "عصير بريجات";
export const DEBUG_BARCODE = "6223001858911";

/** Fixed column indices for Arabic retail layout (A=0 … E=4) */
const RETAIL_NAME_COL = 1;
const RETAIL_MAIN_BARCODE_COL = 2;
const RETAIL_UNIT_BARCODE_COL = 3;
const RETAIL_PRICE_COL = 4;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Columns whose cell values must never be scanned for barcodes */
const EXCLUDED_BARCODE_SCAN_FIELDS = new Set([
  "price",
  "cost",
  "stock",
  "tax_rate",
  "min_price",
  "max_price",
]);

const BARCODE_SCAN_HEADER_RE =
  /barcodes?|باركود|الباركود|كود\s*الصنف|كود|unit\s*barcode|package\s*barcode|وحدات\s*الباركود|باركود\s*الوحدات|bk\.?code|sku|رقم\s*الصنف|رقم\s*المنتج|رقم\s*المادة/i;

const EXCLUDED_HEADER_RE =
  /price|cost|stock|quantity|qty|السعر|التكلفة|الكمية|المخزون|سعر|amount|قيمة|₪|tax_rate|^tax$|الضريبة|min_price|max_price|السعر\s*الأدنى|السعر\s*الأقصى/i;

const ARABIC_LABEL_CELL_RE = /(علبة|حبة|قنينة|كيس|جالون|كرتونة)\s*[:：]/;

function isForbiddenKey(key) {
  return FORBIDDEN_KEYS.has(String(key).trim().toLowerCase());
}

const HEADER_PATTERNS = [
  { field: "barcode_units", re: /^باركود الوحدات$|باركود الوحدات|وحدات الباركود/i },
  {
    field: "barcode",
    re: /^barcodes?$|^باركود$|barcodes?|الباركود|الكود|^code$|sku|رقم الصنف|رقم المنتج|رقم المادة|كود الصنف|كود|bk\.?code|unit barcode|package barcode/i,
  },
  { field: "name", re: /name|الاسم|^الاسم$|المادة|البيان|الصنف|صنف|وصف|المنتج|description|item|اسم المنتج/i },
  { field: "name_en", re: /name_en|الاسم الإنجليزي|الاسم انجليزي|english name/i },
  {
    field: "price",
    re: /price|السعر|سعر|سعر البيع|بيع|المبيع|المبلغ|مفرق|تسعيرة|amount|قيمة|شيكل|₪/i,
  },
  { field: "cost", re: /cost|التكلفة|تكلفة|شراء|سعر الشراء/i },
  { field: "stock", re: /stock|المخزون|الكمية|qty|quantity|رصيد/i },
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
  if (/^الرقم$/i.test(s) || /^#$/i.test(s) || /^م\s*$/i.test(s) || /^no\.?$/i.test(s)) {
    return null;
  }
  for (const { field, re } of HEADER_PATTERNS) {
    if (re.test(s)) return field;
  }
  return null;
}

/**
 * @param {string} headerText
 * @param {string | null} field
 */
export function isBarcodeScanColumn(headerText, field) {
  if (field && EXCLUDED_BARCODE_SCAN_FIELDS.has(field)) return false;
  const h = String(headerText ?? "").trim();
  if (!h) return false;
  if (EXCLUDED_HEADER_RE.test(h)) return false;
  if (field === "barcode" || field === "barcode_units") return true;
  return BARCODE_SCAN_HEADER_RE.test(h);
}

/**
 * @param {string} headerText
 * @param {string | null} field
 */
export function isExcludedFromBarcodeScan(headerText, field) {
  if (field && EXCLUDED_BARCODE_SCAN_FIELDS.has(field)) return true;
  const h = String(headerText ?? "").trim();
  if (!h) return false;
  return EXCLUDED_HEADER_RE.test(h);
}

/**
 * @param {import('xlsx').CellObject | undefined} cell
 * @returns {{ raw: string, formatted: string, fromScientific: boolean }}
 */
export function cellTextsForBarcode(cell) {
  if (!cell) return { raw: "", formatted: "", fromScientific: false };

  let raw = "";
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
    raw = String(Math.trunc(cell.v));
  } else if (cell.v !== undefined && cell.v !== null) {
    raw = String(cell.v);
  }

  const formatted = cell.w != null ? String(cell.w) : raw;
  const fromScientific =
    /[eE]\+?\d+/.test(formatted) ||
    (typeof cell.v === "number" && Math.abs(cell.v) >= 1e6 && /[eE]/.test(formatted));

  return { raw, formatted, fromScientific };
}

/**
 * @param {import('xlsx').CellObject | undefined} cell
 * @returns {string}
 */
function cellDisplayValue(cell) {
  if (!cell) return "";
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
    return String(cell.v);
  }
  if (cell.w != null && String(cell.w).trim() !== "") return String(cell.w);
  if (cell.v !== undefined && cell.v !== null) return String(cell.v);
  return "";
}

/**
 * @param {unknown[][]} matrix
 * @returns {number}
 */
export function findArabicRetailHeaderRow(matrix) {
  for (let r = 0; r < Math.min(matrix.length, 10); r++) {
    const row = matrix[r] || [];
    const nameHeader = String(row[RETAIL_NAME_COL] ?? "").trim();
    const unitHeader = String(row[RETAIL_UNIT_BARCODE_COL] ?? "").trim();
    if (nameHeader === "الاسم" && unitHeader.includes("باركود الوحدات")) {
      return r;
    }
  }
  if (isArabicRetailFormat(matrix[0])) return 0;
  return -1;
}

/**
 * @param {unknown[]} headerRow
 */
export function isArabicRetailFormat(headerRow) {
  const row = headerRow || [];
  return (
    String(row[RETAIL_NAME_COL] ?? "").trim() === "الاسم" &&
    String(row[RETAIL_MAIN_BARCODE_COL] ?? "").trim() === "باركود" &&
    String(row[RETAIL_UNIT_BARCODE_COL] ?? "").trim().includes("باركود الوحدات") &&
    String(row[RETAIL_PRICE_COL] ?? "").trim() === "مفرق"
  );
}

/**
 * Read barcode column text from XLSX sheet cells (prefers cell.w / multiline strings).
 * @param {import('xlsx').WorkSheet | null | undefined} sheet
 * @param {number} rowIndex
 * @param {number} col
 * @param {unknown} fallback
 */
function retailBarcodeCellText(sheet, rowIndex, col, fallback) {
  if (!sheet) return valueToText(fallback);
  const addr = XLSX.utils.encode_cell({ r: rowIndex, c: col });
  const cell = sheet[addr];
  if (!cell) return valueToText(fallback);
  if (typeof cell.v === "string") return cell.v;
  const { raw, formatted } = cellTextsForBarcode(cell);
  if (formatted && /[:\n\r]/.test(formatted)) return formatted;
  if (raw) return raw;
  return valueToText(fallback);
}

/**
 * @param {unknown[][]} rows
 * @param {number} [headerRowIndex]
 * @param {import('xlsx').WorkSheet | null} [sheet]
 * @returns {Record<string, unknown>[]}
 */
export function parseArabicRetailMatrix(rows, headerRowIndex = 0, sheet = null) {
  const dataRowCount = rows.length - headerRowIndex - 1;
  if (dataRowCount > MAX_IMPORT_ROWS) {
    throw new Error(
      `الملف يحتوي صفوفاً أكثر من الحد المسموح (${MAX_IMPORT_ROWS}). قسّم الملف إلى أجزاء أصغر.`
    );
  }

  console.info(
    `[import] path=arabic_retail_fixed headerRow=${headerRowIndex} matrixRows=${rows.length}`
  );

  const out = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const productName = valueToText(row[RETAIL_NAME_COL]).trim();
    if (!productName) continue;

    const mainBarcodeValue = retailBarcodeCellText(
      sheet,
      i,
      RETAIL_MAIN_BARCODE_COL,
      row[RETAIL_MAIN_BARCODE_COL]
    );
    const unitBarcodeValue = retailBarcodeCellText(
      sheet,
      i,
      RETAIL_UNIT_BARCODE_COL,
      row[RETAIL_UNIT_BARCODE_COL]
    );
    const retailPriceValue = row[RETAIL_PRICE_COL];

    const primaryEntries = extractBarcodeEntries(mainBarcodeValue, "أساسي");
    const unitEntries = extractBarcodeEntries(unitBarcodeValue, null);
    const allBarcodeEntries = uniqueBarcodeEntries([...primaryEntries, ...unitEntries]);

    const primaryBarcode = String(
      primaryEntries[0]?.barcode ?? allBarcodeEntries[0]?.barcode ?? ""
    ).trim();

    if (allBarcodeEntries.length === 0) continue;

    const barcodes = allBarcodeEntries.map((e) => ({
      barcode: e.barcode,
      label: e.label,
      is_primary: e.barcode === primaryBarcode,
    }));

    const parsed = {
      name: productName,
      price: parsePrice(retailPriceValue),
      stock: 0,
      cost: 0,
      barcode: primaryBarcode,
      barcodes,
      _importFormat: "arabic_retail",
      _rawMainBarcode: mainBarcodeValue,
      _rawUnitBarcodes: unitBarcodeValue,
      _rawName: row[RETAIL_NAME_COL],
      _productNumber: row[0] ?? null,
      _barcodesExtracted: barcodes.map((b) => b.barcode),
      _matrixRowIndex: i,
    };

    if (productName.includes(DEBUG_IMPORT_PRODUCT_NAME)) {
      console.info(
        `[import][debug] parse row=${i + 1} name=${JSON.stringify(row[RETAIL_NAME_COL])} rawMain=${JSON.stringify({ type: typeof mainBarcodeValue, value: mainBarcodeValue })} rawUnit=${JSON.stringify({ type: typeof unitBarcodeValue, value: unitBarcodeValue })} extracted=${JSON.stringify(parsed._barcodesExtracted)}`
      );
    }

    if (parsed._barcodesExtracted.includes(DEBUG_BARCODE)) {
      console.info(
        `[import][debug-barcode] parse row=${i + 1} name=${JSON.stringify(productName)} extracted=true barcodes=${JSON.stringify(parsed._barcodesExtracted)} rawUnit=${JSON.stringify(unitBarcodeValue)}`
      );
    } else if (
      String(unitBarcodeValue).includes(DEBUG_BARCODE) ||
      String(mainBarcodeValue).includes(DEBUG_BARCODE)
    ) {
      console.info(
        `[import][debug-barcode] parse row=${i + 1} name=${JSON.stringify(productName)} extracted=false rawMain=${JSON.stringify(mainBarcodeValue)} rawUnit=${JSON.stringify(unitBarcodeValue)}`
      );
    }

    out.push(parsed);
  }

  return out;
}

/**
 * @param {unknown[][]} matrix
 */
function detectHeaderAndColumns(matrix) {
  let best = null;
  for (let r = 0; r < Math.min(matrix.length, 30); r++) {
    const row = matrix[r] || [];
    /** @type {Record<string, number>} */
    const colMap = {};
    /** @type {{ c: number, h: string, field: string | null }[]} */
    const colMeta = [];
    const candidates = [];
    for (let c = 0; c < row.length; c++) {
      const h = String(row[c] ?? "").trim();
      const field = classifyHeader(row[c]);
      colMeta.push({ c, h, field });
      if (field) candidates.push({ field, c, h });
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
      best = { headerRow: r, colMap, colMeta, score };
    }
  }
  if (!best || best.colMap.barcode === undefined || best.colMap.name === undefined) {
    return null;
  }
  return best;
}

/**
 * @param {import('xlsx').WorkSheet} sheet
 * @param {number} headerRow
 * @param {{ c: number, h: string, field: string | null }[]} colMeta
 * @param {Record<string, number>} colMap
 */
function rowsFromSheet(sheet, headerRow, colMeta, colMap) {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const out = [];
  const dataRows = range.e.r - headerRow;
  if (dataRows > MAX_IMPORT_ROWS) {
    throw new Error(
      `الملف يحتوي صفوفاً أكثر من الحد المسموح (${MAX_IMPORT_ROWS}). قسّم الملف إلى أجزاء أصغر.`
    );
  }

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    /** @type {Record<string, string>} */
    const o = {};
    for (const [k, idx] of Object.entries(colMap)) {
      const addr = XLSX.utils.encode_cell({ r, c: idx });
      o[k] = cellDisplayValue(sheet[addr]).trim();
    }

    /** @type {BarcodeRawCell[]} */
    const barcodeRawCells = [];
    let scientificCellsDetected = 0;

    const headerByCol = new Map(colMeta.map((m) => [m.c, m]));

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (!cell) continue;

      const meta = headerByCol.get(c);
      const h = meta?.h ?? "";
      const field = meta?.field ?? null;

      const { raw, formatted, fromScientific } = cellTextsForBarcode(cell);
      const scanText = `${raw} ${formatted}`.trim();
      if (!scanText) continue;

      const excluded = isExcludedFromBarcodeScan(h, field);
      const barcodeCol = isBarcodeScanColumn(h, field);
      const labelCell = ARABIC_LABEL_CELL_RE.test(scanText);

      if (excluded && !labelCell) continue;
      if (!barcodeCol && !labelCell) continue;

      if (fromScientific) scientificCellsDetected++;

      barcodeRawCells.push({
        col: c,
        header: h || `col${c}`,
        raw,
        formatted,
        fromScientific,
      });
    }

    o._barcodeRawCells = barcodeRawCells;
    o._scientificCellsDetected = String(scientificCellsDetected);
    out.push(o);
  }
  return out;
}

/**
 * @param {Buffer} buffer
 */
export function xlsxBufferToHeaderRows(buffer) {
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    cellFormula: false,
    cellHTML: false,
    bookVBA: false,
    cellNF: true,
  });
  const name = wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  if (!sheet) return [];

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  if (!Array.isArray(matrix) || matrix.length === 0) return [];

  const headerRowIndex = findArabicRetailHeaderRow(matrix);
  if (headerRowIndex >= 0) {
    console.info(
      `[import] format=retail headers=${JSON.stringify(matrix[headerRowIndex])}`
    );
    return parseArabicRetailMatrix(matrix, headerRowIndex, sheet);
  }

  console.info(`[import] format=generic headers=${JSON.stringify(matrix[0])}`);

  const det = detectHeaderAndColumns(matrix);
  if (!det) {
    throw new Error(
      "تعذّر العثور على أعمدة الباركود واسم المنتج. أضف عناوين مثل: barcode, name, price أو ما يعادلها بالعربية."
    );
  }
  return rowsFromSheet(sheet, det.headerRow, det.colMeta, det.colMap);
}

/**
 * @param {Record<string, unknown>} rec
 * @param {string[]} headers
 */
function enrichCsvRecord(rec, headers) {
  const clean = {};
  for (const [k, v] of Object.entries(rec)) {
    if (isForbiddenKey(k)) continue;
    clean[k] = v;
  }

  /** @type {BarcodeRawCell[]} */
  const barcodeRawCells = [];
  let scientificCellsDetected = 0;

  for (const h of headers) {
    if (isForbiddenKey(h)) continue;
    const field = classifyHeader(h);
    const val = rec[h];
    if (val === undefined || val === null || String(val).trim() === "") continue;

    const raw = typeof val === "number" ? String(Math.trunc(val)) : String(val);
    const formatted = raw;
    const fromScientific = /[eE]\+?\d+/.test(formatted);
    const scanText = raw;
    const excluded = isExcludedFromBarcodeScan(h, field);
    const barcodeCol = isBarcodeScanColumn(h, field);
    const labelCell = ARABIC_LABEL_CELL_RE.test(scanText);

    if (excluded && !labelCell) continue;
    if (!barcodeCol && !labelCell) continue;

    if (fromScientific) scientificCellsDetected++;

    barcodeRawCells.push({
      col: headers.indexOf(h),
      header: h,
      raw,
      formatted,
      fromScientific,
    });
  }

  clean._barcodeRawCells = barcodeRawCells;
  clean._scientificCellsDetected = String(scientificCellsDetected);
  return clean;
}

/**
 * @param {Buffer} buffer
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
  const headers = records.length ? Object.keys(records[0]) : [];
  return records.map((rec) => enrichCsvRecord(rec, headers));
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
 * Merge barcodes from raw cell metadata.
 * @param {Record<string, unknown>} row
 */
export function collectBarcodesFromRow(row) {
  /** @type {BarcodeRawCell[]} */
  const rawCells = Array.isArray(row._barcodeRawCells) ? row._barcodeRawCells : [];

  /** @type {Map<string, string | null>} */
  const byCode = new Map();
  let scientificCellsDetected = Number(row._scientificCellsDetected) || 0;

  for (const cell of rawCells) {
    const texts = new Set([cell.raw, cell.formatted].filter(Boolean));
    for (const t of texts) {
      for (const entry of extractBarcodesFromText(t)) {
        if (!byCode.has(entry.barcode)) byCode.set(entry.barcode, entry.label);
      }
      for (const code of extractBarcodesFromValue(t)) {
        if (!byCode.has(code)) byCode.set(code, null);
      }
    }
  }

  if (byCode.size === 0 && row._allCellsText) {
    for (const entry of extractBarcodesFromText(String(row._allCellsText))) {
      if (!byCode.has(entry.barcode)) byCode.set(entry.barcode, entry.label);
    }
  }

  const barcodes = [...byCode.entries()].map(([barcode, label]) => ({ barcode, label }));
  const shortCodes = barcodes.filter((b) => b.barcode.length >= 4 && b.barcode.length <= 7).map((b) => b.barcode);

  return {
    barcodes,
    shortCodes,
    scientificCellsDetected,
    rawCells,
    extracted: barcodes.map((b) => b.barcode),
  };
}

function canonicalizeRow(row) {
  /** @type {Record<string, string>} */
  const canon = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    const field = classifyHeader(k);
    if (field && canon[field] === undefined) {
      canon[field] = v === undefined || v === null ? "" : String(v).trim();
    }
  }
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(row)) {
    if (isForbiddenKey(k) || k.startsWith("_")) continue;
    lower[String(k).trim().toLowerCase()] = v;
  }
  const pick = (key) =>
    canon[key] !== undefined && canon[key] !== ""
      ? canon[key]
      : lower[key] !== undefined && lower[key] !== null
        ? String(lower[key]).trim()
        : "";

  const collected = collectBarcodesFromRow(row);
  const primary = pickPrimaryBarcode(collected.barcodes);

  return {
    barcode: primary || "",
    barcodes: collected.barcodes,
    shortCodes: collected.shortCodes,
    scientificCellsDetected: collected.scientificCellsDetected,
    _barcodeRawCells: collected.rawCells,
    _barcodesExtracted: collected.extracted,
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
 */
export function normalizeProductRow(row) {
  if (row._importFormat === "arabic_retail") {
    const name = String(row.name ?? "").trim();
    const price = Number(row.price) || 0;
    /** @type {{ barcode: string, label: string | null, is_primary?: boolean }[]} */
    const barcodes = Array.isArray(row.barcodes) ? row.barcodes : [];
    const primary =
      String(row.barcode ?? "").trim() ||
      barcodes.find((b) => b.is_primary)?.barcode ||
      barcodes[0]?.barcode ||
      "";

    if (!primary || !name) {
      return {
        ok: false,
        reason: !primary ? "لم يُعثر على باركود في الصف" : "الاسم مفقود",
        noBarcode: !primary,
        _barcodesExtracted: row._barcodesExtracted,
        _rawMainBarcode: row._rawMainBarcode,
        _rawUnitBarcodes: row._rawUnitBarcodes,
      };
    }

    const shortCodes = barcodes
      .filter((b) => b.barcode.length >= 4 && b.barcode.length <= 7)
      .map((b) => b.barcode);

    return {
      ok: true,
      row: {
        barcode: primary,
        barcodes: barcodes.map((b) => ({
          barcode: b.barcode,
          label: b.label ?? null,
          is_primary: b.is_primary === true || b.barcode === primary,
        })),
        shortCodes,
        scientificCellsDetected: 0,
        _importFormat: "arabic_retail",
        _rawMainBarcode: row._rawMainBarcode,
        _rawUnitBarcodes: row._rawUnitBarcodes,
        _rawName: row._rawName,
        _barcodesExtracted: row._barcodesExtracted ?? barcodes.map((b) => b.barcode),
        name,
        name_en: null,
        price,
        cost: 0,
        category: null,
        stock: 0,
        tax_rate: null,
        unit: null,
        expiry_date: null,
        min_price: null,
        max_price: null,
      },
    };
  }

  const c = canonicalizeRow(row);
  const barcodes = c.barcodes?.length ? c.barcodes : [];
  const primary = pickPrimaryBarcode(barcodes) || (c.barcode ? normalizeBarcodeInput(c.barcode) : "");
  const name = c.name;
  const price = c.price !== "" ? parseMoneyCell(c.price) : NaN;
  const stockRaw = c.stock !== "" ? parseMoneyCell(c.stock) : NaN;
  const stock = Number.isNaN(stockRaw) ? 0 : Math.max(0, Math.floor(stockRaw));
  const cost = c.cost !== "" ? parseMoneyCell(c.cost) : 0;
  const category =
    c.category != null && String(c.category).trim() !== ""
      ? String(c.category).trim()
      : null;

  if (!primary || !name || Number.isNaN(price)) {
    const reason = !primary
      ? "لم يُعثر على باركود في الصف"
      : !name
        ? "الاسم مفقود"
        : "السعر الصالح مفقود";
    return {
      ok: false,
      reason,
      noBarcode: !primary,
      _barcodeRawCells: c._barcodeRawCells,
      _barcodesExtracted: c._barcodesExtracted,
      scientificCellsDetected: c.scientificCellsDetected,
    };
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
      barcode: primary,
      barcodes,
      shortCodes: c.shortCodes || [],
      scientificCellsDetected: c.scientificCellsDetected || 0,
      _barcodeRawCells: c._barcodeRawCells,
      _barcodesExtracted: c._barcodesExtracted,
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

export {
  extractBarcodesFromText,
  extractBarcodesFromValue,
  pickPrimaryBarcode,
};
