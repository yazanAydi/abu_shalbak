export { round2 } from "./money.js";
import { round2 } from "./money.js";

/**
 * Resolve per-product tax rate (0–1).
 * Falls back to store default when product has no override.
 */
export function productTaxRate(product, settings) {
  const r = product?.tax_rate;
  if (r !== undefined && r !== null) {
    const n = Number(r);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return settings.default_tax_rate;
}

/**
 * Compute sale totals from line items.
 *
 * tax_inclusive = true  (Hesabate default / "السعر شامل الضريبة"):
 *   The shelf price already includes VAT.
 *   net  = gross / (1 + rate)
 *   tax  = gross - net
 *
 * tax_inclusive = false:
 *   Tax is added on top of the net price.
 *   tax  = net * rate
 *   total = net + tax
 *
 * @param {Array<{ quantity: number, unitPrice: number, taxRate: number }>} lines
 * @param {{ tax_inclusive: boolean }} settings
 */
export function computeSaleTotals(lines, settings) {
  let subtotal = 0;
  let tax = 0;
  const detailed = [];

  for (const line of lines) {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const unitPrice = round2(Number(line.unitPrice) || 0);
    const rate = Math.max(0, Number(line.taxRate) || 0);

    let lineNet, lineTax, lineGross;

    if (settings.tax_inclusive && rate > 0) {
      lineGross = round2(qty * unitPrice);
      lineNet = round2(lineGross / (1 + rate));
      lineTax = round2(lineGross - lineNet);
    } else {
      lineNet = round2(qty * unitPrice);
      lineTax = round2(lineNet * rate);
      lineGross = round2(lineNet + lineTax);
    }

    subtotal = round2(subtotal + lineNet);
    tax = round2(tax + lineTax);
    detailed.push({ quantity: qty, unitPrice, taxRate: rate, lineNet, lineTax, lineGross });
  }

  return { subtotal, tax, total: round2(subtotal + tax), lines: detailed };
}
