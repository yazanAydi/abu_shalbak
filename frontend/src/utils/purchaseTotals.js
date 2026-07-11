function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Store default tax rate with backend fallback (0.16). */
export function resolvePurchaseTaxRate(defaultTaxRate) {
  const n = Number(defaultTaxRate);
  return Number.isFinite(n) && n > 0 ? n : 0.16;
}

/** Display rate as whole percent, e.g. 0.16 → "16". */
export function formatTaxRatePercent(rate) {
  return String(Math.round(resolvePurchaseTaxRate(rate) * 100));
}

/** Apply supplier line discount (0–100%) to pre-discount gross. */
export function applyPurchaseDiscount(gross, discountPct) {
  const d = Math.min(100, Math.max(0, Number(discountPct) || 0));
  return round2((Number(gross) || 0) * (1 - d / 100));
}

/** Format a derived cost for input display (2 dp). */
export function formatCostInput(n) {
  if (n === "" || n == null || !Number.isFinite(Number(n))) return "";
  return String(round2(Number(n)));
}

export function deriveUnitCost(totalCost, qty) {
  const q = Number(qty) || 0;
  if (q <= 0 || totalCost === "" || totalCost == null) return "";
  return formatCostInput(Number(totalCost) / q);
}

export function deriveTotalCost(unitCost, qty) {
  const q = Number(qty) || 0;
  if (q <= 0 || unitCost === "" || unitCost == null) return "";
  return formatCostInput(Number(unitCost) * q);
}

function resolveVatRate(vatRateField, defaultTaxRate) {
  if (vatRateField !== "" && vatRateField != null && vatRateField !== undefined) {
    return Math.max(0, Number(vatRateField) / 100);
  }
  return resolvePurchaseTaxRate(defaultTaxRate);
}

/** VAT split on payable gross (after discount); list gross is pre-discount. */
export function computePurchaseLineVat(listGross, discountPct, vatRateField, defaultTaxRate) {
  const rate = resolveVatRate(vatRateField, defaultTaxRate);
  const listTotal = round2(Number(listGross) || 0);
  const lineGross = applyPurchaseDiscount(listTotal, discountPct);
  if (rate <= 0) {
    return { listTotal, lineGross, lineNet: lineGross, lineVat: 0, lineTotal: lineGross, rate };
  }
  const lineVat = round2(lineGross * rate);
  const lineNet = round2(lineGross - lineVat);
  return { listTotal, lineGross, lineNet, lineVat, lineTotal: lineGross, rate };
}

/** Payable line total for non-VAT purchase docs (orders/returns). */
export function computePurchaseLinePayable(listGross, discountPct) {
  const listTotal = round2(Number(listGross) || 0);
  const payable = applyPurchaseDiscount(listTotal, discountPct);
  return { listTotal, payable };
}

/** Format discount % for display (e.g. 8 → "8.00"). */
export function formatDiscountPercent(pct) {
  const n = Number(pct) || 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Aggregate purchase editor lines (matches backend computePurchaseInvoiceTotals). */
export function computePurchaseEditorTotals(items, defaultTaxRate) {
  const rate = resolvePurchaseTaxRate(defaultTaxRate);
  let listGrossTotal = 0;
  let grossTotal = 0;
  let subtotal = 0;
  let vat = 0;
  let discountSaved = 0;
  for (const it of items) {
    const { listTotal, lineGross, lineNet, lineVat } = computePurchaseLineVat(
      it.total_cost,
      it.discount_pct,
      "",
      defaultTaxRate
    );
    listGrossTotal = round2(listGrossTotal + listTotal);
    grossTotal = round2(grossTotal + lineGross);
    subtotal = round2(subtotal + lineNet);
    vat = round2(vat + lineVat);
    discountSaved = round2(discountSaved + (listTotal - lineGross));
  }
  const effectiveDiscountPct = listGrossTotal > 0 ? round2((discountSaved / listGrossTotal) * 100) : 0;
  return { listGrossTotal, grossTotal, subtotal, vat, rate, discountSaved, effectiveDiscountPct };
}

/** Simple total for orders/returns (discounted, no VAT split). */
export function computePurchaseSimpleTotal(items) {
  let listGrossTotal = 0;
  let total = 0;
  let discountSaved = 0;
  for (const it of items) {
    const { listTotal, payable } = computePurchaseLinePayable(it.total_cost, it.discount_pct);
    listGrossTotal = round2(listGrossTotal + listTotal);
    total = round2(total + payable);
    discountSaved = round2(discountSaved + (listTotal - payable));
  }
  const effectiveDiscountPct = listGrossTotal > 0 ? round2((discountSaved / listGrossTotal) * 100) : 0;
  return { listGrossTotal, total, discountSaved, effectiveDiscountPct };
}
