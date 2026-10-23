const QTY_TOLERANCE = 0.0001;

export function heldCartMatches(cartItems, heldItems) {
  const cart = cartItems || [];
  const held = heldItems || [];
  if (cart.length !== held.length || held.length === 0) return false;
  const remaining = new Map();
  for (const item of held) {
    const key = `${item.product_id}-${item.product_unit_id}`;
    remaining.set(key, Number(item.quantity));
  }
  for (const row of cart) {
    const key = `${row.id}-${row.unitId}`;
    if (!remaining.has(key)) return false;
    if (Math.abs(remaining.get(key) - Number(row.quantity)) > QTY_TOLERANCE) return false;
    remaining.delete(key);
  }
  return remaining.size === 0;
}

export function heldQuoteFromDetail(detail) {
  if (!detail?.items) return null;
  const verified = detail.quote_verified === true || Number(detail.quote_verified) === 1;
  return {
    items: detail.items,
    quote_verified: verified,
    saved_discount: Number(detail.saved_discount ?? detail.discount) || 0,
    saved_payable: Number(detail.saved_payable ?? detail.payable) || 0,
    saved_rounding: Number(detail.saved_rounding_adjustment ?? detail.rounding_adjustment) || 0,
    current_discount: Number(detail.current_discount ?? detail.discount) || 0,
    current_payable: Number(detail.current_payable ?? detail.payable) || 0,
    current_rounding: Number(detail.current_rounding_adjustment ?? detail.rounding_adjustment) || 0,
  };
}

/**
 * Unchanged restored cart shows the amount checkout will charge.
 * An unverified quote shows the current offer, not the saved one, and stays
 * unpaid until the cashier accepts that amount.
 * Returns null when the cart no longer matches the hold, so the live estimate is used.
 */
export function resolveHeldDisplay(quote) {
  if (!quote) return null;
  if (!quote.quote_verified) {
    return {
      discount: quote.current_discount,
      total: quote.current_payable,
      roundingAdjustment: quote.current_rounding,
      needsConfirmation: true,
      savedDiscount: quote.saved_discount,
      savedPayable: quote.saved_payable,
    };
  }
  return {
    discount: quote.saved_discount,
    total: quote.saved_payable,
    roundingAdjustment: quote.saved_rounding,
    needsConfirmation: false,
    savedDiscount: quote.saved_discount,
    savedPayable: quote.saved_payable,
  };
}
