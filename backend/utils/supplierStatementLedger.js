import { round2 } from "./tax.js";
import { dayBefore, fetchSupplierOpeningEntry } from "./supplierLedger.js";
import { HESABATI_HISTORY_SOURCE } from "./statementHistoryImport.js";

/**
 * Detailed supplier statement ledger in SYSTEM sign convention:
 *   - credit increases what we owe the supplier (a payable).
 *   - debit reduces what we owe the supplier.
 *   - runningBalance = previous + credit - debit
 *   - positive final balance => علينا للمورد (we owe the supplier).
 *
 * Unlike the Hesabati statement (Excel inverted sign), this builder enriches
 * every movement with document number, payment method, created-by user, a
 * public movement type, and a deep-link sourceRoute for drill-down.
 */

const PAYMENT_METHOD_AR = {
  cash: "نقدًا",
  transfer: "تحويل",
  bank: "تحويل بنكي",
  check: "شيك",
  other: "أخرى",
};

/**
 * @param {string|null|undefined} value
 */
function paymentMethodLabel(value) {
  if (!value) return null;
  return PAYMENT_METHOD_AR[String(value).toLowerCase()] || value;
}

/**
 * @param {string} col
 * @param {string|null} from
 * @param {string|null} to
 */
function dateClause(col, from, to) {
  let c = "";
  const p = [];
  if (from) {
    c += ` AND ${col} >= ?`;
    p.push(from);
  }
  if (to) {
    c += ` AND ${col} <= ?`;
    p.push(to);
  }
  return { c, p };
}

/**
 * Live ledger events with system-sign debit/credit columns plus enrichment.
 * @param {object} db
 * @param {number} supplierId
 * @param {string|null} from
 * @param {string|null} to
 */
export async function fetchEnrichedSupplierEvents(db, supplierId, from, to) {
  const pinv = dateClause("pi.invoice_date", from, to);
  const pret = dateClause("pr.return_date", from, to);
  const vpay = dateClause("v.voucher_date", from, to);
  const lpay = dateClause("sp.paid_on", from, to);
  const adj = dateClause("sa.entry_date", from, to);

  return db.all(
    `SELECT 'purchase_invoice' AS type, 'invoice' AS source_kind, pi.invoice_date AS ev_date,
            pi.total AS credit, 0 AS debit, pi.id AS document_id, pi.invoice_no AS document_no,
            NULL AS payment_method, u.username AS created_by, NULL AS ev_desc,
            pi.created_at AS sort_created, pi.id AS sort_id
       FROM purchase_invoices pi
       LEFT JOIN users u ON u.id = pi.created_by
       WHERE pi.supplier_id = ? AND pi.status = 'posted'${pinv.c}
     UNION ALL
     SELECT 'purchase_return', 'return', pr.return_date,
            0, pr.total, pr.id, pr.return_no,
            NULL, u.username, NULL, pr.created_at, pr.id
       FROM purchase_returns pr
       LEFT JOIN users u ON u.id = pr.created_by
       WHERE pr.supplier_id = ? AND pr.status = 'posted'${pret.c}
     UNION ALL
     SELECT 'supplier_payment', 'voucher', v.voucher_date,
            0, vl.amount_nis, v.id, v.voucher_no,
            vl.line_type, u.username, NULL, v.created_at, v.id
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       LEFT JOIN users u ON u.id = v.recorded_by_id
       WHERE vl.supplier_id = ? AND v.voucher_type = 'payment' AND v.status = 'posted'${vpay.c}
     UNION ALL
     SELECT 'supplier_payment', 'legacy_payment', sp.paid_on,
            0, sp.amount, sp.id, NULL,
            sp.payment_method, u.username, NULL, sp.created_at, sp.id
       FROM supplier_payments sp
       LEFT JOIN users u ON u.id = sp.recorded_by_id
       WHERE sp.supplier_id = ?${lpay.c}
     UNION ALL
     SELECT 'adjustment', 'manual_adjustment', sa.entry_date,
            sa.credit, sa.debit, sa.id, NULL,
            NULL, u.username, sa.notes, sa.created_at, sa.id
       FROM supplier_adjustments sa
       LEFT JOIN users u ON u.id = sa.created_by
       WHERE sa.supplier_id = ?${adj.c}
     ORDER BY ev_date ASC, sort_created ASC, sort_id ASC`,
    [supplierId, ...pinv.p, supplierId, ...pret.p, supplierId, ...vpay.p, supplierId, ...lpay.p, supplierId, ...adj.p]
  );
}

/**
 * Imported old statement history rows within range (null-dated rows are treated as in-range).
 * @param {object} db
 * @param {number} supplierId
 * @param {string|null} from
 * @param {string|null} to
 */
