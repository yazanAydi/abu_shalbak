export { round2, roundScaleSaleTotal } from "./money.js";
import { round2 } from "./money.js";

/**
 * Sales VAT is not split: buy and sell prices already include tax.
 * Store default / product override are ignored (kept for purchase invoices).
 */
export function productTaxRate(_product, _settings) {
  return 0;
}

/**
 * Compute sale totals from line items.
 * Tax rate is always 0: shelf price is the full amount (net = gross, tax = 0).
 * Weighed KG lines keep round2(quantity × price). Whole-shekel rounding is not applied here.
 *
 * @param {Array<{ quantity: number, unitPrice: number, taxRate?: number, scaleWeighed?: boolean }>} lines
 * @param {{ tax_inclusive?: boolean }} [_settings]
 */
export function computeSaleTotals(lines, _settings) {
  let subtotal = 0;
  const detailed = [];

  for (const line of lines) {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const unitPrice = round2(Number(line.unitPrice) || 0);
    const lineNet = round2(qty * unitPrice);
    const lineTax = 0;
    const lineGross = lineNet;

    subtotal = round2(subtotal + lineNet);
    detailed.push({ quantity: qty, unitPrice, taxRate: 0, lineNet, lineTax, lineGross });
  }

  return { subtotal, tax: 0, total: subtotal, lines: detailed };
}

/** Apply supplier line discount (0–100%) to a pre-discount gross amount. */
export function applyPurchaseDiscount(gross, discountPct) {
  const d = Math.min(100, Math.max(0, Number(discountPct) || 0));
  return round2((Number(gross) || 0) * (1 - d / 100));
}

/**
 * Split one tax-inclusive purchase amount.
 * Net is rounded to agorot first; VAT is the remainder so net + VAT = gross.
 * Posted invoices keep the split stored on their lines. This does not rewrite them.
 *
 * @param {number} gross
 * @param {number} rate
 */
export function splitInclusivePurchaseVat(gross, rate) {
  const payable = round2(Number(gross) || 0);
  const r = Math.max(0, Number(rate) || 0);
  if (!(r > 0) || payable === 0) return { lineNet: payable, lineVat: 0 };
  const lineNet = round2(payable / (1 + r));
  const lineVat = round2(payable - lineNet);
  return { lineNet, lineVat };
}

/**
 * Compute purchase invoice totals from line items.
 * total_cost is pre-discount VAT-inclusive; discount_pct reduces payable before VAT split.
 * Inventory cost is a separate posting step and stays on the gross payable.
 *
 * @param {Array<{ total_cost: number, discount_pct?: number, vat_rate?: number }>} lines
 * @param {number} defaultRate store default tax rate (0–1)
 */
export function computePurchaseInvoiceTotals(lines, defaultRate = 0) {
  const def = Math.max(0, Number(defaultRate) || 0);
  let subtotal = 0;
  let vat = 0;
  let grossTotal = 0;
  const detailed = [];

  for (const line of lines) {
    const rate = Number.isFinite(line.vat_rate) ? Math.max(0, line.vat_rate) : def;
    const lineGross = applyPurchaseDiscount(line.total_cost, line.discount_pct);
    const split = splitInclusivePurchaseVat(lineGross, rate);
    const lineNet = split.lineNet;
    const lineVat = split.lineVat;

    subtotal = round2(subtotal + lineNet);
    vat = round2(vat + lineVat);
    grossTotal = round2(grossTotal + lineGross);
    detailed.push({
      ...line,
      vat_rate: rate,
      line_net: lineNet,
      line_vat: lineVat,
      line_total: lineGross,
    });
  }

  return { subtotal, vat, total: grossTotal, lines: detailed };
}
