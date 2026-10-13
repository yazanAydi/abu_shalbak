export { round2, roundScaleSaleTotal } from "./money.js";
import { allocateProportionalMoney, round2, sumMoney } from "./money.js";

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

export const PURCHASE_DISCOUNT_RANGE_ERROR = "نسبة الخصم يجب أن تكون بين 0 و 100";
export const PURCHASE_PRICE_REQUIRED_ERROR = "سعر الوحدة مطلوب";
export const PURCHASE_PRICE_INVALID_ERROR = "سعر الوحدة غير صالح";

/**
 * Optional purchase percentage. Blank is zero.
 * Rejects negatives, values above 100, and non-numeric input.
 */
export function parsePurchaseDiscountPercent(raw) {
  if (raw == null || raw === "") return { ok: true, value: 0 };
  if (typeof raw === "boolean" || typeof raw === "object") {
    return { ok: false, error: PURCHASE_DISCOUNT_RANGE_ERROR };
  }
  const text = typeof raw === "number" ? String(raw) : String(raw).trim();
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

/**
 * List cost for one purchase line. An explicit zero is a real price.
 * Omitting both the line total and the unit price is not.
 */
export function resolvePurchaseListCost(it, qty) {
  const hasTotal = !(it?.total_cost == null || it.total_cost === "");
  const hasUnit = !(it?.unit_cost == null || it.unit_cost === "");
  if (!hasTotal && !hasUnit) return { ok: false, error: PURCHASE_PRICE_REQUIRED_ERROR };
  const raw = hasTotal ? Number(it.total_cost) : Number(it.unit_cost) * Number(qty);
  if (!Number.isFinite(raw) || raw < 0) return { ok: false, error: PURCHASE_PRICE_INVALID_ERROR };
  return { ok: true, totalCost: round2(raw) };
}

/** Apply supplier line discount (0–100%) to a pre-discount gross amount. */
export function applyPurchaseDiscount(gross, discountPct) {
  const d = Math.min(100, Math.max(0, Number(discountPct) || 0));
  return round2((Number(gross) || 0) * (1 - d / 100));
}

/**
 * Line percentage first, then one invoice percentage on the sum of line nets.
 * Invoice discount money is allocated across those nets and sums exactly.
 * `payable_total` is the VAT-inclusive amount after both discounts.
 */
export function applyPurchaseDocumentDiscount(lines, invoiceDiscountPct = 0) {
  const pct = Number(invoiceDiscountPct) || 0;
  const prepared = (lines || []).map((line) => {
    const listGross = round2(Number(line.total_cost) || 0);
    const afterLine = applyPurchaseDiscount(listGross, line.discount_pct);
    return { listGross, afterLine };
  });
  const afterLineDiscount = sumMoney(prepared.map((row) => row.afterLine));
  const invoiceDiscountAmount = round2(afterLineDiscount * (pct / 100));
  const shares = allocateProportionalMoney(prepared.map((row) => row.afterLine), invoiceDiscountAmount);
  const detailed = (lines || []).map((line, i) => {
    const listGross = prepared[i].listGross;
    const afterLine = prepared[i].afterLine;
    const share = shares[i] || 0;
    const payable = round2((Math.round(afterLine * 100) - Math.round(share * 100)) / 100);
    return {
      ...line,
      total_cost: listGross,
      line_discount_amount: round2((Math.round(listGross * 100) - Math.round(afterLine * 100)) / 100),
      after_line_discount: afterLine,
      invoice_discount_amount: share,
      payable_total: payable < 0 ? 0 : payable,
    };
  });
  return {
    lines: detailed,
    listGrossTotal: sumMoney(prepared.map((row) => row.listGross)),
    lineDiscountTotal: sumMoney(detailed.map((line) => line.line_discount_amount)),
    afterLineDiscount,
    invoiceDiscountPct: pct,
    invoiceDiscountAmount,
    payableTotal: sumMoney(detailed.map((line) => line.payable_total)),
  };
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
 * total_cost is pre-discount VAT-inclusive. The line percentage, then the
 * invoice percentage, reduce that payable before the VAT split.
 * Inventory cost is a separate posting step and stays on the gross payable.
 *
 * @param {Array<{ total_cost: number, discount_pct?: number, vat_rate?: number }>} lines
 * @param {number} defaultRate store default tax rate (0–1)
 * @param {{ invoiceDiscountPct?: number }} [options]
 */
export function computePurchaseInvoiceTotals(lines, defaultRate = 0, options = {}) {
  const def = Math.max(0, Number(defaultRate) || 0);
  const priced = applyPurchaseDocumentDiscount(lines, options.invoiceDiscountPct || 0);
  let subtotal = 0;
  let vat = 0;
  let grossTotal = 0;
  const detailed = [];

  for (const line of priced.lines) {
    const rate = Number.isFinite(line.vat_rate) ? Math.max(0, line.vat_rate) : def;
    const split = splitInclusivePurchaseVat(line.payable_total, rate);
    const lineNet = split.lineNet;
    const lineVat = split.lineVat;

    subtotal = round2(subtotal + lineNet);
    vat = round2(vat + lineVat);
    grossTotal = round2(grossTotal + line.payable_total);
    detailed.push({
      ...line,
      vat_rate: rate,
      line_net: lineNet,
      line_vat: lineVat,
      line_total: line.payable_total,
    });
  }

  return {
    ...priced,
    subtotal,
    vat,
    total: grossTotal,
    lines: detailed,
  };
}
