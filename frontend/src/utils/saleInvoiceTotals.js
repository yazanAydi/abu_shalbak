import {
  applyPurchaseDiscount,
  deriveTotalCost,
  deriveUnitCost,
  formatCostInput,
  formatDiscountPercent,
  formatTaxRatePercent,
  resolvePurchaseTaxRate,
} from "./purchaseTotals";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export { deriveUnitCost as deriveUnitPrice, deriveTotalCost as deriveTotalPrice, formatCostInput as formatPriceInput };

/** Tax-inclusive sale line (shelf price includes VAT). */
export function computeSaleLineTotals(listGross, discountPct, defaultTaxRate, taxInclusive = true) {
  const rate = resolvePurchaseTaxRate(defaultTaxRate);
  const listTotal = round2(Number(listGross) || 0);
  const lineGross = applyPurchaseDiscount(listTotal, discountPct);
  if (!taxInclusive || rate <= 0) {
    return { listTotal, lineGross, lineNet: lineGross, lineTax: 0, lineTotal: lineGross, rate };
  }
  const lineNet = round2(lineGross / (1 + rate));
  const lineTax = round2(lineGross - lineNet);
  return { listTotal, lineGross, lineNet, lineTax, lineTotal: lineGross, rate };
}

export function computeSaleEditorTotals(items, defaultTaxRate, taxInclusive = true) {
  const rate = resolvePurchaseTaxRate(defaultTaxRate);
  let listGrossTotal = 0;
  let grossTotal = 0;
  let subtotal = 0;
  let tax = 0;
  let discountSaved = 0;
  for (const it of items) {
    const { listTotal, lineGross, lineNet, lineTax } = computeSaleLineTotals(
      it.total_price,
      it.discount_pct,
      defaultTaxRate,
      taxInclusive
    );
    listGrossTotal = round2(listGrossTotal + listTotal);
    grossTotal = round2(grossTotal + lineGross);
    subtotal = round2(subtotal + lineNet);
    tax = round2(tax + lineTax);
    discountSaved = round2(discountSaved + (listTotal - lineGross));
  }
  const effectiveDiscountPct = listGrossTotal > 0 ? round2((discountSaved / listGrossTotal) * 100) : 0;
  return { listGrossTotal, grossTotal, subtotal, tax, total: grossTotal, rate, discountSaved, effectiveDiscountPct };
}

export { formatDiscountPercent, formatTaxRatePercent };
