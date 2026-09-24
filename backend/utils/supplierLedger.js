import { round2 } from "./tax.js";

const OPENING_ENTRY_SOURCE_TYPE = "opening_balance_import";

/**
 * @param {string} isoDate yyyy-mm-dd
 */
export function dayBefore(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} db
 * @param {number} supplierId
 */
export async function fetchSupplierOpeningEntry(db, supplierId) {
  return db.get(
    `SELECT * FROM party_opening_entries
     WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?`,
    [supplierId, OPENING_ENTRY_SOURCE_TYPE]
  );
}

/**
 * @param {object} supplier
 */
export function resolveSupplierExcelOpening(supplier) {
  if (supplier.opening_balance_excel != null && supplier.opening_balance_excel !== "") {
    return round2(Number(supplier.opening_balance_excel) || 0);
  }
  return round2(-(Number(supplier.opening_balance) || 0));
}

/**
 * @param {object} db
 * @param {number} supplierId
 * @param {string} [from]
 * @param {string} [to]
 */
export async function fetchSupplierLedgerEvents(db, supplierId, from, to) {
  const dateClause = (col) => {
    let c = "";
    const p = [];
    if (from) {
      c += ` AND ${col} >= ?`;
      p.push(from);
    }
    if (to) {
      c += ` AND ${col} <= ?`;
      p.push(to + (col.includes("date") ? "" : "T23:59:59"));
    }
    return { c, p };
  };
  const pinv = dateClause("invoice_date");
  const pret = dateClause("return_date");
  const vpay = dateClause("v.voucher_date");
  const lpay = dateClause("paid_on");
  const adj = dateClause("entry_date");

  return db.all(
    `SELECT 'purchase' AS ev_type, invoice_date AS ev_date, total AS credit, 0 AS debit, id AS ref_id, NULL AS notes, id AS sort_id
       FROM purchase_invoices WHERE supplier_id = ? AND status = 'posted' ${pinv.c}
     UNION ALL
     SELECT 'purchase_return' AS ev_type, return_date AS ev_date, 0 AS credit, total AS debit, id AS ref_id, NULL AS notes, id AS sort_id
       FROM purchase_returns WHERE supplier_id = ? AND status = 'posted' ${pret.c}
     UNION ALL
     SELECT 'payment' AS ev_type, v.voucher_date AS ev_date,
            CASE WHEN v.voucher_type = 'receipt' THEN vl.amount_nis ELSE 0 END AS credit,
            CASE WHEN v.voucher_type = 'payment' THEN vl.amount_nis ELSE 0 END AS debit,
            v.id AS ref_id, NULL AS notes, v.id AS sort_id
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.supplier_id = ? AND v.status = 'posted'
         AND v.voucher_type IN ('payment', 'receipt') ${vpay.c}
     UNION ALL
     SELECT 'payment' AS ev_type, paid_on AS ev_date, 0 AS credit, amount AS debit, id AS ref_id, NULL AS notes, id AS sort_id
       FROM supplier_payments WHERE supplier_id = ? ${lpay.c}
     UNION ALL
     SELECT 'adjustment' AS ev_type, entry_date AS ev_date, credit, debit, id AS ref_id, notes, id AS sort_id
       FROM supplier_adjustments WHERE supplier_id = ? ${adj.c}
     ORDER BY ev_date ASC, sort_id ASC`,
    [supplierId, ...pinv.p, supplierId, ...pret.p, supplierId, ...vpay.p, supplierId, ...lpay.p, supplierId, ...adj.p]
  );
}

/**
 * Excel kashf running balance: previous + debit - credit
 * @param {object[]} events
 * @param {number} start
 */
export function applyExcelRunning(events, start) {
  let running = round2(start);
  const rows = events.map((e) => {
    const debit = round2(Number(e.debit) || 0);
    const credit = round2(Number(e.credit) || 0);
    running = round2(running + debit - credit);
    return { ...e, excel_running_balance: running };
  });
  return { rows, closing: running };
}

/**
 * Supplier running balance: previous + credit - debit
 * @param {object[]} events
 * @param {number} start
 */
function applySupplierRunning(events, start) {
  let running = round2(start);
  const rows = events.map((e) => {
    running = round2(running + (Number(e.credit) || 0) - (Number(e.debit) || 0));
    return { ...e, running_balance: running };
  });
  return { rows, closing: running };
}

/**
 * @param {object} db
 * @param {object} supplier
 * @param {string} [from]
 * @param {string} [to]
 * @param {{ limit?: number|null }} [options] limit keeps only the most recent
 *   events in the response; the running balance is still computed over every
 *   event, so the numbers are identical either way.
 */
export async function buildSupplierLedger(db, supplier, from, to, options = {}) {
  const limit =
    Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Number(options.limit)
      : null;
  const openingEntry = await fetchSupplierOpeningEntry(db, supplier.id);
  let excelOpening = resolveSupplierExcelOpening(supplier);
  let openingBalance = round2(Number(supplier.opening_balance) || 0);

  if (from) {
    const priorEvents = await fetchSupplierLedgerEvents(db, supplier.id, null, dayBefore(from));
    openingBalance = applySupplierRunning(priorEvents, openingBalance).closing;
    excelOpening = applyExcelRunning(priorEvents, excelOpening).closing;
  }

  const events = await fetchSupplierLedgerEvents(db, supplier.id, from, to);
  const { rows, closing } = applySupplierRunning(events, openingBalance);
  const excelApplied = applyExcelRunning(events, excelOpening);
  const legacy = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM supplier_payments WHERE supplier_id = ?`,
    [supplier.id]
  );
  const legacyCount = Number(legacy?.n) || 0;
  const legacyPayments = {
    count: legacyCount,
    total: round2(Number(legacy?.total) || 0),
    linked: false,
    note:
      legacyCount > 0
        ? "دفعات supplier_payments بلا رابط بسند. لا يمكن إثبات أنها تكرار لسند، لذلك تبقى في الكشف ولا يُعدَّل رصيد المورد تاريخياً."
        : null,
  };

  const opening = {
    ev_type: "opening",
    ev_date:
      openingEntry?.entry_date ||
      (supplier.opening_balance_date ? String(supplier.opening_balance_date).slice(0, 10) : null),
    debit: excelOpening > 0 ? excelOpening : 0,
    credit: excelOpening < 0 ? round2(-excelOpening) : 0,
    ref_id: openingEntry?.id ?? null,
    running_balance: openingBalance,
    excel_running_balance: excelOpening,
    opening_source: supplier.opening_balance_source || null,
  };

  // excel_events used to ship here too: the same rows again with a different
  // running-balance field, and nothing ever read it. Only the excel totals are
  // consumed, so the array is gone and the payload is half the size.
  const windowed = limit != null && rows.length > limit ? rows.slice(rows.length - limit) : rows;

  return {
    opening,
    opening_entry: openingEntry,
    events: windowed,
    total_events: rows.length,
    truncated: windowed.length < rows.length,
    closing_balance: closing,
    legacy_payments: legacyPayments,
    excel_closing_balance: excelApplied.closing,
    opening_balance: openingBalance,
    excel_opening_balance: excelOpening,
  };
}
