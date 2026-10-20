import {
  buildShiftCountDetailLines,
  buildShiftCountSummaryModel,
  buildShiftDrawerLines,
  buildShiftVisaPrintModel,
  drawerLineAmount,
  formatSignedMoney,
  parseVisaMachineInput,
  visaExpectedCaption,
  visaReconciliationStatus,
  visaAmountText,
} from "./shiftVisa";

const recorded = {
  visa_sales: 120,
  visa_refunds: 20,
  visa_net: 100,
  visa_incomplete: false,
  visa_note: "مدفوعات فيزا مسجّلة في النظام. ليست تسوية بنكية ولا مطابقة لجهاز البطاقة.",
  visa_labels: {
    sales: "مبيعات فيزا",
    refunds: "مرتجعات الفيزا",
    net: "صافي المبيعات الفيزا",
  },
};

describe("shift visa print model", () => {
  test("prints the recorded visa split with the same amounts", () => {
    const model = buildShiftVisaPrintModel(recorded);
    expect(model.items.map((item) => item.label)).toEqual([
      "مبيعات فيزا",
      "مرتجعات الفيزا",
      "صافي المبيعات الفيزا",
    ]);
    expect(model.items.map((item) => item.amount)).toEqual([120, 20, 100]);
    expect(model.items.map((item) => item.value)).toEqual(["₪120.00", "₪20.00", "₪100.00"]);
    expect(model.note).toBe(recorded.visa_note);
    expect(model.meta.join(" ")).toContain("ليست تسوية بنكية");
    expect(model.meta.join(" ")).toContain("ولا مطابقة لجهاز البطاقة");
    expect(model.incomplete).toBe(false);
  });

  test("flags an incomplete record without changing the recorded amounts", () => {
    const model = buildShiftVisaPrintModel({
      ...recorded,
      visa_sales: 0,
      visa_refunds: 0,
      visa_net: 0,
      visa_incomplete: true,
    });
    expect(model.items.map((item) => item.amount)).toEqual([0, 0, 0]);
    expect(model.incomplete).toBe(true);
    expect(model.meta.join(" ")).toContain("لم يُخمَّن المبلغ الناقص");
    expect(visaAmountText({ visa_net: 0, visa_incomplete: true }, "visa_net")).toBe(
      "₪0.00 (غير مكتمل)"
    );
  });
});

describe("shift count summary model", () => {
  test("shows gross cash, included mixed cash, visa, combined total, and separate refunds", () => {
    const model = buildShiftCountSummaryModel({
      ...recorded,
      cash_sales: 130,
      mixed_cash_sales: 30,
      cash_refunds: 0,
      cash_net: 130,
      tender_total: 250,
      expected_cash: 250,
    });
    expect(model.cashSales.label).toBe("مبيعات نقدية");
    expect(model.cashSales.amount).toBe(130);
    expect(model.mixedIncluded.label).toBe("منها نقد من دفعات مختلطة");
    expect(model.mixedIncluded.amount).toBe(30);
    expect(model.mixedIncludedNote).toBe("مشمول في المبيعات النقدية");
    expect(model.visa.label).toBe("مبيعات فيزا");
    expect(model.visa.amount).toBe(120);
    expect(model.tenderTotal.label).toBe("إجمالي المبيعات النقدية والفيزا");
    expect(model.tenderTotal.amount).toBe(250);
    expect(model.cashRefunds.label).toBe("مرتجعات نقدية");
    expect(model.cashRefunds.amount).toBe(0);
    expect(model.visaRefunds.label).toBe("مرتجعات الفيزا");
    expect(model.visaRefunds.amount).toBe(20);
    expect(model.cashNet.label).toBe("صافي المبيعات النقدية");
    expect(model.cashNet.amount).toBe(130);
    expect(model.visaNet.label).toBe("صافي المبيعات الفيزا");
    expect(model.visaNet.amount).toBe(100);
    expect(model.expected.label).toBe("النقد المتوقع في الصندوق");
    expect(model.expected.amount).toBe(250);
    expect(model.meta.join(" ")).toContain("ليست تسوية بنكية");
    expect(model.meta.join(" ")).toContain("مشمول في المبيعات النقدية");
  });

  test("hides the mixed-cash breakdown when it is zero", () => {
    const model = buildShiftCountSummaryModel({
      cash_sales: 100,
      mixed_cash_sales: 0,
      visa_sales: 50,
      tender_total: 150,
    });
    expect(model.mixedIncluded).toBeNull();
    expect(model.cashSales.amount).toBe(100);
    expect(model.visa.amount).toBe(50);
    expect(model.tenderTotal.amount).toBe(150);
  });

  test("flags incomplete cash sales without inventing a number", () => {
    const model = buildShiftCountSummaryModel({
      cash_sales: 80,
      mixed_cash_sales: 80,
      cash_sales_incomplete: true,
      expected_cash: 80,
      visa_sales: 0,
      visa_refunds: 0,
      visa_net: 0,
    });
    expect(model.cashSales.amount).toBe(80);
    expect(model.cashSales.incomplete).toBe(true);
    expect(model.mixedIncluded.amount).toBe(80);
    expect(model.tenderTotal.amount).toBe(80);
    expect(model.meta.join(" ")).toContain("لم يُخمَّن");
  });
});

