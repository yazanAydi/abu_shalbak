import { cartKeyFor } from "./cartProduct";

export function cartItemsToSuspendPayload(cartItems) {
  return (cartItems || []).map((c) => ({
    product_id: c.id,
    unit_id: c.unitId,
    quantity: c.quantity,
    price: c.price,
    ...(c.scanned_barcode ? { scanned_barcode: c.scanned_barcode } : {}),
  }));
}

/**
 * @param {Array} items from suspended sale API detail
 * @param {Record<number, { stock?: number, availableUnits?: Array }>} [liveMeta] keyed by product_id
 */
export function suspendedItemsToCartItems(items, liveMeta = {}) {
  return (items || []).map((it) => {
    const productId = it.product_id;
    const unitId = it.product_unit_id;
    const live = liveMeta[productId] || {};
    const availableUnits = live.availableUnits || [
      {
        id: unitId,
        unit_name: it.unit_name_snapshot,
        barcode: it.barcode_snapshot,
        price: it.unit_price_snapshot,
        conversion_to_base: it.conversion_to_base,
      },
    ];
    const qty = Number(it.quantity) || 1;
    const price = Number(it.unit_price_snapshot);
    return {
      cartKey: `${productId}-${unitId}`,
      id: productId,
      unitId,
      unitName: it.unit_name_snapshot,
      barcode: it.barcode_snapshot,
      scanned_barcode: it.scanned_barcode_snapshot || null,
      name: it.product_name_snapshot,
      price,
      conversionToBase: Number(it.conversion_to_base) || 1,
      availableUnits,
      stock: Number(live.stock) || 0,
      tax_rate: it.tax_rate_snapshot,
      quantity: qty,
      subtotal: qty * price,
    };
  });
}

export function mergeCartItemsByKey(existing, incoming) {
  const merged = [...(existing || [])];
  for (const row of incoming || []) {
    const key = cartKeyFor(row);
    const idx = merged.findIndex((x) => cartKeyFor(x) === key);
    if (idx >= 0) {
      const target = { ...merged[idx] };
      target.quantity += row.quantity;
      target.subtotal = target.quantity * target.price;
      merged[idx] = target;
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}
