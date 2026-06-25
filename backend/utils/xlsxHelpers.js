import XLSX from "xlsx";
import { MAX_IMPORT_ROWS } from "./productImport.js";

/**
 * @param {Buffer} buffer
 * @returns {{ matrix: unknown[][], sheet: import('xlsx').WorkSheet | null, sheetName: string | null }}
 */
export function readXlsxMatrix(buffer) {
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    cellFormula: false,
    cellHTML: false,
    bookVBA: false,
    cellNF: true,
  });
  const sheetName = wb.SheetNames[0] ?? null;
  const sheet = sheetName ? wb.Sheets[sheetName] : null;
  if (!sheet) return { matrix: [], sheet: null, sheetName: null };

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  if (!Array.isArray(matrix)) return { matrix: [], sheet, sheetName };
  return { matrix, sheet, sheetName };
}

/**
 * @param {unknown} raw
 */
export function normalizeHeaderCell(raw) {
  return String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

/**
 * @param {unknown[][]} matrix
 * @param {(headers: string[]) => boolean} matcher
 * @param {number} [maxScan=15]
 */
export function findHeaderRowIndex(matrix, matcher, maxScan = 15) {
  for (let r = 0; r < Math.min(matrix.length, maxScan); r++) {
    const headers = (matrix[r] || []).map(normalizeHeaderCell);
    if (matcher(headers)) return r;
  }
  return -1;
}

/**
 * @param {unknown[][]} matrix
 * @param {number} headerRowIndex
 * @param {number} [limit=5]
 */
export function previewMatrixRows(matrix, headerRowIndex, limit = 5) {
  const headers = (matrix[headerRowIndex] || []).map(normalizeHeaderCell);
  const rows = [];
  for (let i = headerRowIndex + 1; i < matrix.length && rows.length < limit; i++) {
    const row = matrix[i] || [];
    /** @type {Record<string, unknown>} */
    const obj = {};
    let hasData = false;
    headers.forEach((h, c) => {
      if (!h) return;
      const v = row[c];
      if (v !== null && v !== undefined && String(v).trim() !== "") hasData = true;
      obj[h] = v;
    });
    if (hasData) rows.push(obj);
  }
  return { headers, rows };
}

/**
 * @param {unknown[][]} matrix
 * @param {number} headerRowIndex
 */
export function assertMatrixRowCap(matrix, headerRowIndex) {
  const dataRows = Math.max(0, matrix.length - headerRowIndex - 1);
  if (dataRows > MAX_IMPORT_ROWS) {
    throw new Error(
      `الملف يحتوي صفوفاً أكثر من الحد المسموح (${MAX_IMPORT_ROWS}). قسّم الملف إلى أجزاء أصغر.`
    );
  }
}

/**
 * @param {unknown[][]} matrix
 * @param {number} headerRowIndex
 * @param {Record<string, number>} fieldToCol — logical field → column index
 */
export function matrixToFieldRecords(matrix, headerRowIndex, fieldToCol) {
  assertMatrixRowCap(matrix, headerRowIndex);
  const out = [];
  for (let i = headerRowIndex + 1; i < matrix.length; i++) {
    const row = matrix[i] || [];
    /** @type {Record<string, unknown>} */
    const rec = { _rowNum: i + 1 };
    let hasData = false;
    for (const [field, col] of Object.entries(fieldToCol)) {
      const v = row[col];
      if (v !== null && v !== undefined && String(v).trim() !== "") hasData = true;
      rec[field] = v;
    }
    if (hasData) out.push(rec);
  }
  return out;
}

/**
 * @param {string[]} headers
 * @param {RegExp[]} patterns
 */
export function findColumnByPatterns(headers, patterns) {
  for (let c = 0; c < headers.length; c++) {
    const h = normalizeHeaderCell(headers[c]);
    if (!h) continue;
    for (const re of patterns) {
      if (re.test(h)) return c;
    }
  }
  return -1;
}

/**
 * @param {string[]} headers
 * @param {Record<string, RegExp[]>} fieldPatterns
 */
export function mapColumns(headers, fieldPatterns) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const [field, patterns] of Object.entries(fieldPatterns)) {
    const col = findColumnByPatterns(headers, patterns);
    if (col >= 0) map[field] = col;
  }
  return map;
}
