import { round2 } from "./tax.js";

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
    sale_invoice: "فتورة مبيعات",
    refund: "مرتجع",
    payment: "قبض سند",
  },
};

const HESABATI_IMPORT_NOTE = "مستورد من حساباتي";

/**
 * Format balance for supplier kashf (Excel-native sign, prefix minus).
 * @param {number} n
 */
export function formatExcelSignedAmount(n) {
  const v = round2(Number(n) || 0);
  if (Math.abs(v) < 0.009) return "0.00";
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${abs}` : abs;
}

/**
 * Hesabati kashf balance display (legacy — customers and generic use).
 * @param {"supplier"|"customer"} partyType
 * @param {number} systemBalance
 */
export function hesabatiBalanceDisplay(partyType, systemBalance) {
  const n = round2(Number(systemBalance) || 0);
  if (Math.abs(n) < 0.009) {
    return { systemBalance: 0, hesabatiBalance: 0, formatted: "0.00", suffix: "", isNegative: false };
  }
  const hesabatiBalance = partyType === "supplier" ? -n : n;
  const formatted = formatExcelSignedAmount(hesabatiBalance);
  return {
    systemBalance: n,
    hesabatiBalance,
    formatted,
    suffix: hesabatiBalance < 0 ? "-" : "",
    isNegative: hesabatiBalance < 0,
  };
}

/**
 * @param {unknown} ev
 * @returns {string|null}
 */
function formatEventDate(ev) {
  if (!ev?.ev_date) return null;
  const s = String(ev.ev_date);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Supplier kashf using Excel-native signs and running = prev + debit - credit.
 * @param {object} party
 * @param {object} ledger
 * @param {{ from?: string, to?: string }} [range]
 * @param {{ storeName?: string }} [options]
 */
export function formatSupplierHesabatiStatement(party, ledger, range = {}, options = {}) {
  const code = party.supplier_code;
  const excelOpening = round2(Number(ledger.excel_opening_balance) || 0);
  const openingDebit = excelOpening > 0 ? excelOpening : 0;
  const openingCredit = excelOpening < 0 ? round2(-excelOpening) : 0;
  const openingDate =
    ledger.opening?.ev_date ||
    ledger.opening_entry?.entry_date ||
    (party.opening_balance_date ? String(party.opening_balance_date).slice(0, 10) : null);
  const openingNotes =
    party.opening_balance_source === "hesabati_import" ? HESABATI_IMPORT_NOTE : "—";

  const rows = [];
  let running = excelOpening;

  rows.push({
    line_no: code || "0",
    description: EV_LABELS.supplier.opening,
    date: openingDate,
    debit: openingDebit,
    credit: openingCredit,
    balance: running,
    balance_formatted: formatExcelSignedAmount(running),
    balance_is_negative: running < 0,
    notes: openingNotes,
    ref_id: ledger.opening_entry?.id ?? ledger.opening?.ref_id ?? null,
    ev_type: "opening",
  });

  for (const ev of ledger.events || []) {
    const debit = round2(Number(ev.debit) || 0);
    const credit = round2(Number(ev.credit) || 0);
    running = round2(running + debit - credit);
    rows.push({
      line_no: ev.ref_id != null ? String(ev.ref_id) : "",
      description: EV_LABELS.supplier[ev.ev_type] || ev.ev_type,
      date: formatEventDate(ev),
      debit,
      credit,
      balance: running,
      balance_formatted: formatExcelSignedAmount(running),
      balance_is_negative: running < 0,
      notes: ev.notes || "",
      ref_id: ev.ref_id ?? null,
      ev_type: ev.ev_type,
    });
  }

  const movementRows = rows.filter((r) => r.ev_type !== "opening");
  const totalDebit = round2(movementRows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(movementRows.reduce((s, r) => s + r.credit, 0));
  const closingExcel = round2(Number(ledger.excel_closing_balance ?? running) || 0);

  return {
    party_type: "supplier",
    store_name: options.storeName || null,
    party: {
      id: party.id,
      name: party.name,
      code: code || null,
      phone: party.contact_phone || null,
      balance: round2(Number(party.balance) || 0),
    },
    title: "كشف حساب مورد",
    date_from: range.from || null,
    date_to: range.to || null,
    opening_balance: excelOpening,
    opening_balance_formatted: formatExcelSignedAmount(excelOpening),
    closing_balance: closingExcel,
    closing_balance_formatted: formatExcelSignedAmount(closingExcel),
    rows,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      final_balance: closingExcel,
      final_balance_formatted: formatExcelSignedAmount(closingExcel),
    },
  };
}

/**
 * @param {"supplier"|"customer"} partyType
 * @param {object} party
 * @param {{ opening: object, events: object[], closing_balance: number, opening_balance?: number }} ledger
 * @param {{ from?: string, to?: string }} [range]
 * @param {{ openingLabel?: string, storeName?: string }} [options]
 */
export function formatHesabatiStatement(partyType, party, ledger, range = {}, options = {}) {
  if (partyType === "supplier") {
    return formatSupplierHesabatiStatement(party, ledger, range, options);
  }

  const labels = { ...EV_LABELS[partyType] };
  if (options.openingLabel) labels.opening = options.openingLabel;

  const code = party.customer_code;
  const phone = party.phone;

  const rows = [];

  const opening = ledger.opening;
  if (opening) {
    const ob = ledger.opening_balance ?? opening.running_balance ?? party.opening_balance ?? 0;
    const bal = hesabatiBalanceDisplay(partyType, ob);
    rows.push({
      line_no: code || "0",
      description: labels.opening,
      date: opening.ev_date ? formatEventDate(opening) : null,
      debit: round2(Number(opening.debit) || 0),
      credit: round2(Number(opening.credit) || 0),
      balance: bal.hesabatiBalance,
      balance_formatted: bal.formatted,
      balance_is_negative: bal.isNegative,
      notes: "",
      ref_id: opening.ref_id ?? null,
      ev_type: "opening",
    });
  }

  for (const ev of ledger.events || []) {
    const bal = hesabatiBalanceDisplay(partyType, ev.running_balance);
    rows.push({
      line_no: ev.ref_id != null ? String(ev.ref_id) : "",
      description: labels[ev.ev_type] || ev.ev_type,
      date: formatEventDate(ev),
      debit: round2(Number(ev.debit) || 0),
      credit: round2(Number(ev.credit) || 0),
      balance: bal.hesabatiBalance,
      balance_formatted: bal.formatted,
      balance_is_negative: bal.isNegative,
      notes: ev.notes || "",
      ref_id: ev.ref_id ?? null,
      ev_type: ev.ev_type,
    });
  }

  const movementRows = rows.filter((r) => r.ev_type !== "opening");
  const totalDebit = round2(movementRows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(movementRows.reduce((s, r) => s + r.credit, 0));

  const closing = hesabatiBalanceDisplay(partyType, ledger.closing_balance ?? party.balance ?? 0);

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
    title: "كشف حساب عميل",
    date_from: range.from || null,
    date_to: range.to || null,
    opening_balance: round2(Number(ledger.opening_balance ?? party.opening_balance) || 0),
    closing_balance: round2(Number(ledger.closing_balance) || 0),
    closing_balance_formatted: closing.formatted,
    rows,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      final_balance: round2(Number(ledger.closing_balance) || 0),
      final_balance_formatted: closing.formatted,
    },
  };
}
