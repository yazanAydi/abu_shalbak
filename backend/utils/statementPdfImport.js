import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseBalanceAmount } from "./balanceSheetImport.js";

const KNOWN_HEADERS = ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"];

/**
 * @param {Buffer} buffer
 */
export async function extractPdfPlainText(buffer) {
  const data = await pdfParse(buffer);
  return String(data?.text || "");
}

/**
 * @param {string} text
 */
export function normalizePdfText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[₪]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} line
 */
function splitPdfColumns(line) {
  if (line.includes("\t")) {
    return line.split("\t").map((c) => c.trim()).filter((c) => c !== "");
  }
  const byGap = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
  if (byGap.length >= 4) return byGap;
  return line.split(/\s+/).map((c) => c.trim()).filter((c) => c !== "");
}

/**
 * @param {string} line
 */
function isPdfNoiseLine(line) {
  const s = line.trim();
  if (!s) return true;
  if (/^(صفحة|page)\s*\d/i.test(s)) return true;
  if (/^(المجموع|إجمال|الإجمالي|total)/i.test(s)) return true;
  if (/^(اسم|هاتف|من تاريخ|إلى تاريخ|تاريخ الطباعة)/i.test(s)) return true;
  if (/^كشف حساب/i.test(s) && !/البيان/.test(s)) return true;
  return false;
}

/**
 * @param {string} line
 */
function isPdfHeaderLine(line) {
  return /البيان/.test(line) && (/الرصيد|مدين|دائن/.test(line));
}

/**
 * @param {string[]} cells
 */
function mapCellsToRow(cells) {
  if (cells.length >= 7) {
    return {
      ref: cells[0] || null,
      description: cells[1] || "",
      date: cells[2] || null,
      debit: cells[3] || "",
      credit: cells[4] || "",
      balance: cells[5] || "",
      notes: cells[6] || null,
    };
  }

  if (cells.length === 6) {
    return {
      ref: cells[0] || null,
      description: cells[1] || "",
      date: cells[2] || null,
      debit: cells[3] || "",
      credit: cells[4] || "",
      balance: cells[5] || "",
      notes: null,
    };
  }

  if (cells.length === 5) {
    return {
      ref: cells[0] || null,
      description: cells[1] || "",
      date: cells[2] || null,
      debit: cells[3] || "",
      credit: "",
      balance: cells[4] || "",
      notes: null,
    };
  }

  return parsePdfKashfLineByAmounts(cells.join(" "));
}

/**
 * @param {string} line
 */
function parsePdfKashfLineByAmounts(line) {
  let rest = line.replace(/\s+/g, " ").trim();
  if (!rest || isPdfNoiseLine(rest)) return null;

  /** @type {string[]} */
  const amounts = [];
  const amtRe = /(?:^|\s)(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\-?\s*$/;

  for (let i = 0; i < 3; i++) {
    const m = rest.match(amtRe);
    if (!m) break;
    amounts.unshift(m[1]);
    rest = rest.slice(0, m.index).trim();
  }

  if (!amounts.length) return null;

  let debit = 0;
  let credit = 0;
  let balance = 0;

  if (amounts.length === 1) {
    balance = parseBalanceAmount(amounts[0]);
  } else if (amounts.length === 2) {
    const movement = parseBalanceAmount(amounts[0]);
    balance = parseBalanceAmount(amounts[1]);
    if (movement >= 0) debit = movement;
    else credit = Math.abs(movement);
  } else {
    debit = parseBalanceAmount(amounts[0]);
    credit = parseBalanceAmount(amounts[1]);
    balance = parseBalanceAmount(amounts[2]);
  }

  const dateM = rest.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/);
  const entryDate = dateM ? dateM[1] : null;
  if (dateM) rest = rest.replace(dateM[0], " ").trim();

  let legacyRef = null;
  const refM = rest.match(/^(\d+)\s+/);
  if (refM) {
    legacyRef = refM[1];
    rest = rest.slice(refM[0].length).trim();
  }

  const description = rest.trim();
  if (!description) return null;

  return {
    ref: legacyRef,
    description,
    date: entryDate,
    debit,
    credit,
    balance,
    notes: null,
  };
}

/**
 * @param {string} line
 */
function parsePdfLineToMatrixRow(line) {
  if (isPdfNoiseLine(line) || isPdfHeaderLine(line)) return null;

  const cells = splitPdfColumns(line);
  if (cells.length >= 4) {
    const mapped = mapCellsToRow(cells);
    if (mapped?.description) {
      return [
        mapped.ref || "",
        mapped.description,
        mapped.date || "",
        mapped.debit ?? "",
        mapped.credit ?? "",
        mapped.balance ?? "",
        mapped.notes || "",
      ];
    }
  }

  const parsed = parsePdfKashfLineByAmounts(line);
  if (!parsed?.description) return null;
  return [
    parsed.ref || "",
    parsed.description,
    parsed.date || "",
    parsed.debit || "",
    parsed.credit || "",
    parsed.balance ?? "",
    parsed.notes || "",
  ];
}

/**
 * Convert extracted PDF plain text into a matrix compatible with parseHesabatiStatementMatrix.
 * @param {string} text
 */
export function pdfTextToStatementMatrix(text) {
  const normalized = normalizePdfText(text);
  if (!normalized) {
    throw new Error("تعذّر استخراج نص من ملف PDF");
  }

  const lines = normalized.split("\n").map((l) => l.trim()).filter(Boolean);
  let headerIdx = lines.findIndex(isPdfHeaderLine);

  /** @type {string[][]} */
  const matrix = [];
  if (headerIdx >= 0) {
    const headerCells = splitPdfColumns(lines[headerIdx]);
    if (headerCells.length >= 4) {
      matrix.push(headerCells);
    } else {
      matrix.push(KNOWN_HEADERS);
    }
  } else {
    headerIdx = -1;
    matrix.push(KNOWN_HEADERS);
  }

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = parsePdfLineToMatrixRow(lines[i]);
    if (row) matrix.push(row);
  }

  if (matrix.length <= 1) {
    throw new Error("تعذّر العثور على صفوف كشف حساب في ملف PDF — جرّب تصدير Excel أو CSV من حساباتي");
  }

  return matrix;
}

/**
 * @param {Buffer} buffer
 */
export async function readPdfStatementMatrix(buffer) {
  const text = await extractPdfPlainText(buffer);
  return pdfTextToStatementMatrix(text);
}
