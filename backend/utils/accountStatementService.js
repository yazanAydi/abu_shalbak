import { round2 } from "./tax.js";
import { buildSupplierLedger } from "./supplierLedger.js";
import { buildCustomerLedger } from "./customerLedger.js";
import { formatHesabatiStatement, hesabatiBalanceDisplay } from "./hesabatiStatementFormat.js";
import {
  fetchAllImportedStatementEntries,
  mergePartyAccountStatement,
} from "./accountStatementMerge.js";
import {
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "./storeBranding.js";

/**
 * @param {string} [value]
 */
export function parseStatementDate(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Default range: current calendar year through today.
 */
export function defaultStatementDateRange() {
  const now = new Date();
  const from = `${now.getFullYear()}-01-01`;
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * @param {object} row
 */
function mapRowToApi(row) {
  return {
    line_no: row.line_no,
    referenceNumber: row.line_no,
    description: row.description,
    date: row.date,
    debit: row.debit,
    credit: row.credit,
    runningBalance: row.balance,
    runningBalanceFormatted: row.balance_formatted,
    notes: row.notes || "",
    sourceType: row.ev_type,
    sourceId: row.ref_id,
  };
}

/**
 * @param {object} db
 * @param {{
 *   partyType: "supplier"|"customer",
 *   partyId: number,
 *   from?: string|null,
 *   to?: string|null,
 *   page?: number,
 *   pageSize?: number,
 *   useDefaultRange?: boolean,
 * }} opts
 */
export async function getAccountStatement(db, opts) {
  const normalizedType =
    opts.partyType === "supplier" || opts.partyType === "customer" ? opts.partyType : null;
  if (!normalizedType) {
    const err = new Error("partyType يجب أن يكون supplier أو customer");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const partyId = Number(opts.partyId);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error("partyId غير صالح");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  let from = parseStatementDate(opts.from);
  let to = parseStatementDate(opts.to);
  if (opts.useDefaultRange !== false && !from && !to) {
    const def = defaultStatementDateRange();
    from = def.from;
    to = def.to;
  }
  if (from && to && from > to) {
    const err = new Error("تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  let party;
  let ledger;
  if (normalizedType === "supplier") {
    party = await db.get("SELECT * FROM suppliers WHERE id = ?", [partyId]);
    if (!party) {
      const err = new Error("المورد غير موجود");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
    }
    ledger = await buildSupplierLedger(db, party, from, to);
  } else {
    party = await db.get("SELECT * FROM customers WHERE id = ?", [partyId]);
    if (!party) {
      const err = new Error("العميل غير موجود");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
    }
    ledger = await buildCustomerLedger(db, party, from, to);
  }

  const importedHistory = await fetchAllImportedStatementEntries(db, normalizedType, partyId);
  const formatted =
    importedHistory.length > 0
      ? await mergePartyAccountStatement(
          db,
          normalizedType,
          party,
          ledger,
          importedHistory,
          { from, to },
          { storeName: STORE_NAME_AR }
        )
      : formatHesabatiStatement(normalizedType, party, ledger, { from, to }, {
          storeName: STORE_NAME_AR,
        });

  const movementRows = formatted.rows.filter((r) => r.ev_type !== "opening");
  const totalDebit = round2(movementRows.reduce((s, r) => s + (Number(r.debit) || 0), 0));
  const totalCredit = round2(movementRows.reduce((s, r) => s + (Number(r.credit) || 0), 0));

  const apiRows = formatted.rows.map(mapRowToApi);

  const pageSize =
    opts.pageSize != null ? Math.min(500, Math.max(1, Number(opts.pageSize) || 50)) : null;
  const page = pageSize ? Math.max(1, Number(opts.page) || 1) : 1;
  const totalRows = apiRows.length;
  let pagedRows = apiRows;
  if (pageSize) {
    const start = (page - 1) * pageSize;
    pagedRows = apiRows.slice(start, start + pageSize);
  }

  const closingFormatted =
    formatted.totals?.final_balance_formatted || formatted.closing_balance_formatted;
  const openingFormatted =
    formatted.opening_balance_formatted ||
    hesabatiBalanceDisplay(normalizedType, ledger.opening_balance).formatted;

  const useMergedClosing = importedHistory.length > 0;
  const finalBalance = useMergedClosing
    ? formatted.totals?.final_balance
    : normalizedType === "supplier"
      ? (ledger.excel_closing_balance ?? formatted.totals?.final_balance)
      : ledger.closing_balance;

  return {
    store_name: STORE_NAME_AR,
    store_phone: STORE_PHONE,
    store_license: STORE_LICENSE_LINE,
    party_type: normalizedType,
    report_title: normalizedType === "supplier" ? "كشف حساب مورد" : "كشف حساب عميل",
    party: formatted.party,
    openingBalance:
      useMergedClosing
        ? formatted.opening_balance
        : normalizedType === "supplier"
          ? ledger.excel_opening_balance ?? formatted.opening_balance
          : ledger.opening_balance,
    openingBalanceFormatted: openingFormatted,
    date_from: from,
    date_to: to,
    print_date: new Date().toISOString().slice(0, 10),
    rows: pagedRows,
    all_rows_count: totalRows,
    pagination: pageSize
      ? { page, pageSize, totalRows, totalPages: Math.ceil(totalRows / pageSize) || 1 }
      : null,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      finalBalance,
      finalBalanceFormatted: closingFormatted,
    },
    formatted,
  };
}

/**
 * Full statement for export (all rows, no pagination).
 */
export async function getAccountStatementExport(db, opts) {
  return getAccountStatement(db, { ...opts, page: undefined, pageSize: undefined });
}
