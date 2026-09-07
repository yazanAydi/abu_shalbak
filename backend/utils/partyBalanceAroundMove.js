import { round2 } from "./money.js";
import { buildSupplierLedger } from "./supplierLedger.js";
import { buildCustomerLedger } from "./customerLedger.js";
import { loadSalePayments } from "./salePayments.js";

const EPS = 0.009;

function displayAmount(n) {
  return Math.abs(round2(n)).toFixed(2);
}

function pack(partyType, name, before, after, projected) {
  const b = round2(before);
  const a = round2(after);
  if (Math.abs(a - b) < EPS) return null;
  return {
    type: partyType,
    name: name || "",
    before: b,
    after: a,
    projected: Boolean(projected),
    before_display: displayAmount(b),
    after_display: displayAmount(a),
  };
}

async function lookupLedgerAfter(db, party, partyType, sourceType, sourceId) {
  const id = Number(sourceId);
  if (!sourceType || !Number.isFinite(id) || id <= 0) return null;
  const ledger =
    partyType === "supplier"
      ? await buildSupplierLedger(db, party, null, null)
      : await buildCustomerLedger(db, party, null, null);
  const matches = (ledger.events || []).filter(
    (e) => e.ev_type === sourceType && Number(e.ref_id) === id
  );
  if (!matches.length) return null;
  return round2(Number(matches[matches.length - 1].running_balance));
}

/**
 * Historical (or preview) party balance around one movement.
 * @param {object} db
 * @param {{
 *   partyType: "supplier"|"customer",
 *   partyId: number,
 *   partyName?: string,
 *   delta: number,
 *   status?: string,
 *   sourceType?: string,
 *   sourceId?: number,
 * }} opts
 */
export async function partyBalanceAroundMove(db, opts) {
  const partyType =
    opts.partyType === "supplier" || opts.partyType === "customer" ? opts.partyType : null;
  const partyId = Number(opts.partyId);
  const delta = round2(opts.delta);
  if (!partyType || !Number.isFinite(partyId) || partyId <= 0) return null;
  if (Math.abs(delta) < EPS) return null;

  const table = partyType === "supplier" ? "suppliers" : "customers";
  const party = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [partyId]);
  if (!party) return null;

  const current = round2(Number(party.balance) || 0);
  const name = opts.partyName || party.name || "";
  const posted = opts.status === "posted" || opts.status === "approved";

  if (!posted) {
    return pack(partyType, name, current, current + delta, true);
  }

  const afterFromLedger = await lookupLedgerAfter(db, party, partyType, opts.sourceType, opts.sourceId);
  if (afterFromLedger != null) {
    return pack(partyType, name, afterFromLedger - delta, afterFromLedger, false);
  }
  return pack(partyType, name, current - delta, current, false);
}

export function saleOnAccountTotal(payments) {
  const rows = Array.isArray(payments) ? payments : [];
  return round2(
    rows
      .filter((l) => l.method === "on_account")
      .reduce((s, l) => s + Number(l.nis_equivalent ?? l.amount ?? 0), 0)
  );
}

export async function partyBalanceForVoucher(db, voucher, lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const first = rows.find((L) => L.customer_id || L.supplier_id);
  if (!first) return null;

  if (first.customer_id) {
    const amount = rows
      .filter((L) => Number(L.customer_id) === Number(first.customer_id))
      .reduce((s, L) => s + Number(L.amount_nis ?? L.amount ?? 0), 0);
    const delta = voucher.voucher_type === "receipt" ? -amount : amount;
    return partyBalanceAroundMove(db, {
      partyType: "customer",
      partyId: first.customer_id,
      partyName: first.customer_name,
      delta,
      status: voucher.status,
      sourceType: "payment",
      sourceId: voucher.id,
    });
  }

  if (first.supplier_id) {
    const amount = rows
      .filter((L) => Number(L.supplier_id) === Number(first.supplier_id))
      .reduce((s, L) => s + Number(L.amount_nis ?? L.amount ?? 0), 0);
    const delta = voucher.voucher_type === "receipt" ? amount : -amount;
    return partyBalanceAroundMove(db, {
      partyType: "supplier",
      partyId: first.supplier_id,
      partyName: first.supplier_name,
      delta,
      status: voucher.status,
      sourceType: "payment",
      sourceId: voucher.id,
    });
  }
  return null;
}

export async function partyBalanceForPurchaseInvoice(db, inv) {
  return partyBalanceAroundMove(db, {
    partyType: "supplier",
    partyId: inv.supplier_id,
    partyName: inv.supplier_name,
    delta: Number(inv.total) || 0,
    status: inv.status,
    sourceType: "purchase",
    sourceId: inv.id,
  });
}

export async function partyBalanceForPurchaseReturn(db, ret) {
  return partyBalanceAroundMove(db, {
    partyType: "supplier",
    partyId: ret.supplier_id,
    partyName: ret.supplier_name,
    delta: -(Number(ret.total) || 0),
    status: ret.status,
    sourceType: "purchase_return",
    sourceId: ret.id,
  });
}

export async function partyBalanceForSalesInvoice(db, inv) {
  return partyBalanceAroundMove(db, {
    partyType: "customer",
    partyId: inv.customer_id,
    partyName: inv.customer_name,
    delta: Number(inv.on_account_amount) || 0,
    status: inv.status,
    sourceType: "sale_invoice",
    sourceId: inv.id,
  });
}

export async function partyBalanceForSale(db, { customerId, customerName, payments, transactionId, status }) {
  const onAccount = saleOnAccountTotal(payments);
  let sourceType = "sale";
  let sourceId = transactionId;
  if (transactionId) {
    const invoice = await db.get(
      "SELECT id FROM sales_invoices WHERE transaction_id = ? AND status = 'posted'",
      [transactionId]
    );
    if (invoice) {
      sourceType = "sale_invoice";
      sourceId = invoice.id;
    }
  }
  return partyBalanceAroundMove(db, {
    partyType: "customer",
    partyId: customerId,
    partyName: customerName,
    delta: onAccount,
    status: status || "posted",
    sourceType,
    sourceId,
  });
}

export async function partyBalanceForRefund(db, refund, originalTx) {
  if (String(refund?.payment_method) !== "on_account") return null;
  const custId = Number(refund.customer_id || originalTx?.customer_id);
  if (!custId) return null;
  const payments = await loadSalePayments(db, refund.original_transaction_id);
  const onAccountPaid = saleOnAccountTotal(payments);
  const saleTotal = round2(Number(originalTx?.total) || 0);
  const refundTotal = round2(Number(refund.total));
  const credit = saleTotal > 0 ? round2(refundTotal * (onAccountPaid / saleTotal)) : refundTotal;
  return partyBalanceAroundMove(db, {
    partyType: "customer",
    partyId: custId,
    partyName: originalTx?.customer_name,
    delta: -credit,
    status: refund.status === "approved" ? "posted" : refund.status,
    sourceType: "refund",
    sourceId: refund.id,
  });
}
