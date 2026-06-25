import XLSX from "xlsx";
import { round2 } from "./tax.js";
import { parseBalanceAmount } from "./balanceSheetImport.js";
import {
  readXlsxMatrix,
  findHeaderRowIndex,
  mapColumns,
  matrixToFieldRecords,
  normalizeHeaderCell,
  assertMatrixRowCap,
} from "./xlsxHelpers.js";
import { readPdfStatementMatrix } from "./statementPdfImport.js";

export const HESABATI_HISTORY_SOURCE = "hesabati_history_import";

const STATEMENT_FIELD_PATTERNS = {
  ref: [/^الرقم$|^رقم$|^ref$|^reference$/i],
  description: [/^البيان$|^بيان$|^description$/i],
  date: [/^التاريخ$|^تاريخ$|^date$/i],
  debit: [/^مدين$|^debit$/i],
  credit: [/^دائن$|^credit$/i],
  balance: [/^الرصيد$|^رصيد$|^balance$/i],
  notes: [/^ملاحظات$|^ملاحظة$|^notes$/i],
};

/**
 * @param {unknown} val
 */
export function parseStatementDate(val) {
  if (val === undefined || val === null || val === "") return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + val * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mo = String(m[2]).padStart(2, "0");
    const d = String(m[1]).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function readStatementFileMatrix(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".pdf")) {
    return readPdfStatementMatrix(buffer);
  }
  if (name.endsWith(".csv")) {
    const wb = XLSX.read(buffer, { type: "buffer", raw: true });
    const sheetName = wb.SheetNames[0];
    const sheet = sheetName ? wb.Sheets[sheetName] : null;
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
  }
  return readXlsxMatrix(buffer).matrix;
}

/**
 * @param {unknown[][]} matrix
 */
export function parseHesabatiStatementMatrix(matrix) {
  const headerIdx = findHeaderRowIndex(matrix, (headers) => {
    const hasDesc = headers.some((h) => STATEMENT_FIELD_PATTERNS.description.some((re) => re.test(h)));
    const hasBal = headers.some((h) => STATEMENT_FIELD_PATTERNS.balance.some((re) => re.test(h)));
    return hasDesc && hasBal;
  });
  if (headerIdx < 0) {
    throw new Error("تعذّر العثور على أعمدة كشف الحساب (البيان، الرصيد) في الملف.");
  }

  const headers = (matrix[headerIdx] || []).map(normalizeHeaderCell);
  const colMap = mapColumns(headers, STATEMENT_FIELD_PATTERNS);
  if (colMap.description === undefined) {
    throw new Error("تعذّر العثور على عمود البيان في الملف.");
  }

  assertMatrixRowCap(matrix, headerIdx);
  const raw = matrixToFieldRecords(matrix, headerIdx, colMap);

  /** @type {object[]} */
  const rows = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();
  let invalid = 0;
  let duplicates = 0;

  for (const row of raw) {
    const description = String(row.description ?? "").trim();
    const debit = parseBalanceAmount(row.debit);
    const credit = parseBalanceAmount(row.credit);
    const runningBalance = parseBalanceAmount(row.balance);
    const entryDate = parseStatementDate(row.date);
    const notes = row.notes != null && String(row.notes).trim() !== "" ? String(row.notes).trim() : null;
    const legacyRef =
      row.ref != null && String(row.ref).trim() !== "" ? String(row.ref).trim() : null;

    if (!description && Math.abs(debit) < 0.009 && Math.abs(credit) < 0.009 && Math.abs(runningBalance) < 0.009) {
      continue;
    }
    if (!description) {
      invalid++;
      continue;
    }

    const dupKey = `${entryDate || ""}|${description}|${debit}|${credit}|${runningBalance}|${legacyRef || ""}`;
    if (seenKeys.has(dupKey)) {
      duplicates++;
      continue;
    }
    seenKeys.add(dupKey);

    rows.push({
      rowNum: Number(row._rowNum) || 0,
      row_order: rows.length + 1,
      legacy_reference_number: legacyRef,
      entry_date: entryDate,
      description,
      debit: round2(debit),
      credit: round2(credit),
      running_balance: round2(runningBalance),
      notes,
    });
  }

  return { rows, invalid, duplicates };
}

/**
 * @param {object[]} rows
 */
export function verifyStatementRunningBalances(rows) {
  /** @type {{ row: number, expected: number, fileBalance: number, description: string }[]} */
  const warnings = [];
  let prev = 0;
  for (const row of rows) {
    const calculated = round2(prev + row.debit - row.credit);
    if (Math.abs(calculated - row.running_balance) > 0.02) {
      warnings.push({
        row: row.rowNum,
        expected: calculated,
        fileBalance: row.running_balance,
        description: row.description,
      });
    }
    prev = row.running_balance;
  }
  return warnings;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function parseHesabatiStatementFile(buffer, filename) {
  const matrix = await readStatementFileMatrix(buffer, filename);
  if (!matrix.length) {
    throw new Error("الملف فارغ أو لا يحتوي على بيانات");
  }
  return parseHesabatiStatementMatrix(matrix);
}
