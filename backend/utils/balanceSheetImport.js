import { round2 } from "./tax.js";
import {
  assertMatrixRowCap,
  findHeaderRowIndex,
  mapColumns,
  matrixToFieldRecords,
  normalizeHeaderCell,
} from "./xlsxHelpers.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const BALANCE_FIELD_PATTERNS = {
  code: [/^رقم$|^الرقم$|^كود$|^كود\s*الزبون|^كود\s*العميل|^كود\s*المورد|^customer_code$/i],
  name: [/^الاسم$|^اسم\s*الزبون|^اسم\s*العميل|^اسم\s*المورد|^البيان$|^name$/i],
  phone: [/^هاتف$|^الهاتف$|^تل$|^تل\.|^جوال$|^موب/i, /^phone$/i],
  balance: [/^الرصيد$|^رصيد$|^الرصيد\s*الحالي$|^balance$/i],
};

/**
 * @param {unknown[][]} matrix
 * @param {number} [headerRowIndex]
 */
export function parseBalanceSheetMatrix(matrix, headerRowIndex = -1) {
  const idx =
    headerRowIndex >= 0
      ? headerRowIndex
      : findHeaderRowIndex(matrix, (headers) => {
          const hasBalance = headers.some((h) => BALANCE_FIELD_PATTERNS.balance.some((re) => re.test(h)));
          const hasName = headers.some((h) => BALANCE_FIELD_PATTERNS.name.some((re) => re.test(h)));
          return hasBalance && hasName;
        });

  if (idx < 0) {
    throw new Error("تعذّر العثور على أعمدة الاسم والرصيد في ملف الأرصدة.");
  }

  const headers = (matrix[idx] || []).map(normalizeHeaderCell);
  const colMap = mapColumns(headers, BALANCE_FIELD_PATTERNS);
  if (colMap.name === undefined || colMap.balance === undefined) {
    throw new Error("تعذّر العثور على أعمدة الاسم والرصيد في ملف الأرصدة.");
  }

  assertMatrixRowCap(matrix, idx);
  const raw = matrixToFieldRecords(matrix, idx, colMap);

  return raw.map((row) => ({
    rowNum: Number(row._rowNum) || 0,
    code: row.code != null && String(row.code).trim() !== "" ? String(row.code).trim() : null,
    name: String(row.name ?? "").trim(),
    phone: row.phone != null && String(row.phone).trim() !== "" ? String(row.phone).trim() : null,
    balance: parseBalanceAmount(row.balance),
  }));
}

/**
 * @param {unknown} val
 */
export function parseBalanceAmount(val) {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number" && Number.isFinite(val)) return round2(val);
  const s = String(val).trim().replace(/,/g, "").replace(/₪/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  return round2(Number(m[0]));
}

/**
 * Hesabati supplier balances use the opposite sign from our ledger:
 * Excel minus = we owe the supplier (payable) → system positive.
 * Excel plus = they owe us (advance) → system negative.
 * @param {number} parsedBalance — already parsed via parseBalanceAmount
 */
export function hesabatiToSystemSupplierBalance(parsedBalance) {
  return round2(-parsedBalance);
}

/**
 * Hesabati customer/operator balances match our ledger:
 * Excel plus = they owe us, Excel minus = credit / we owe them.
 * @param {number} parsedBalance
 */
export function hesabatiToSystemCustomerBalance(parsedBalance) {
  return round2(parsedBalance);
}

/**
 * @param {string} name
 */
export function normalizeAccountName(name) {
  return normalizeArabicNameForMatch(name);
}

/**
 * Normalize Arabic text for matching only — display names stay as imported.
 * @param {string} name
 */
export function normalizeArabicNameForMatch(name) {
  return String(name || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ى]/g, "ي")
    .replace(/[ة]/g, "ه")
    .toLowerCase();
}

/**
 * Map system opening balance to ledger debit/credit columns.
 * @param {number} systemBalance
 */
export function openingBalanceToDebitCredit(systemBalance) {
  const n = round2(Number(systemBalance) || 0);
  return {
    debit: n < 0 ? round2(-n) : 0,
    credit: n > 0 ? n : 0,
  };
}

/**
 * Strip prototype-pollution keys from parsed objects.
 * @param {Record<string, unknown>} obj
 */
export function sanitizeImportRecord(obj) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(String(k).trim().toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {object} db
 * @param {number} customerId
 */
export async function customerHasLedgerActivity(db, customerId) {
  const sales = await db.get(
    `SELECT COUNT(*) AS n FROM transactions WHERE customer_id = ? AND payment_method = 'on_account'`,
    [customerId]
  );
  if (Number(sales?.n) > 0) return true;
  const refunds = await db.get(
    `SELECT COUNT(*) AS n FROM refunds WHERE customer_id = ? AND status = 'approved'`,
    [customerId]
  );
  if (Number(refunds?.n) > 0) return true;
  const pays = await db.get(
    `SELECT COUNT(*) AS n FROM voucher_lines WHERE customer_id = ?`,
    [customerId]
  );
  return Number(pays?.n) > 0;
}

/**
 * @param {object} db
 * @param {number} supplierId
 */
export async function supplierHasLedgerActivity(db, supplierId) {
  const inv = await db.get(
    `SELECT COUNT(*) AS n FROM purchase_invoices WHERE supplier_id = ? AND status = 'posted'`,
    [supplierId]
  );
  if (Number(inv?.n) > 0) return true;
  const ret = await db.get(
    `SELECT COUNT(*) AS n FROM purchase_returns WHERE supplier_id = ? AND status = 'posted'`,
    [supplierId]
  );
  if (Number(ret?.n) > 0) return true;
  const vp = await db.get(
    `SELECT COUNT(*) AS n FROM voucher_lines vl
     JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.supplier_id = ? AND v.status = 'posted'`,
    [supplierId]
  );
  if (Number(vp?.n) > 0) return true;
  const lp = await db.get(
    `SELECT COUNT(*) AS n FROM supplier_payments WHERE supplier_id = ?`,
    [supplierId]
  );
  return Number(lp?.n) > 0;
}
