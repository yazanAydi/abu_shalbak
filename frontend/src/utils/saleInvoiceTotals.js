import {
  applyPurchaseDiscount,
  deriveTotalCost,
  deriveUnitCost,
  formatCostInput,
  formatDiscountPercent,
  formatTaxRatePercent,
} from "./purchaseTotals";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export { deriveUnitCost as deriveUnitPrice, deriveTotalCost as deriveTotalPrice, formatCostInput as formatPriceInput };

/** Sale line: shelf price is the full amount (no VAT split). */
export function computeSaleLineTotals(listGross, discountPct, _defaultTaxRate, _taxInclusive = true) {
  const rate = 0;
  const listTotal = round2(Number(listGross) || 0);
  const lineGross = applyPurchaseDiscount(listTotal, discountPct);
  return { listTotal, lineGross, lineNet: lineGross, lineTax: 0, lineTotal: lineGross, rate };
}

export function computeSaleEditorTotals(items, _defaultTaxRate, _taxInclusive = true) {
  const rate = 0;
  let listGrossTotal = 0;
  let grossTotal = 0;
  let subtotal = 0;
  let tax = 0;
  let discountSaved = 0;
  for (const it of items) {
    const { listTotal, lineGross, lineNet, lineTax } = computeSaleLineTotals(
      it.total_price,
      it.discount_pct
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
