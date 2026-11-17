import { ils } from "./format";

export const SUPPLIER_PAYMENTS_UNRECONCILED_AR = "توجد سجلات دفعات موردين قديمة تحتاج مطابقة";
export const ZERO_PRICE_STOCK_AR = "بيانات تقييم المخزون تحتوي على أسعار بيع صفرية";
export const NEGATIVE_INVENTORY_AR = "قيمة المخزون سالبة بسبب وجود كميات سالبة في المخزون";
export const INCOMPLETE_INVENTORY_COST_AR = "تقييم المخزون بالتكلفة غير مكتمل — أصناف لها كمية بدون تكلفة";
export const INCOMPLETE_INVENTORY_RETAIL_AR = "تقييم المخزون بسعر البيع غير مكتمل — أصناف لها كمية بدون سعر";
export const CURRENT_POSITION_AS_OF_AR = "حاليًا — لا تتأثر بالفترة المختارة";
export const INCOMPLETE_MONEY_AR = "غير مكتمل";

function gapCount(gap, key) {
  return Number(gap?.[key]) || 0;
}

/** Short explanation of why period COGS and profit stay incomplete. */
export function financeCostGapHeadline(gap) {
  if (!gap) return "";
  const bits = [];
  const lines = gapCount(gap, "nullCostLines");
  if (lines > 0) {
    bits.push(`${lines} بند بيع بلا تكلفة محفوظة في ${gapCount(gap, "nullCostTransactions")} فاتورة`);
  }
  const missing = gapCount(gap, "salesMissingItems");
  if (missing > 0) bits.push(`${missing} فاتورة بلا بنود محفوظة`);
  const refundBits = [];
  const nullRefunds = gapCount(gap, "refundsNullSnapshot");
  const unmatched = gapCount(gap, "refundsUnmatched");
  const blankRefunds = gapCount(gap, "refundsWithoutLines");
  if (nullRefunds > 0) refundBits.push(`${nullRefunds} استرجاع على بند بلا تكلفة محفوظة`);
  if (unmatched > 0) refundBits.push(`${unmatched} استرجاع لا يطابق تكلفة البيع المحفوظة`);
  if (blankRefunds > 0) refundBits.push(`${blankRefunds} استرجاع بلا بنود`);
  bits.push(...refundBits);
  if (!bits.length) return "";
  return `الربح غير مكتمل: ${bits.join("، ")}.`;
}

/** Tooltip / details: what is missing and why the three profit cards stay incomplete. */
export function financeCostGapDetails(gap) {
  if (!financeCostGapHeadline(gap)) return "";
  const lines = [
    "النقص لا يُحسب صفراً، ولا تُستخدم تكلفة الشراء الحالية لإعادة تسعير بيع سابق.",
    "لذلك تبقى تكلفة البضاعة والربح الإجمالي وهامشه وصافي الربح التشغيلي غير مكتملة للفترة كلها، حتى لو كانت بقية البنود معروفة.",
    "مصاريف التشغيل تبقى محسوبة، ولا تُخصم من ربح غير مكتمل.",
  ];
  const names = Array.isArray(gap?.productNames) ? gap.productNames.filter(Boolean) : [];
  if (names.length) lines.push(`أصناف بلا تكلفة محفوظة: ${names.join("، ")}.`);
  const ids = Array.isArray(gap?.transactionIds) ? gap.transactionIds.filter((id) => Number(id) > 0) : [];
  if (ids.length) lines.push(`أمثلة على الفواتير: ${ids.join("، ")}.`);
  return lines.join("\n");
}

export function isInventoryValuationIncomplete(pos) {
  return !!(pos?.inventoryCostIncomplete || pos?.inventoryRetailIncomplete
    || Number(pos?.nullCostStockedCount) > 0
    || Number(pos?.nullPriceStockedCount) > 0);
}

export function hasNegativeInventoryValuation(pos) {
  const cost = Number(pos?.inventoryAtCost);
  const retail = Number(pos?.inventoryAtRetail);
  return (Number.isFinite(cost) && cost < 0) || (Number.isFinite(retail) && retail < 0);
}

export function ilsOrIncomplete(amount, unknown) {
  if (unknown === true) return INCOMPLETE_MONEY_AR;
  if (amount == null || amount === "") return INCOMPLETE_MONEY_AR;
  const v = Number(amount);
  if (!Number.isFinite(v)) return INCOMPLETE_MONEY_AR;
  return ils(v);
}

export function buildFinancePrintSummary(overview) {
  if (!overview) return [];
  const unknown = !!(overview.cogs_unknown || overview.profit?.cogsKnown === false);
  const pay = overview.supplierPayments || {};
  const payValue =
    pay.status === "unreconciled"
      ? "تحتاج مطابقة البيانات"
      : ils(pay.total ?? 0);
  const rows = [
    { label: "إجمالي المبيعات", value: ils(overview.sales?.gross) },
    { label: "الاسترجاعات", value: ils(overview.sales?.refunds) },
    { label: "صافي المبيعات", value: ils(overview.sales?.net) },
    { label: "تكلفة البضاعة", value: ilsOrIncomplete(overview.profit?.cogs, unknown) },
    { label: "الربح الإجمالي", value: ilsOrIncomplete(overview.profit?.grossProfit, unknown) },
    { label: "مصاريف التشغيل", value: ils(overview.profit?.operatingExpenses) },
    {
      label: "صافي الربح التشغيلي",
      value: ilsOrIncomplete(overview.profit?.operatingNetProfit, unknown),
    },
    { label: "دفعات الموردين", value: payValue },
    { label: "صافي المشتريات", value: ils(overview.purchases?.net) },
    { label: "إجمالي المشتريات", value: ils(overview.purchases?.gross) },
    { label: "مرتجعات المشتريات", value: ils(overview.purchases?.returns) },
    { label: "ذمم العملاء والموظفين (حاليًا — لا تتأثر بالفترة المختارة)", value: ils(overview.currentPosition?.customerReceivables) },
    { label: "مخزون تكلفة (حاليًا — لا تتأثر بالفترة المختارة)", value: ils(overview.currentPosition?.inventoryAtCost) },
    { label: "مخزون بيع (حاليًا — لا تتأثر بالفترة المختارة)", value: ils(overview.currentPosition?.inventoryAtRetail) },
  ];
  if (hasNegativeInventoryValuation(overview.currentPosition)) {
    rows.push({ label: "تنبيه المخزون", value: NEGATIVE_INVENTORY_AR });
  }
  if (isInventoryValuationIncomplete(overview.currentPosition)) {
    if (overview.currentPosition?.inventoryCostIncomplete || Number(overview.currentPosition?.nullCostStockedCount) > 0) {
      rows.push({ label: "تنبيه تقييم المخزون", value: INCOMPLETE_INVENTORY_COST_AR });
    }
    if (overview.currentPosition?.inventoryRetailIncomplete || Number(overview.currentPosition?.nullPriceStockedCount) > 0) {
      rows.push({ label: "تنبيه تقييم البيع", value: INCOMPLETE_INVENTORY_RETAIL_AR });
    }
  }
  const gapHeadline = financeCostGapHeadline(overview.profit?.costGap);
  const gapText = financeCostGapDetails(overview.profit?.costGap);
  if (unknown && (gapHeadline || gapText)) {
    rows.push({ label: "سبب نقص التكلفة", value: [gapHeadline, gapText].filter(Boolean).join("\n") });
  }
  return rows;
}
