import { computePurchaseEditorTotals, computePurchaseLineVat } from "./purchaseTotals";

describe("inclusive purchase VAT", () => {
  test("116 at 16% splits to net 100 and VAT 16", () => {
    const line = computePurchaseLineVat(116, 0, "", 0.16);
    expect(line.lineNet).toBe(100);
    expect(line.lineVat).toBe(16);
    expect(line.lineTotal).toBe(116);
  });

  test("zero VAT keeps the gross payable", () => {
    const line = computePurchaseLineVat(50, 0, "0", 0.16);
    expect(line.lineNet).toBe(50);
    expect(line.lineVat).toBe(0);
    expect(line.lineTotal).toBe(50);
  });

  test("discount and rounding leave net plus VAT equal to the payable", () => {
    const totals = computePurchaseEditorTotals(
      [
        { total_cost: 50, discount_pct: 10 },
        { total_cost: 10, discount_pct: 0 },
      ],
      0.16
    );
    expect(totals.grossTotal).toBe(55);
    expect(Math.round((totals.subtotal + totals.vat) * 100) / 100).toBe(55);
    expect(totals.vat).toBe(7.59);
  });
});
