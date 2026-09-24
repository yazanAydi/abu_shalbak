import {
  INCOMPLETE_PROFIT_AR,
  UNKNOWN_MONEY_AR,
  ils,
  ilsKnown,
} from "./format";
import {
  buildDailySummaryItems,
  buildRangeSummaryItems,
  incompleteProfitNote,
} from "./salesReportHelpers";

describe("ilsKnown — unknown historical cost/profit", () => {
  test("valid zero stays ₪0.00, not unknown", () => {
    expect(ilsKnown(0, false)).toBe(ils(0));
    expect(ilsKnown(0, false)).toBe("₪0.00");
  });

  test("null, NaN, and cost_unknown show غير معروف, never ₪0", () => {
    expect(ilsKnown(null, false)).toBe(UNKNOWN_MONEY_AR);
    expect(ilsKnown(undefined, false)).toBe(UNKNOWN_MONEY_AR);
    expect(ilsKnown(Number.NaN, false)).toBe(UNKNOWN_MONEY_AR);
    expect(ilsKnown(12, true)).toBe(UNKNOWN_MONEY_AR);
    expect(ilsKnown(0, true)).toBe(UNKNOWN_MONEY_AR);
    expect(ilsKnown(null, true)).not.toBe(ils(0));
    expect(ilsKnown(null, true)).not.toMatch(/NaN/);
  });
});

describe("office sales-report unknown profit copy", () => {
  test("daily summary uses غير معروف when cost is unknown", () => {
    const items = buildDailySummaryItems({
      net_sales: 20,
      total_sales: 20,
      total_transactions: 2,
      refund_count: 0,
      refunds_total: 0,
      items_sold: 2,
      cash_total: 10,
      card_total: 0,
      on_account_total: 10,
      change_total: 0,
      net_cash_total: 10,
      net_card_total: 0,
      cost: null,
      profit: null,
      cost_unknown: true,
    });
    const cost = items.find((i) => i.label === "تكلفة المبيعات");
    const profit = items.find((i) => i.label === "الربح");
    expect(cost.value).toBe(UNKNOWN_MONEY_AR);
    expect(profit.value).toBe(UNKNOWN_MONEY_AR);
    expect(incompleteProfitNote({ cost_unknown: true })).toBe(INCOMPLETE_PROFIT_AR);
  });

  test("daily print summary shows saved item revenue and invoice rounding", () => {
    const items = buildDailySummaryItems({
      net_sales: 67,
      total_sales: 67,
      item_revenue: 66.9,
      rounding_adjustment: 0.1,
      total_transactions: 2,
      refund_count: 0,
      refunds_total: 0,
      items_sold: 2,
      cash_total: 67,
      card_total: 0,
      on_account_total: 0,
      change_total: 0,
      net_cash_total: 67,
      net_card_total: 0,
    });
    expect(items.find((i) => i.label === "إيراد الأصناف").value).toBe("₪66.90");
    expect(items.find((i) => i.label === "تقريب الفواتير").value).toBe("₪0.10");
    expect(items.find((i) => i.label === "إجمالي المبيعات").value).toBe("₪67.00");
  });

  test("mixed range totals stay unknown and mark incomplete profit", () => {
    const items = buildRangeSummaryItems({
      from: "2026-09-01",
      to: "2026-09-02",
      net_sales: 30,
      total_sales: 30,
      total_transactions: 2,
      refund_count: 0,
      refunds_total: 0,
      items_sold: 3,
      cash_total: 30,
      card_total: 0,
      cost: null,
      profit: null,
      cost_unknown: true,
    });
    expect(items.find((i) => i.label === "تكلفة المبيعات").value).toBe(UNKNOWN_MONEY_AR);
    expect(items.find((i) => i.label === "الربح").value).toBe(UNKNOWN_MONEY_AR);
    expect(incompleteProfitNote({ cost_unknown: false, profit: 8, cost: 2 })).toBeNull();
  });
});
