import {
  round2,
  roundScaleSaleTotal,
  computeDealLineTotal,
  estimateCartTotals,
} from "./posTotals";

describe("POS scale sale rounding", () => {
  test("roundScaleSaleTotal half-up to whole shekels", () => {
    const cases = [
      [5.1, 5],
      [5.4, 5],
      [5.49, 5],
      [5.5, 6],
      [5.51, 6],
      [5.6, 6],
      [6.49, 6],
      [6.5, 7],
      [6.9, 7],
    ];
    for (const [raw, expected] of cases) {
      expect(roundScaleSaleTotal(raw)).toBe(expected);
    }
  });

  test("KG cart line 0.93 × 6 displays 6", () => {
    const item = {
      unitName: "كغم",
      weighed: true,
      quantity: 0.93,
      price: 6,
    };
    expect(computeDealLineTotal(item, [])).toBe(6);
  });

  test("package line keeps agorot", () => {
    const item = {
      unitName: "حبة",
      weighed: false,
      quantity: 1,
      price: 12.5,
    };
    expect(computeDealLineTotal(item, [])).toBe(12.5);
  });

  test("cart total sums rounded KG lines", () => {
    const totals = estimateCartTotals(
      [
        { unitName: "كغم", weighed: true, quantity: 0.93, price: 6 },
        { unitName: "حبة", weighed: false, quantity: 1, price: 12 },
      ],
      { tax_inclusive: true, default_tax_rate: 0 }
    );
    expect(totals.subtotal).toBe(18);
    expect(totals.total).toBe(18);
  });

  test("round2 is unchanged", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
