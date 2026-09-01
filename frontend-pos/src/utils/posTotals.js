import { computeCartDiscount } from "./promotions.js";
import { isKgSoldUnit } from "./cartProduct.js";

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Same two-step whole-shekel half-up as backend roundScaleSaleTotal. */
export function roundScaleSaleTotal(amount) {
  const n = round2(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n + 0.5);
}

function isKgCartLine(item) {
  if (!item) return false;
  if (isKgSoldUnit(item)) return true;
  const units = item.availableUnits || [];
  const selected =
    units.find((u) => Number(u.id) === Number(item.unitId ?? item.unit_id)) || null;
  return isKgSoldUnit(selected) || Boolean(item.weighed);
}

export function productTaxRate(_product, _settings) {
  return 0;
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
  const raw = round2(Number(cartItem.subtotal) || Number(cartItem.price) * Number(cartItem.quantity));
  const lineGross = isKgCartLine(cartItem) ? roundScaleSaleTotal(raw) : raw;
  if (!Array.isArray(promos) || !promos.length) return lineGross;

  const lines = buildPromoLines([cartItem]);
  const { breakdown } = computeCartDiscount(promos, lines);
  const lineDiscount = breakdown.reduce(
    (sum, entry) => round2(sum + (Number(entry.discount) || 0)),
    0
  );
  const afterPromo = round2(Math.max(0, lineGross - lineDiscount));
  return isKgCartLine(cartItem) ? roundScaleSaleTotal(afterPromo) : afterPromo;
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
  let subtotal = 0;

  for (const it of cartItems) {
    const qty = Math.max(0, Number(it.quantity) || 0);
    const unitPrice = round2(Number(it.price) || 0);
    const raw = round2(qty * unitPrice);
    subtotal = round2(subtotal + (isKgCartLine(it) ? roundScaleSaleTotal(raw) : raw));
  }

  const tax = 0;
  const gross = subtotal;
  let discount = 0;
  if (Array.isArray(promos) && promos.length) {
    discount = Math.min(computeCartDiscount(promos, buildPromoLines(cartItems)).discount, gross);
  }
  return { subtotal, tax, discount, total: round2(gross - discount) };
}
