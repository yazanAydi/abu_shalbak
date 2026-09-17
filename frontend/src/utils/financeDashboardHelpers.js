import { ils } from "./format";

export const SUPPLIER_PAYMENTS_UNRECONCILED_AR = "توجد سجلات دفعات موردين قديمة تحتاج مطابقة";
export const ZERO_PRICE_STOCK_AR = "بيانات تقييم المخزون تحتوي على أسعار بيع صفرية";
export const NEGATIVE_INVENTORY_AR = "قيمة المخزون سالبة بسبب وجود كميات سالبة في المخزون";
export const INCOMPLETE_INVENTORY_COST_AR = "تقييم المخزون بالتكلفة غير مكتمل — أصناف لها كمية بدون تكلفة";
export const INCOMPLETE_INVENTORY_RETAIL_AR = "تقييم المخزون بسعر البيع غير مكتمل — أصناف لها كمية بدون سعر";
export const CURRENT_POSITION_AS_OF_AR = "حاليًا — لا تتأثر بالفترة المختارة";
export const INCOMPLETE_MONEY_AR = "غير مكتمل";

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
  return rows;
}
