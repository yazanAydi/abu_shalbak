import { ils } from "./format";
import {
  INCOMPLETE_INVENTORY_COST_AR,
  INCOMPLETE_MONEY_AR,
  NEGATIVE_INVENTORY_AR,
  buildFinancePrintSummary,
  financeCostGapDetails,
  financeCostGapHeadline,
  hasNegativeInventoryValuation,
  isInventoryValuationIncomplete,
  ilsOrIncomplete,
} from "./financeDashboardHelpers";

describe("ilsOrIncomplete", () => {
  test("valid zero stays ₪0.00", () => {
    expect(ilsOrIncomplete(0, false)).toBe(ils(0));
  });

  test("unknown or null is غير مكتمل, never ₪0.00", () => {
    expect(ilsOrIncomplete(null, false)).toBe(INCOMPLETE_MONEY_AR);
    expect(ilsOrIncomplete(12, true)).toBe(INCOMPLETE_MONEY_AR);
    expect(ilsOrIncomplete(0, true)).toBe(INCOMPLETE_MONEY_AR);
    expect(ilsOrIncomplete(0, true)).not.toBe(ils(0));
  });
});

describe("buildFinancePrintSummary", () => {
  test("does not print ₪0 for unknown profit fields", () => {
    const rows = buildFinancePrintSummary({
      cogs_unknown: true,
      sales: { gross: 20, refunds: 0, net: 20 },
      profit: {
        cogs: null,
        cogsKnown: false,
        grossProfit: null,
        operatingExpenses: 5,
        operatingNetProfit: null,
      },
      supplierPayments: { status: "unreconciled", total: null, voucherTotal: 10, legacyTotal: 10 },
      purchases: { gross: 40, returns: 5, net: 35, invoiceCount: 2, returnCount: 1 },
      currentPosition: { customerReceivables: 3, inventoryAtCost: 1, inventoryAtRetail: 2 },
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["تكلفة البضاعة"]).toBe(INCOMPLETE_MONEY_AR);
    expect(byLabel["الربح الإجمالي"]).toBe(INCOMPLETE_MONEY_AR);
    expect(byLabel["صافي الربح التشغيلي"]).toBe(INCOMPLETE_MONEY_AR);
    expect(byLabel["مصاريف التشغيل"]).toBe(ils(5));
    expect(byLabel["دفعات الموردين"]).toBe("تحتاج مطابقة البيانات");
    expect(byLabel["صافي المشتريات"]).toBe(ils(35));
    expect(byLabel["إجمالي المشتريات"]).toBe(ils(40));
    expect(byLabel["مرتجعات المشتريات"]).toBe(ils(5));
  });

  test("keeps negative inventory numbers and adds the warning", () => {
    const rows = buildFinancePrintSummary({
      sales: { gross: 20, refunds: 0, net: 20 },
      profit: {
        cogs: 4,
        cogsKnown: true,
        grossProfit: 16,
        operatingExpenses: 0,
        operatingNetProfit: 16,
      },
      supplierPayments: { status: "voucher_authoritative", total: 8, voucherTotal: 8, legacyTotal: 0 },
      currentPosition: { customerReceivables: 0, inventoryAtCost: -379.25, inventoryAtRetail: -163946 },
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["مخزون تكلفة (حاليًا — لا تتأثر بالفترة المختارة)"]).toBe(ils(-379.25));
    expect(byLabel["مخزون بيع (حاليًا — لا تتأثر بالفترة المختارة)"]).toBe(ils(-163946));
    expect(byLabel["ذمم العملاء والموظفين (حاليًا — لا تتأثر بالفترة المختارة)"]).toBe(ils(0));
    expect(byLabel["تنبيه المخزون"]).toBe(NEGATIVE_INVENTORY_AR);
    expect(byLabel["دفعات الموردين"]).toBe(ils(8));
  });

  test("keeps inventory numbers and flags incomplete valuation", () => {
    const rows = buildFinancePrintSummary({
      sales: { gross: 1, refunds: 0, net: 1 },
      profit: { cogs: 0, cogsKnown: true, grossProfit: 1, operatingExpenses: 0, operatingNetProfit: 1 },
      supplierPayments: { status: "voucher_authoritative", total: 0 },
      currentPosition: {
        customerReceivables: 0,
        inventoryAtCost: 12,
        inventoryAtRetail: 20,
        inventoryCostIncomplete: true,
        nullCostStockedCount: 1,
      },
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["مخزون تكلفة (حاليًا — لا تتأثر بالفترة المختارة)"]).toBe(ils(12));
    expect(byLabel["تنبيه تقييم المخزون"]).toBe(INCOMPLETE_INVENTORY_COST_AR);
  });

  test("prints a known zero without a missing-cost reason, and prints the reason when cost is missing", () => {
    const zeroRows = buildFinancePrintSummary({
      cogs_unknown: false,
      sales: { gross: 0, refunds: 0, net: 0 },
      profit: {
        cogs: 0,
        cogsKnown: true,
        grossProfit: 0,
        operatingExpenses: 0,
        operatingNetProfit: 0,
        costGap: null,
      },
      supplierPayments: { status: "voucher_authoritative", total: 0 },
      purchases: { gross: 0, returns: 0, net: 0 },
      currentPosition: { customerReceivables: 0, inventoryAtCost: 0, inventoryAtRetail: 0 },
    });
    const zero = Object.fromEntries(zeroRows.map((r) => [r.label, r.value]));
    expect(zero["تكلفة البضاعة"]).toBe(ils(0));
    expect(zero["الربح الإجمالي"]).toBe(ils(0));
    expect(zero["صافي الربح التشغيلي"]).toBe(ils(0));
    expect(zero["سبب نقص التكلفة"]).toBeUndefined();

    const missingRows = buildFinancePrintSummary({
      cogs_unknown: true,
      sales: { gross: 10, refunds: 0, net: 10 },
      profit: {
        cogs: null,
        cogsKnown: false,
        grossProfit: null,
        operatingExpenses: 4,
        operatingNetProfit: null,
        costGap: {
          nullCostLines: 1,
          nullCostTransactions: 1,
          productNames: ["صنف"],
          transactionIds: [9],
        },
      },
      supplierPayments: { status: "voucher_authoritative", total: 0 },
      purchases: { gross: 0, returns: 0, net: 0 },
      currentPosition: { customerReceivables: 0, inventoryAtCost: 0, inventoryAtRetail: 0 },
    });
    const missing = Object.fromEntries(missingRows.map((r) => [r.label, r.value]));
    expect(missing["تكلفة البضاعة"]).toBe(INCOMPLETE_MONEY_AR);
    expect(missing["الربح الإجمالي"]).toBe(INCOMPLETE_MONEY_AR);
    expect(missing["صافي الربح التشغيلي"]).toBe(INCOMPLETE_MONEY_AR);
    expect(missing["مصاريف التشغيل"]).toBe(ils(4));
    expect(missing["سبب نقص التكلفة"]).toContain("1 بند بيع بلا تكلفة محفوظة");
    expect(missing["سبب نقص التكلفة"]).toContain("لا يُحسب صفراً");
    expect(missing["سبب نقص التكلفة"]).not.toContain("₪0.00");
  });
});

describe("finance cost gap copy", () => {
  const gap = {
    nullCostLines: 2,
    nullCostTransactions: 1,
    salesMissingItems: 1,
    refundsNullSnapshot: 0,
    refundsUnmatched: 1,
    refundsWithoutLines: 0,
    productNames: ["حافة تكلفة مفقودة"],
    transactionIds: [22],
  };

  test("names the missing records and does not call them zero", () => {
    const headline = financeCostGapHeadline(gap);
    expect(headline).toContain("2 بند بيع بلا تكلفة محفوظة في 1 فاتورة");
    expect(headline).toContain("1 فاتورة بلا بنود محفوظة");
    expect(headline).toContain("1 استرجاع لا يطابق تكلفة البيع المحفوظة");
    const details = financeCostGapDetails(gap);
    expect(details).toContain("لا يُحسب صفراً");
    expect(details).toContain("تكلفة الشراء الحالية");
    expect(details).toContain("صافي الربح التشغيلي");
    expect(details).toContain("حافة تكلفة مفقودة");
    expect(details).toContain("22");
    expect(details).not.toContain("₪0.00");
    expect(headline).not.toContain("₪0.00");
  });

  test("a period with no missing inputs has no incomplete explanation", () => {
    expect(financeCostGapHeadline(null)).toBe("");
    expect(financeCostGapDetails({ nullCostLines: 0, salesMissingItems: 0 })).toBe("");
  });
});

describe("isInventoryValuationIncomplete", () => {
  test("true only when a stocked row is missing cost or price", () => {
    expect(isInventoryValuationIncomplete({ inventoryCostIncomplete: true })).toBe(true);
    expect(isInventoryValuationIncomplete({ nullPriceStockedCount: 2 })).toBe(true);
    expect(isInventoryValuationIncomplete({ zeroPriceStockedCount: 3, inventoryAtCost: 1 })).toBe(false);
    expect(isInventoryValuationIncomplete({ inventoryAtCost: 1, inventoryAtRetail: 2 })).toBe(false);
  });
});

describe("hasNegativeInventoryValuation", () => {
  test("true when cost or retail is negative, false otherwise", () => {
    expect(hasNegativeInventoryValuation({ inventoryAtCost: -1, inventoryAtRetail: 10 })).toBe(true);
    expect(hasNegativeInventoryValuation({ inventoryAtCost: 1, inventoryAtRetail: -2 })).toBe(true);
    expect(hasNegativeInventoryValuation({ inventoryAtCost: 0, inventoryAtRetail: 0 })).toBe(false);
    expect(hasNegativeInventoryValuation({ inventoryAtCost: 5, inventoryAtRetail: 9 })).toBe(false);
  });
});
