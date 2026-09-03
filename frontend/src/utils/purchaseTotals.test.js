import {
  deriveEffectiveUnitCost,
  deriveUnitCost,
  lineHasPurchaseDiscount,
  purchaseQtyStepForUnit,
} from "./purchaseTotals";

describe("purchase display helpers", () => {
  test("unit_cost stays pre-discount; effective unit cost uses payable", () => {
    expect(deriveUnitCost(100, 10)).toBe("10");
    expect(deriveEffectiveUnitCost(90, 10)).toBe("9");
  });

  test("mixed-unit discounted example: 10 حبة, ₪90 payable", () => {
    expect(deriveEffectiveUnitCost(90, 10)).toBe("9");
    expect(lineHasPurchaseDiscount(10)).toBe(true);
    expect(lineHasPurchaseDiscount(0)).toBe(false);
  });

  test("quantity step is fractional only for كغم", () => {
    expect(purchaseQtyStepForUnit({ unit_name: "كغم" })).toBe("any");
    expect(purchaseQtyStepForUnit({ unit_name: "حبة" })).toBe("1");
    expect(purchaseQtyStepForUnit({ unit_name: "كرتونة" })).toBe("1");
    expect(purchaseQtyStepForUnit(null)).toBe("1");
  });
});
