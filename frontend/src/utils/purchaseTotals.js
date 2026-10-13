function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function sumMoney(values) {
  let total = 0;
  for (const v of values) total = round2(total + Number(v || 0));
  return total;
}

/** Same agorot allocation as backend/utils/money.js allocateProportionalMoney. */
export function allocateProportionalMoney(weights, amount) {
  const list = Array.isArray(weights) ? weights : [];
  const total = round2(amount);
  const agorot = Math.round(total * 100);
  if (list.length === 0) return [];
  if (!(agorot > 0)) return list.map(() => 0);
  const weightAgorot = list.map((w) => {
    const n = round2(w);
    return n > 0 ? Math.round(n * 100) : 0;
  });
  const weightSum = weightAgorot.reduce((sum, n) => sum + n, 0);
  if (!(weightSum > 0)) return list.map(() => 0);
  const capped = Math.min(agorot, weightSum);
  const raw = weightAgorot.map((w) => (capped * w) / weightSum);
  const floors = raw.map((x) => Math.floor(x + 1e-8));
  let remainder = capped - floors.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    floors[order[cursor % order.length].i] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return floors.map((n) => round2(n / 100));
}

export const PURCHASE_DISCOUNT_RANGE_ERROR = "نسبة الخصم يجب أن تكون بين 0 و 100";

/** Blank is zero. Rejects negatives, values above 100, and non-numeric text. */
export function parsePurchaseDiscountPercent(raw) {
  if (raw == null || raw === "") return { ok: true, value: 0 };
  const text = String(raw).trim();
  if (text === "") return { ok: true, value: 0 };
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return { ok: false, error: PURCHASE_DISCOUNT_RANGE_ERROR };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ok: false, error: PURCHASE_DISCOUNT_RANGE_ERROR };
  }
  return { ok: true, value: n };
}

export function purchaseDiscountError(raw) {
  const parsed = parsePurchaseDiscountPercent(raw);
  return parsed.ok ? null : parsed.error;
}

