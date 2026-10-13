import {
  applyPurchaseDocumentDiscount,
  computePurchaseEditorTotals,
  computePurchaseLineVat,
  computePurchaseSimpleTotal,
  parsePurchaseDiscountPercent,
} from "./purchaseTotals";

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

  test("example A applies a 5% invoice discount after the 10% line discount", () => {
    const priced = applyPurchaseDocumentDiscount(
      [{ total_cost: 100, discount_pct: 10, quantity: 1 }],
      5
    );
    expect(priced.lines[0].afterLineDiscount).toBe(90);
    expect(priced.invoiceDiscountAmount).toBe(4.5);
    expect(priced.payableTotal).toBe(85.5);
  });

  test("example B allocates the invoice discount 9 and 4", () => {
    const priced = applyPurchaseDocumentDiscount(
      [
        { total_cost: 100, discount_pct: 10, quantity: 2 },
        { total_cost: 50, discount_pct: 20, quantity: 1 },
      ],
      10
    );
    expect(priced.lines.map((line) => line.afterLineDiscount)).toEqual([90, 40]);
    expect(priced.afterLineDiscount).toBe(130);
    expect(priced.invoiceDiscountAmount).toBe(13);
    expect(priced.lines.map((line) => line.invoiceDiscountAmount)).toEqual([9, 4]);
    expect(priced.payableTotal).toBe(117);
    expect(priced.lines[0].payable / 2).toBe(40.5);
    expect(priced.lines[1].payable).toBe(36);
  });

  test("blank, zero, and 100 percent discounts stay finite", () => {
    expect(parsePurchaseDiscountPercent("").value).toBe(0);
    expect(parsePurchaseDiscountPercent("0").value).toBe(0);
    expect(parsePurchaseDiscountPercent("100").ok).toBe(true);
    expect(parsePurchaseDiscountPercent("10.5").value).toBe(10.5);
    expect(parsePurchaseDiscountPercent("-1").ok).toBe(false);
    expect(parsePurchaseDiscountPercent("101").ok).toBe(false);
    expect(parsePurchaseDiscountPercent("abc").ok).toBe(false);
    const full = computePurchaseSimpleTotal([{ total_cost: 80, discount_pct: 100 }], 100);
    expect(full.total).toBe(0);
    expect(full.invoiceDiscountAmount).toBe(0);
  });

  test("invoice discount is applied before inclusive VAT", () => {
    const totals = computePurchaseEditorTotals(
      [{ total_cost: 100, discount_pct: 10 }],
      0.16,
      10
    );
    expect(totals.grossTotal).toBe(81);
    expect(Math.round((totals.subtotal + totals.vat) * 100) / 100).toBe(81);
  });
});