async function fetchImportedInRange(db, supplierId, from, to) {
  let sql = `SELECT * FROM account_statement_entries
    WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?`;
  const params = [supplierId, HESABATI_HISTORY_SOURCE];
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
 * Net system-sign delta (credit - debit) of dated imported rows before `from`.
 * @param {object} db
 * @param {number} supplierId
 * @param {string} from
 */
async function sumImportedPriorDelta(db, supplierId, from) {
  const rows = await db.all(
    `SELECT debit, credit FROM account_statement_entries
     WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?
       AND entry_date IS NOT NULL AND entry_date < ?`,
    [supplierId, HESABATI_HISTORY_SOURCE, from]
  );
  let delta = 0;
  for (const r of rows) {
    delta = round2(delta + (Number(r.credit) || 0) - (Number(r.debit) || 0));
  }
  return delta;
}

/**
 * @param {{ type: string, documentNo: string|null }} e
 */
function describeEvent(e) {
  const no = e.documentNo ? ` رقم ${e.documentNo}` : "";
  switch (e.type) {
    case "purchase_invoice":
      return `فاتورة مشتريات${no}`;
    case "purchase_return":
      return `مرتجع مشتريات${no}`;
    case "supplier_payment":
      return `سند دفع${no}`;
    case "adjustment":
      return "تسوية يدوية";
    default:
      return e.type;
  }
}

/**
 * @param {{ type: string, sourceKind: string, documentId: number|null }} e
 */
function sourceRouteFor(e) {
  if (e.documentId == null) return null;
  switch (e.type) {
    case "purchase_invoice":
      return `/purchases?invoiceId=${e.documentId}`;
    case "purchase_return":
      return `/purchases?returnId=${e.documentId}`;
    case "supplier_payment":
      return e.sourceKind === "voucher" ? `/vouchers?id=${e.documentId}` : null;
    default:
      return null;
  }
}

/**
 * @param {object} supplier
 * @param {string|null} from
 * @param {object|null} openingEntry
 */
function openingDate(supplier, from, openingEntry) {
  if (from) return dayBefore(from);
  if (openingEntry?.entry_date) return String(openingEntry.entry_date).slice(0, 10);
  if (supplier.opening_balance_date) return String(supplier.opening_balance_date).slice(0, 10);
  return null;
}

/**
 * @param {object} db
 * @param {object} supplier
 * @param {{ from?: string|null, to?: string|null }} [opts]
 */
export async function buildSupplierStatementLedger(db, supplier, opts = {}) {
  const from = opts.from || null;
  const to = opts.to || null;

  let openingBalance = round2(Number(supplier.opening_balance) || 0);
  if (from) {
    const priorLive = await fetchEnrichedSupplierEvents(db, supplier.id, null, dayBefore(from));
    for (const e of priorLive) {
      openingBalance = round2(openingBalance + (Number(e.credit) || 0) - (Number(e.debit) || 0));
    }
    openingBalance = round2(openingBalance + (await sumImportedPriorDelta(db, supplier.id, from)));
  }

  const openingEntry = await fetchSupplierOpeningEntry(db, supplier.id);

  const live = await fetchEnrichedSupplierEvents(db, supplier.id, from, to);
  const imported = await fetchImportedInRange(db, supplier.id, from, to);

  const rawEvents = [];
  for (const e of live) {
    rawEvents.push({
      sortDate: e.ev_date ? String(e.ev_date).slice(0, 10) : null,
      sortCreated: e.sort_created || "",
      sortId: Number(e.sort_id) || 0,
      type: e.type,
      sourceKind: e.source_kind,
      documentId: e.document_id ?? null,
      documentNo: e.document_no != null ? String(e.document_no) : null,
      description: e.ev_desc || null,
      debit: round2(Number(e.debit) || 0),
      credit: round2(Number(e.credit) || 0),
      paymentMethod: paymentMethodLabel(e.payment_method),
      createdBy: e.created_by || null,
    });
  }
  for (const h of imported) {
    rawEvents.push({
      sortDate: h.entry_date ? String(h.entry_date).slice(0, 10) : from,
      sortCreated: h.created_at || "",
      sortId: Number(h.id) || 0,
      type: "adjustment",
      sourceKind: "imported",
      documentId: h.id,
      documentNo: h.legacy_reference_number || null,
      description: h.description || "حركة مستوردة من كشف قديم",
      debit: round2(Number(h.debit) || 0),
      credit: round2(Number(h.credit) || 0),
      paymentMethod: null,
      createdBy: null,
    });
  }

  rawEvents.sort((a, b) => {
    const da = a.sortDate || "9999-12-31";
    const db2 = b.sortDate || "9999-12-31";
    if (da !== db2) return da < db2 ? -1 : 1;
    if (a.sortCreated !== b.sortCreated) return a.sortCreated < b.sortCreated ? -1 : 1;
    return a.sortId - b.sortId;
  });

  let running = openingBalance;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalInvoices = 0;
  let totalPayments = 0;
  let counter = 0;

  const eventMovements = rawEvents.map((e) => {
    running = round2(running + e.credit - e.debit);
    totalDebit = round2(totalDebit + e.debit);
    totalCredit = round2(totalCredit + e.credit);
    if (e.type === "purchase_invoice") totalInvoices = round2(totalInvoices + e.credit);
    if (e.type === "supplier_payment") totalPayments = round2(totalPayments + e.debit);
    return {
      id: `${e.type}_${e.sourceKind}_${e.documentId}_${++counter}`,
      date: e.sortDate,
      type: e.type,
      documentId: e.documentId,
      documentNo: e.documentNo,
      description: e.description || describeEvent(e),
      debit: e.debit,
      credit: e.credit,
      runningBalance: running,
      paymentMethod: e.paymentMethod,
      createdBy: e.createdBy,
      sourceRoute: sourceRouteFor(e),
    };
  });

  const finalBalance = round2(running);

  const hasOpening =
    Math.abs(openingBalance) > 0.009 || !!openingEntry || !!supplier.opening_balance_date;
  const movements = [];
  if (hasOpening) {
    movements.push({
      id: `opening_balance_${supplier.id}`,
      date: openingDate(supplier, from, openingEntry),
      type: "opening_balance",
      documentId: openingEntry?.id ?? null,
      documentNo: null,
      description: "رصيد افتتاحي",
      debit: openingBalance < 0 ? round2(-openingBalance) : 0,
      credit: openingBalance > 0 ? round2(openingBalance) : 0,
      runningBalance: openingBalance,
      paymentMethod: null,
      createdBy: null,
      sourceRoute: null,
    });
  }
  movements.push(...eventMovements);

  return {
    openingBalance,
    finalBalance,
    totalDebit,
    totalCredit,
    totalInvoices,
    totalPayments,
    movements,
  };
}
