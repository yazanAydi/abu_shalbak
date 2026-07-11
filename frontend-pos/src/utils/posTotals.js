import { computeCartDiscount } from "./promotions.js";

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function productTaxRate(product, settings) {
  const r = product?.tax_rate;
  if (r !== undefined && r !== null) {
    const n = Number(r);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return settings?.default_tax_rate ?? 0;
}

function cartPromoKey(productId, unitId) {
  return `${productId}-${unitId ?? "0"}`;
}

export function cartItemPromoKey(item) {
  const productId = item.id ?? item.product_id;
  const unitId = item.unitId ?? item.unit_id ?? item.product_unit_id ?? "0";
  return cartPromoKey(productId, unitId);
}

function buildPromoLines(cartItems) {
  return cartItems.map((it) => ({
    product_id: it.id ?? it.product_id,
    product_unit_id: it.unitId ?? it.unit_id ?? it.product_unit_id,
    category: it.category,
    quantity: it.quantity,
    unitPrice: it.price,
  }));
}

/**
 * Map cart line keys to promotion discount amounts for display.
 * @returns {Record<string, number>}
 */
export function buildCartLineDiscounts(cartItems, promos) {
  const map = {};
  if (!Array.isArray(promos) || !promos.length || !Array.isArray(cartItems) || !cartItems.length) {
    return map;
  }
  const { breakdown } = computeCartDiscount(promos, buildPromoLines(cartItems));
  for (const entry of breakdown) {
    const key = cartPromoKey(entry.product_id, entry.product_unit_id);
    map[key] = round2((map[key] || 0) + (Number(entry.discount) || 0));
  }
  return map;
}

/**
 * Deal-adjusted line total for cart display (e.g. 2 for ₪15 shows ₪15, not shelf gross).
 */
export function computeDealLineTotal(cartItem, promos) {
  const lineGross = round2(Number(cartItem.subtotal) || Number(cartItem.price) * Number(cartItem.quantity));
  if (!Array.isArray(promos) || !promos.length) return lineGross;

  const lines = buildPromoLines([cartItem]);
  const { breakdown } = computeCartDiscount(promos, lines);
  const lineDiscount = breakdown.reduce(
    (sum, entry) => round2(sum + (Number(entry.discount) || 0)),
    0
  );
  return round2(Math.max(0, lineGross - lineDiscount));
}

/**
 * @param {Array<{ quantity: number, price: number, tax_rate?: number | null, id?: number, product_id?: number, category?: string }>} cartItems
 * @param {{ tax_inclusive: boolean, default_tax_rate: number }} settings
 * @param {Array} [promos] optional active promotions to show an estimated discount
 */
export function estimateCartTotals(cartItems, settings, promos) {
  if (!settings || !cartItems.length) {
    return { subtotal: 0, tax: 0, discount: 0, total: 0 };
  }
  const lines = cartItems.map((it) => ({
    quantity: it.quantity,
    unitPrice: it.price,
    taxRate: productTaxRate(it, settings),
  }));

  let subtotal = 0;
  let tax = 0;

  for (const line of lines) {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const unitPrice = round2(Number(line.unitPrice) || 0);
    const rate = Math.max(0, Number(line.taxRate) || 0);

    if (settings.tax_inclusive && rate > 0) {
      const lineGross = round2(qty * unitPrice);
      const lineNet = round2(lineGross / (1 + rate));
      const lineTax = round2(lineGross - lineNet);
      subtotal = round2(subtotal + lineNet);
      tax = round2(tax + lineTax);
    } else {
      const lineNet = round2(qty * unitPrice);
      const lineTax = round2(lineNet * rate);
      subtotal = round2(subtotal + lineNet);
      tax = round2(tax + lineTax);
    }
  }

  const gross = round2(subtotal + tax);
  let discount = 0;
  if (Array.isArray(promos) && promos.length) {
    discount = Math.min(computeCartDiscount(promos, buildPromoLines(cartItems)).discount, gross);
  }
  return { subtotal, tax, discount, total: round2(gross - discount) };
}