describe("shift count presentation", () => {
  test("formats a negative amount with an isolated minus and trailing currency", () => {
    expect(formatSignedMoney(-93)).toBe("\u221293.00 \u20AA");
    expect(formatSignedMoney(117)).toBe("117.00 \u20AA");
    expect(formatSignedMoney(0)).toBe("0.00 \u20AA");
  });

  test("collapses zero refunds and keeps a non-zero visa split", () => {
    const zeros = buildShiftCountSummaryModel({
      cash_sales: 117,
      visa_sales: 2,
      tender_total: 119,
      cash_refunds: 0,
      visa_refunds: 0,
      cash_net: 117,
      visa_net: 2,
    });
    expect(buildShiftCountDetailLines(zeros)).toEqual([]);
    expect(buildShiftCountDetailLines(zeros, { includeZeros: true }).map((line) => [line.key, line.amount])).toEqual([
      ["cashRefunds", 0],
      ["cashNet", 117],
      ["visaRefunds", 0],
      ["visaNet", 2],
    ]);

    const withVisaRefund = buildShiftCountSummaryModel({
      cash_sales: 117,
      visa_sales: 20,
      visa_refunds: 5,
      visa_net: 15,
      cash_refunds: 0,
      cash_net: 117,
    });
    expect(buildShiftCountDetailLines(withVisaRefund).map((line) => line.key)).toEqual([
      "visaRefunds",
      "visaNet",
    ]);
  });

  test("explains the drawer from summary fields without recomputing expected cash", () => {
    const lines = buildShiftDrawerLines({
      opening_cash: 0,
      cash_sales: 117,
      visa_sales: 2,
      tender_total: 119,
      cash_refunds: 0,
      supplier_payments_total: 210,
      advances_total: 0,
      customer_collections_total: 0,
      customer_cash_debts_total: 0,
      mixed_cash_sales: 30,
      expected_cash: -93,
    });
    expect(lines.map((line) => line.key)).toEqual(["opening", "cashSales", "supplierPayments"]);
    expect(lines.find((line) => line.key === "opening")).toMatchObject({ amount: 0, unavailable: false });
    expect(drawerLineAmount(lines.find((line) => line.key === "cashSales"))).toBe(117);
    expect(drawerLineAmount(lines.find((line) => line.key === "supplierPayments"))).toBe(-210);
    expect(lines.some((line) => String(line.label).includes("فيزا"))).toBe(false);
    expect(lines.some((line) => line.key === "expected")).toBe(false);
    expect(lines.some((line) => line.label === "منها نقد من دفعات مختلطة")).toBe(false);
  });

  test("groups other inflows and outflows under their own labels", () => {
    const lines = buildShiftDrawerLines({
      opening_cash: 50,
      cash_sales: 20,
      customer_collections_total: 15,
      cash_refunds: 4,
      advances_total: 8,
      customer_cash_debts_total: 3,
      adjustments_total: -2,
      expected_cash: 68,
    });
    expect(lines.map((line) => [line.key, line.label, drawerLineAmount(line)])).toEqual([
      ["opening", "رصيد بداية الوردية", 50],
      ["cashSales", "المبيعات النقدية", 20],
      ["collections", "قبض ذمم سابق", 15],
      ["cashRefunds", "المرتجعات النقدية", -4],
      ["advances", "المصروفات والسلف", -8],
      ["cashDebts", "ذمم نقدية للعملاء", -3],
      ["adjustment", "تسوية نقدية", -2],
    ]);
  });

  test("does not treat a missing opening balance as zero", () => {
    const lines = buildShiftDrawerLines({ cash_sales: 10, expected_cash: 10 });
    expect(lines.find((line) => line.key === "opening")).toMatchObject({
      unavailable: true,
      amount: null,
    });
  });
});

describe("visa machine reconciliation status", () => {
  test("blank, zero, negative, match, shortage, and surplus", () => {
    expect(parseVisaMachineInput("")).toEqual({ empty: true });
    expect(parseVisaMachineInput("  ")).toEqual({ empty: true });
    expect(parseVisaMachineInput("0")).toEqual({ value: 0 });
    expect(parseVisaMachineInput("-5")).toEqual({ value: -5 });
    expect(parseVisaMachineInput("abc").error).toBe(true);
    expect(visaReconciliationStatus({ saved: false, difference: 0 })).toMatchObject({
      state: "awaiting",
      label: "بانتظار المطابقة",
      matched: false,
    });
    expect(visaReconciliationStatus({ saved: false, incomplete: true }).label).toBe("بانتظار المطابقة");
    expect(visaReconciliationStatus({ saved: true, difference: 0 })).toMatchObject({
      state: "matched",
      label: "مطابق",
    });
    expect(visaReconciliationStatus({ saved: true, difference: -5 }).label).toBe("ناقص 5");
    expect(visaReconciliationStatus({ saved: true, difference: 5 }).label).toBe("زائد 5");
    expect(visaExpectedCaption(true)).toBe("صافي معروف");
    expect(visaExpectedCaption(false)).toBe("صافي الفيزا المتوقع");
  });
});
