import { round2 } from "./tax.js";
import {
  formatExcelSignedAmount,
} from "./hesabatiStatementFormat.js";
import { HESABATI_HISTORY_SOURCE } from "./statementHistoryImport.js";
import {
  fetchSupplierLedgerEvents,
  dayBefore,
} from "./supplierLedger.js";
import { fetchCustomerLedgerEvents } from "./customerLedger.js";

const EV_LABELS = {
  supplier: {
    opening: "الرصيد المدور",
    purchase: "مشتريات فاتورة",
    purchase_return: "مرتجع مشتريات",
    payment: "دفع سند",
  },
  customer: {
    opening: "الرصيد المدور",
    sale: "مبيعات فاتورة",
    refund: "مرتجع",
    payment: "قبض سند",
  },
};

const HESABATI_HISTORY_NOTE = "مستورد من حساباتي — كشف قديم";

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 * @param {string|null} [from]
 * @param {string|null} [to]
 */
export async function fetchImportedStatementEntries(db, partyType, partyId, from, to) {
  let sql = `SELECT * FROM account_statement_entries
    WHERE party_type = ? AND party_id = ? AND source_type = ?`;
  const params = [partyType, partyId, HESABATI_HISTORY_SOURCE];
  if (from) {
    sql += ` AND (entry_date IS NULL OR entry_date >= ?)`;
    params.push(from);
  }
  if (to) {
    sql += ` AND (entry_date IS NULL OR entry_date <= ?)`;
    params.push(to);
  }
  sql += ` ORDER BY entry_date ASC, row_order ASC, id ASC`;
  return db.all(sql, params);
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 */
export async function fetchAllImportedStatementEntries(db, partyType, partyId) {
  return db.all(
    `SELECT * FROM account_statement_entries
     WHERE party_type = ? AND party_id = ? AND source_type = ?
     ORDER BY entry_date ASC, row_order ASC, id ASC`,
    [partyType, partyId, HESABATI_HISTORY_SOURCE]
  );
}

/**
 * @param {string|null} entryDate
 * @param {string|null} from
 * @param {string|null} to
 */
function inDateRange(entryDate, from, to) {
  if (!from && !to) return true;
  if (!entryDate) return true;
  if (from && entryDate < from) return false;
  if (to && entryDate > to) return false;
  return true;
}

/**
 * @param {string|null} entryDate
 * @param {string} from
 */
function isBeforeFrom(entryDate, from) {
  if (!entryDate) return true;
  return entryDate < from;
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 * @param {string} from
 */
async function fetchPriorLiveEvents(db, partyType, partyId, from) {
  const to = dayBefore(from);
  if (partyType === "supplier") {
    return fetchSupplierLedgerEvents(db, partyId, null, to);
  }
  return fetchCustomerLedgerEvents(db, partyId, null, to);
}

/**
 * @param {object[]} allHistory
 * @param {object[]} priorLiveEvents
 * @param {string} from
 */
function computeCarriedForwardBalance(allHistory, priorLiveEvents, from) {
  const historyBefore = allHistory.filter((h) => isBeforeFrom(h.entry_date, from));
  let running = historyBefore.length
    ? round2(Number(historyBefore[historyBefore.length - 1].running_balance) || 0)
    : 0;
  for (const ev of priorLiveEvents) {
    const debit = round2(Number(ev.debit) || 0);
    const credit = round2(Number(ev.credit) || 0);
    running = round2(running + debit - credit);
  }
  return running;
}

/**
 * @param {object} entry
 * @param {number} lineNo
 */
function mapHistoryRow(entry, lineNo) {
  const balance = round2(Number(entry.running_balance) || 0);
  return {
    line_no: entry.legacy_reference_number || String(lineNo),
    description: entry.description,
    date: entry.entry_date ? String(entry.entry_date).slice(0, 10) : null,
    debit: round2(Number(entry.debit) || 0),
    credit: round2(Number(entry.credit) || 0),
    balance,
    balance_formatted: formatExcelSignedAmount(balance),
    balance_is_negative: balance < 0,
    notes: entry.notes || HESABATI_HISTORY_NOTE,
    ref_id: entry.id,
    ev_type: "history_import",
  };
}

/**
 * @param {"supplier"|"customer"} partyType
 * @param {object} ev
 * @param {number} running
 */
function mapLiveRow(partyType, ev, running) {
  const debit = round2(Number(ev.debit) || 0);
  const credit = round2(Number(ev.credit) || 0);
  const balance = round2(running);
  return {
    line_no: ev.ref_id != null ? String(ev.ref_id) : "",
    description: EV_LABELS[partyType][ev.ev_type] || ev.ev_type,
    date: ev.ev_date ? String(ev.ev_date).slice(0, 10) : null,
    debit,
    credit,
    balance,
    balance_formatted: formatExcelSignedAmount(balance),
    balance_is_negative: balance < 0,
    notes: ev.notes || "",
    ref_id: ev.ref_id ?? null,
    ev_type: ev.ev_type,
  };
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {object} party
 * @param {object} ledger
 * @param {object[]} allHistory
 * @param {{ from?: string|null, to?: string|null }} range
 * @param {{ storeName?: string }} [options]
 */
export async function mergePartyAccountStatement(
  db,
  partyType,
  party,
  ledger,
  allHistory,
  range = {},
  options = {}
) {
  const from = range.from || null;
  const to = range.to || null;
  const code = partyType === "supplier" ? party.supplier_code : party.customer_code;
  const phone = partyType === "supplier" ? party.contact_phone : party.phone;

  /** @type {object[]} */
  const rows = [];
  let lineNo = 1;

  if (from) {
    const priorLive = await fetchPriorLiveEvents(db, partyType, party.id, from);
    const carried = computeCarriedForwardBalance(allHistory, priorLive, from);
    const openingDebit = carried > 0 ? carried : 0;
    const openingCredit = carried < 0 ? round2(-carried) : 0;
    rows.push({
      line_no: code || "0",
      description: EV_LABELS[partyType].opening,
      date: from,
      debit: openingDebit,
      credit: openingCredit,
      balance: carried,
      balance_formatted: formatExcelSignedAmount(carried),
      balance_is_negative: carried < 0,
      notes: "—",
      ref_id: null,
      ev_type: "opening",
    });
    lineNo++;
  }

  const historyInRange = allHistory.filter((h) => inDateRange(h.entry_date, from, to));
  for (const entry of historyInRange) {
    rows.push(mapHistoryRow(entry, lineNo++));
  }

  const lastHistoryBalance = allHistory.length
    ? round2(Number(allHistory[allHistory.length - 1].running_balance) || 0)
    : 0;

  let liveRunning = lastHistoryBalance;
  const liveEvents = ledger.events || [];
  for (const ev of liveEvents) {
    const debit = round2(Number(ev.debit) || 0);
    const credit = round2(Number(ev.credit) || 0);
    liveRunning = round2(liveRunning + debit - credit);
    rows.push(mapLiveRow(partyType, ev, liveRunning));
  }

  const movementRows = rows.filter((r) => r.ev_type !== "opening");
  const totalDebit = round2(movementRows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(movementRows.reduce((s, r) => s + r.credit, 0));
  const finalBalance =
    rows.length > 0 ? round2(Number(rows[rows.length - 1].balance) || 0) : 0;

  const openingBalance = from
    ? computeCarriedForwardBalance(
        allHistory,
        await fetchPriorLiveEvents(db, partyType, party.id, from),
        from
      )
    : allHistory.length
      ? round2(Number(allHistory[0].running_balance) || 0)
      : round2(Number(ledger.excel_opening_balance ?? ledger.opening_balance) || 0);

  return {
    party_type: partyType,
    store_name: options.storeName || null,
    party: {
      id: party.id,
      name: party.name,
      code: code || null,
      phone: phone || null,
      balance: round2(Number(party.balance) || 0),
    },
    title: partyType === "supplier" ? "كشف حساب مورد" : "كشف حساب عميل",
    date_from: from,
    date_to: to,
    opening_balance: openingBalance,
    opening_balance_formatted: formatExcelSignedAmount(openingBalance),
    closing_balance: finalBalance,
    closing_balance_formatted: formatExcelSignedAmount(finalBalance),
    rows,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      final_balance: finalBalance,
      final_balance_formatted: formatExcelSignedAmount(finalBalance),
    },
    has_imported_history: true,
  };
}
