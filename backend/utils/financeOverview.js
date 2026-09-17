import {
  fetchRefundsForShopDateRange,
  fetchTransactionsForShopDateRange,
} from "./businessDay.js";
import {
  snapshotRefundCogsForRange,
  snapshotSalesCogsForRange,
} from "./cogs.js";
import { round2, sumMoney } from "./money.js";
import { postedPurchaseTotalsForDateRange } from "./purchasePeriodTotals.js";

function parseDateParam(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

/**
 * @param {object} query
 * @returns {{ from: string, to: string } | { error: string, status: number }}
 */
export function parseOverviewRange(query) {
  const from = parseDateParam(query?.from);
  const to = parseDateParam(query?.to);
  if (!from || !to) {
    return { error: "مطلوب from و to بصيغة YYYY-MM-DD", status: 400 };
  }
  if (from > to) {
    return { error: "from يجب أن يكون قبل to أو يساويه", status: 400 };
  }
  return { from, to };
}

function supplierPaymentsPayload(voucherTotal, voucherCount, legacyTotal, legacyCount) {
  const legacyRecordsPresent = legacyCount > 0;
  return {
    status: legacyRecordsPresent ? "unreconciled" : "voucher_authoritative",
    voucherTotal,
    legacyTotal,
    voucherCount,
    legacyCount,
    total: legacyRecordsPresent ? null : voucherTotal,
  };
}

/**
 * Read-only finance dashboard payload for a shop date range.
 * Sales/refunds/COGS use shop business day. Opex and supplier payments use calendar dates.
 * Inventory and receivables are current snapshots.
 * @param {object} db
 * @param {string} from
 * @param {string} to
 */
export async function buildFinanceOverview(db, from, to) {
  const [txs, refunds, cogsSales, cogsRefunds] = await Promise.all([
    fetchTransactionsForShopDateRange(db, from, to),
    fetchRefundsForShopDateRange(db, from, to),
    snapshotSalesCogsForRange(db, from, to),
    snapshotRefundCogsForRange(db, from, to),
  ]);

  const posGross = sumMoney(txs.map((row) => row.total));
  const refundTotal = sumMoney(refunds.map((row) => row.total));
  const netPos = round2(posGross - refundTotal);
  const posCount = txs.length;
  const refundCount = refunds.length;

  const cogsUnknown = !!(cogsSales.unknown || cogsRefunds.unknown);
  const salesCogs = cogsUnknown ? null : cogsSales.cogs;
  const refundCogs = cogsUnknown ? null : cogsRefunds.cogs;
  const netCogs = cogsUnknown ? null : round2((cogsSales.cogs || 0) - (cogsRefunds.cogs || 0));
  const estGrossProfit = cogsUnknown ? null : round2(netPos - netCogs);
  const grossMarginPercent =
    cogsUnknown || netPos === 0 ? null : round2((estGrossProfit / netPos) * 100);

  const [expRow, payRow, voucherRow, inv, recv, apRow, purchases] = await Promise.all([
    db.get(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as n
       FROM operating_expenses
       WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    ),
    db.get(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as n
       FROM supplier_payments
       WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    ),
    db.get(
      `SELECT COALESCE(SUM(vl.amount_nis), 0) AS total, COUNT(*) AS n
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.status = 'posted'
         AND v.voucher_type = 'payment'
         AND vl.supplier_id IS NOT NULL
         AND v.voucher_date >= ? AND v.voucher_date <= ?`,
      [from, to]
    ),
    db.get(
      `SELECT
         COALESCE(SUM(stock * cost), 0) AS at_cost,
         COALESCE(SUM(stock * price), 0) AS at_retail,
         SUM(CASE WHEN ABS(stock) > 0.009 AND (price IS NULL OR price = 0) THEN 1 ELSE 0 END) AS zero_price_stocked,
         SUM(CASE WHEN ABS(stock) > 0.009 AND cost IS NULL THEN 1 ELSE 0 END) AS null_cost_stocked,
         SUM(CASE WHEN ABS(stock) > 0.009 AND price IS NULL THEN 1 ELSE 0 END) AS null_price_stocked
       FROM products`
    ),
    // Store-wide receivables include employee-linked debt accounts once.
    // Customer-only totals are GET /customers/balances (excludes employees.customer_id).
    db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS total_due,
         SUM(CASE WHEN balance > 0.009 THEN 1 ELSE 0 END) AS customers_with_balance
       FROM customers`
    ),
    db.get(
      `SELECT COALESCE(SUM(amount_total - amount_paid), 0) as outstanding, COUNT(*) as n
       FROM supplier_invoices
       WHERE status = 'open' AND (amount_total - amount_paid) > 0.009`
    ),
    postedPurchaseTotalsForDateRange(db, from, to),
  ]);

  const opexTotal = round2(Number(expRow?.total) || 0);
  const opexCount = Number(expRow?.n) || 0;
  const operatingNetProfit = cogsUnknown ? null : round2(estGrossProfit - opexTotal);

  const legacyTotal = round2(Number(payRow?.total) || 0);
  const legacyCount = Number(payRow?.n) || 0;
  const voucherTotal = round2(Number(voucherRow?.total) || 0);
  const voucherCount = Number(voucherRow?.n) || 0;
  const supplierPayments = supplierPaymentsPayload(
    voucherTotal,
    voucherCount,
    legacyTotal,
    legacyCount
  );

  const inventoryAtCost = round2(Number(inv?.at_cost) || 0);
  const inventoryAtRetail = round2(Number(inv?.at_retail) || 0);
  const zeroPriceStockedCount = Number(inv?.zero_price_stocked) || 0;
  const nullCostStockedCount = Number(inv?.null_cost_stocked) || 0;
  const nullPriceStockedCount = Number(inv?.null_price_stocked) || 0;
  const inventoryCostIncomplete = nullCostStockedCount > 0;
  const inventoryRetailIncomplete = nullPriceStockedCount > 0;
  const customerReceivables = round2(Number(recv?.total_due) || 0);
  const customersWithBalance = Number(recv?.customers_with_balance) || 0;

  const avgTicket = posCount > 0 ? round2(posGross / posCount) : null;
  const refundRatePercent = posGross > 0 ? round2((refundTotal / posGross) * 100) : null;

  return {
    from,
    to,
    pos_sales_total: posGross,
    pos_transaction_count: posCount,
    refunds_total: refundTotal,
    refund_count: refundCount,
    net_pos_sales: netPos,
    operating_expenses_total: opexTotal,
    operating_expense_count: opexCount,
    supplier_payments_total: legacyTotal,
    supplier_payment_count: legacyCount,
    estimated_cogs_on_sales: salesCogs,
    estimated_cogs_on_refunds: refundCogs,
    net_estimated_cogs: netCogs,
    estimated_gross_profit: estGrossProfit,
    cogs_unknown: cogsUnknown,
    inventory_value_at_cost: inventoryAtCost,
    inventory_value_at_retail: inventoryAtRetail,
    zero_price_stocked_count: zeroPriceStockedCount,
    open_payables_total: round2(Number(apRow?.outstanding) || 0),
    open_invoices_count: Number(apRow?.n) || 0,
    sales: {
      gross: posGross,
      refunds: refundTotal,
      net: netPos,
      transactionCount: posCount,
      refundCount,
      avgTicket,
      refundRatePercent,
    },
    profit: {
      cogs: netCogs,
      cogsKnown: !cogsUnknown,
      grossProfit: estGrossProfit,
      grossMarginPercent,
      operatingExpenses: opexTotal,
      operatingNetProfit,
    },
    supplierPayments,
    purchases,
    currentPosition: {
      customerReceivables,
      customersWithBalance,
      inventoryAtCost,
      inventoryAtRetail,
      zeroPriceStockedCount,
      nullCostStockedCount,
      nullPriceStockedCount,
      inventoryCostIncomplete,
      inventoryRetailIncomplete,
    },
  };
}
