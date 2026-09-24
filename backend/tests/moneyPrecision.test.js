import { allocatePosRefundPayable, round2, roundPosPayable, sumMoney, roundScaleSaleTotal } from "../utils/money.js";
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

  test("sales do not split VAT — shelf price is the full total", () => {
    const r = computeSaleTotals(
      [{ quantity: 1, unitPrice: 100, taxRate: 0.16 }],
      { tax_inclusive: true, default_tax_rate: 0.16 }
    );
    expect(r.subtotal).toBe(100);
    expect(r.tax).toBe(0);
    expect(r.total).toBe(100);
  });

  test("line subtotal for qty × fractional price is 2-dp exact", () => {
    const r = computeSaleTotals(
      [{ quantity: 3, unitPrice: 3.33, taxRate: 0 }],
      { tax_inclusive: false, default_tax_rate: 0 }
    );
    expect(r.subtotal).toBe(9.99);
  });

  test("purchase invoice supplier total 50 includes 16% VAT as 43.10 + 6.90", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 50, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_total).toBe(50);
    expect(r.lines[0].line_net).toBe(43.1);
    expect(r.lines[0].line_vat).toBe(6.9);
    expect(r.total).toBe(50);
  });

  test("purchase invoice 10% discount on 50 gross at 16% inclusive VAT", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 50, discount_pct: 10, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_total).toBe(45);
    expect(r.lines[0].line_net).toBe(38.79);
    expect(r.lines[0].line_vat).toBe(6.21);
    expect(r.total).toBe(45);
  });

  test("purchase invoice gross 116 at 16% → net 100, VAT 16, payable 116", () => {
    const r = computePurchaseInvoiceTotals([{ total_cost: 116, vat_rate: 0.16 }], 0.16);
    expect(r.lines[0].line_net).toBe(100);
    expect(r.lines[0].line_vat).toBe(16);
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

  test("weighed KG line 0.93 × 6 charges 6 while qty stays 0.93", () => {
    const r = computeSaleTotals(
      [{ quantity: 0.93, unitPrice: 6, scaleWeighed: true }],
      { tax_inclusive: false }
    );
    expect(r.lines[0].unitPrice).toBe(6);
    expect(r.lines[0].quantity).toBeCloseTo(0.93, 3);
    expect(r.lines[0].lineGross).toBe(6);
    expect(r.total).toBe(6);
  });

  test("non-weighed lines keep round2", () => {
    const r = computeSaleTotals(
      [{ quantity: 1, unitPrice: 12.5, scaleWeighed: false }],
      { tax_inclusive: false }
    );
    expect(r.total).toBe(12.5);
  });

  test("final POS payable keeps .50 and rounds other agorot remainders", () => {
    const cases = [
      [21.3, 21.3, 21, -0.3],
      [45.6, 45.6, 46, 0.4],
      [2.5, 2.5, 2.5, 0],
      [2.49, 2.49, 2, -0.49],
      [2.51, 2.51, 3, 0.49],
      [2, 2, 2, 0],
      [2.0, 2, 2, 0],
      [2.01, 2.01, 2, -0.01],
      [2.99, 2.99, 3, 0.01],
      [0.49, 0.49, 0, -0.49],
      [0.5, 0.5, 0.5, 0],
      [0.51, 0.51, 1, 0.49],
    ];
    for (const [raw, calculated, payable, adjustment] of cases) {
      expect(roundPosPayable(raw)).toEqual({ calculated, payable, adjustment });
    }
  });

  test("line totals are not passed through the final payable rule", () => {
    const r = computeSaleTotals([{ quantity: 1, unitPrice: 2.3, scaleWeighed: false }], {});
    expect(r.total).toBe(2.3);
    expect(roundPosPayable(r.total).payable).toBe(2);
  });

  test("partial refunds share the stored adjustment and the last one takes the remainder", () => {
    const first = allocatePosRefundPayable({
      merchandise: 10.3,
      saleMerchandise: 20.6,
      saleAdjustment: 0.4,
      salePayable: 21,
      alreadyRefunded: 0,
      exhaustsSale: false,
    });
    expect(first.payable).toBe(10.5);
    expect(first.payable).not.toBe(roundPosPayable(10.3).payable);
    const last = allocatePosRefundPayable({
      merchandise: 10.3,
      saleMerchandise: 20.6,
      saleAdjustment: 0.4,
      salePayable: 21,
      alreadyRefunded: first.payable,
      exhaustsSale: true,
    });
    expect(last.payable).toBe(10.5);
    expect(round2(first.payable + last.payable)).toBe(21);
  });
});
