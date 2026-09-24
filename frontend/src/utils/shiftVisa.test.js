import {
  buildShiftCountSummaryModel,
  buildShiftVisaPrintModel,
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