/** Store default tax rate with backend fallback (0.16). */
export function resolvePurchaseTaxRate(defaultTaxRate) {
  const n = Number(defaultTaxRate);
  return Number.isFinite(n) && n >= 0 ? n : 0.16;
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

/**
 * Line percentage, then invoice percentage on the sum of line nets.
 * Mirrors backend applyPurchaseDocumentDiscount.
 */
export function applyPurchaseDocumentDiscount(items, invoiceDiscountPct = 0) {
  const parsed = parsePurchaseDiscountPercent(invoiceDiscountPct);
  const pct = parsed.ok ? parsed.value : 0;
  const prepared = (items || []).map((it) => {
    const listGross = round2(Number(it.total_cost) || 0);
    const afterLine = applyPurchaseDiscount(listGross, it.discount_pct);
    return { listGross, afterLine };
  });
  const afterLineDiscount = sumMoney(prepared.map((row) => row.afterLine));
  const invoiceDiscountAmount = round2(afterLineDiscount * (pct / 100));
  const shares = allocateProportionalMoney(prepared.map((row) => row.afterLine), invoiceDiscountAmount);
  const lines = (items || []).map((it, i) => {
    const listGross = prepared[i].listGross;
    const afterLine = prepared[i].afterLine;
    const share = shares[i] || 0;
    const payable = round2((Math.round(afterLine * 100) - Math.round(share * 100)) / 100);
    return {
      ...it,
      listGross,
      lineDiscountAmount: round2((Math.round(listGross * 100) - Math.round(afterLine * 100)) / 100),
      afterLineDiscount: afterLine,
      invoiceDiscountAmount: share,
      payable: payable < 0 ? 0 : payable,
    };
  });
  return {
    lines,
    listGrossTotal: sumMoney(prepared.map((row) => row.listGross)),
    lineDiscountTotal: sumMoney(lines.map((line) => line.lineDiscountAmount)),
    afterLineDiscount,
    invoiceDiscountPct: pct,
    invoiceDiscountAmount,
    invoiceDiscountError: parsed.ok ? null : parsed.error,
    payableTotal: sumMoney(lines.map((line) => line.payable)),
  };
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

/**
 * Effective (post-discount) cost per entered purchase unit.
 * `unit_cost` stays pre-discount list cost; this is display-only.
 */
export function deriveEffectiveUnitCost(payableTotal, qty) {
  const q = Number(qty) || 0;
  if (q <= 0 || payableTotal === "" || payableTotal == null) return "";
  return formatCostInput(Number(payableTotal) / q);
}

/** كغم purchase qty may be fractional; other units use integer step in the UI. */
export function purchaseQtyStepForUnit(unit) {
  const name = String(unit?.unit_name || "");
  return name === "كغم" ? "any" : "1";
}

export function lineHasPurchaseDiscount(discountPct) {
  return (Number(discountPct) || 0) > 0;
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
  const lineNet = round2(lineGross / (1 + rate));
  const lineVat = round2(lineGross - lineNet);
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

function vatOnPayable(payable, defaultTaxRate) {
  const rate = resolvePurchaseTaxRate(defaultTaxRate);
  const gross = round2(Number(payable) || 0);
  if (rate <= 0) return { lineNet: gross, lineVat: 0, rate };
  const lineNet = round2(gross / (1 + rate));
  const lineVat = round2(gross - lineNet);
  return { lineNet, lineVat, rate };
}

/** Aggregate purchase editor lines (matches backend computePurchaseInvoiceTotals). */
export function computePurchaseEditorTotals(items, defaultTaxRate, invoiceDiscountPct = 0) {
  const priced = applyPurchaseDocumentDiscount(items, invoiceDiscountPct);
  let subtotal = 0;
  let vat = 0;
  let rate = resolvePurchaseTaxRate(defaultTaxRate);
  const lines = priced.lines.map((line) => {
    const split = vatOnPayable(line.payable, defaultTaxRate);
    rate = split.rate;
    subtotal = round2(subtotal + split.lineNet);
    vat = round2(vat + split.lineVat);
    return line;
  });
  const effectiveDiscountPct = priced.listGrossTotal > 0
    ? round2((priced.lineDiscountTotal / priced.listGrossTotal) * 100)
    : 0;
  return {
    listGrossTotal: priced.listGrossTotal,
    grossTotal: priced.payableTotal,
    subtotal,
    vat,
    rate,
    discountSaved: priced.lineDiscountTotal,
    lineDiscountTotal: priced.lineDiscountTotal,
    afterLineDiscount: priced.afterLineDiscount,
    invoiceDiscountPct: priced.invoiceDiscountPct,
    invoiceDiscountAmount: priced.invoiceDiscountAmount,
    invoiceDiscountError: priced.invoiceDiscountError,
    effectiveDiscountPct,
    lines,
  };
}

/** Simple total for orders/returns (discounted, no VAT split). */
export function computePurchaseSimpleTotal(items, invoiceDiscountPct = 0) {
  const priced = applyPurchaseDocumentDiscount(items, invoiceDiscountPct);
  const effectiveDiscountPct = priced.listGrossTotal > 0
    ? round2((priced.lineDiscountTotal / priced.listGrossTotal) * 100)
    : 0;
  return {
    listGrossTotal: priced.listGrossTotal,
    total: priced.payableTotal,
    discountSaved: priced.lineDiscountTotal,
    lineDiscountTotal: priced.lineDiscountTotal,
    afterLineDiscount: priced.afterLineDiscount,
    invoiceDiscountPct: priced.invoiceDiscountPct,
    invoiceDiscountAmount: priced.invoiceDiscountAmount,
    invoiceDiscountError: priced.invoiceDiscountError,
    effectiveDiscountPct,
    lines: priced.lines,
  };
}

/** Posted/draft document summary from stored money, without recomputing old rows. */
export function summarizeStoredPurchaseDocument(doc) {
  const items = doc?.items || [];
  const listGrossTotal = sumMoney(items.map((it) => Number(it.total_cost) || 0));
  const invoiceDiscountAmount = doc?.invoice_discount_amount != null && doc.invoice_discount_amount !== ""
    ? round2(doc.invoice_discount_amount)
    : sumMoney(items.map((it) => Number(it.invoice_discount_amount) || 0));
  const total = round2(doc?.total ?? doc?.total_amount ?? 0);
  const afterLineDiscount = round2(total + invoiceDiscountAmount);
  const lineDiscountTotal = round2(listGrossTotal - afterLineDiscount);
  return {
    listGrossTotal,
    lineDiscountTotal: lineDiscountTotal > 0 ? lineDiscountTotal : 0,
    afterLineDiscount,
    invoiceDiscountPct: Number(doc?.discount_pct) || 0,
    invoiceDiscountAmount,
    total,
  };
}
