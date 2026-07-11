import { round2, sumMoney } from "../utils/money.js";
import { computeSaleTotals, computePurchaseInvoiceTotals, applyPurchaseDiscount } from "../utils/tax.js";

/**
 * Stage 5 — money precision. Documents and locks in the rounding behavior the
 * rest of the system relies on. See docs/MONEY_PRECISION_REPORT.md.
 */
describe("Money precision", () => {
  test("classic float artifact 0.1 + 0.2 rounds to 0.3", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  test("sumMoney rounds the running total each step", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([0.1, 0.1, 0.1])).toBe(0.3);
    expect(sumMoney([9.99, 9.99, 9.99])).toBe(29.97);
  });

  test("repeated fractional quantities accumulate without drift", () => {
    const lines = [
      { quantity: 1, unitPrice: 0.1, taxRate: 0 },
      { quantity: 1, unitPrice: 0.1, taxRate: 0 },
      { quantity: 1, unitPrice: 0.1, taxRate: 0 },
    ];
    const r = computeSaleTotals(lines, { tax_inclusive: false, default_tax_rate: 0 });
    expect(r.subtotal).toBe(0.3);
    expect(r.total).toBe(0.3);
  });

  test("tax-exclusive 16% adds tax on top of net", () => {
    const r = computeSaleTotals(
      [{ quantity: 1, unitPrice: 100, taxRate: 0.16 }],
      { tax_inclusive: false, default_tax_rate: 0.16 }
    );
    expect(r.subtotal).toBe(100);
    expect(r.tax).toBe(16);
    expect(r.total).toBe(116);
  });

  test("tax-inclusive price decomposes into net + tax", () => {
    const r = computeSaleTotals(
      [{ quantity: 1, unitPrice: 116, taxRate: 0.16 }],
      { tax_inclusive: true, default_tax_rate: 0.16 }
    );
    expect(r.subtotal).toBe(100);
    expect(r.tax).toBe(16);
    expect(r.total).toBe(116);
  });

  test("line subtotal for qty × fractional price is 2-dp exact", () => {
    const r = computeSaleTotals(
      [{ quantity: 3, unitPrice: 3.33, taxRate: 0 }],
      { tax_inclusive: false, default_tax_rate: 0 }
    );
    expect(r.subtotal).toBe(9.99);
  });

  test("purchase invoice supplier total 50 → net 42, VAT 8 at 16%", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 50, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_total).toBe(50);
    expect(r.lines[0].line_vat).toBe(8);
    expect(r.lines[0].line_net).toBe(42);
    expect(r.total).toBe(50);
  });

  test("purchase invoice 10% discount on 50 gross at 16% VAT", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 50, discount_pct: 10, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_total).toBe(45);
    expect(r.lines[0].line_vat).toBe(7.2);
    expect(r.lines[0].line_net).toBe(37.8);
    expect(r.total).toBe(45);
  });

  test("purchase invoice gross 116 at 16% → net 97.44, VAT 18.56", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 116, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_vat).toBe(18.56);
    expect(r.lines[0].line_net).toBe(97.44);
    expect(r.lines[0].line_total).toBe(116);
    expect(r.total).toBe(116);
  });

  test("applyPurchaseDiscount reduces gross by percentage", () => {
    expect(applyPurchaseDiscount(50, 10)).toBe(45);
    expect(applyPurchaseDiscount(100, 0)).toBe(100);
  });

  test("purchase invoice zero VAT rate keeps gross as total", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 50, vat_rate: 0 }], 0.17);
    expect(r.lines[0].line_net).toBe(50);
    expect(r.lines[0].line_vat).toBe(0);
    expect(r.total).toBe(50);
  });
});
