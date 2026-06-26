/**
 * Scan action history stack for undo-last-scan (F2).
 * Only ADD_PRODUCT pushes entries; manual cart edits do not.
 */

export function createScanHistoryEntry(cartKey, previousQty, wasNewRow) {
  return { cartKey, previousQty, wasNewRow };
}

export function pushScanHistory(stack, entry) {
  return [...stack, entry];
}

export function popScanHistory(stack) {
  if (!stack.length) return { stack, entry: null };
  const entry = stack[stack.length - 1];
  return { stack: stack.slice(0, -1), entry };
}

/**
 * Apply undo for the last scan entry against cart items.
 * @param {Array} cartItems
 * @param {{ cartKey: string, previousQty: number, wasNewRow: boolean }} entry
 * @returns {Array|null} updated cart or null if entry invalid
 */
export function applyUndoScan(cartItems, entry, cartKeyFor) {
  if (!entry) return null;
  const idx = cartItems.findIndex((x) => cartKeyFor(x) === entry.cartKey);
  if (idx < 0) return null;

  if (entry.wasNewRow) {
    return cartItems.filter((_, i) => i !== idx);
  }

  const next = [...cartItems];
  const row = { ...next[idx] };
  const newQty = entry.previousQty;
  if (newQty <= 0) {
    return cartItems.filter((_, i) => i !== idx);
  }
  row.quantity = newQty;
  row.subtotal = newQty * row.price;
  next[idx] = row;
  return next;
}
