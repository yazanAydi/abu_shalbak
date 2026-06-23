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

/**
 * @param {Array<{ quantity: number, price: number, tax_rate?: number | null, product_id?: number, category?: string }>} cartItems
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
    const promoLines = cartItems.map((it) => ({
      product_id: it.product_id,
      category: it.category,
      quantity: it.quantity,
      unitPrice: it.price,
    }));
    discount = Math.min(computeCartDiscount(promos, promoLines).discount, gross);
  }
  return { subtotal, tax, discount, total: round2(gross - discount) };
}
