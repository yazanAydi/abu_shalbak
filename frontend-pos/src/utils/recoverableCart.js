const KEY_PREFIX = "pos.recoverableCart.v1.";

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(userId) {
  return `${KEY_PREFIX}${Number(userId)}`;
}

export function writeRecoverableCart({
  userId,
  shiftId = null,
  cartItems = [],
  idempotencyKey = null,
  submittedPayload = null,
  suspendedSaleId = null,
}) {
  const store = storage();
  const id = Number(userId);
  if (!store || !id) return;
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    store.removeItem(keyFor(id));
    return;
  }
  store.setItem(
    keyFor(id),
    JSON.stringify({
      userId: id,
      shiftId: shiftId == null ? null : Number(shiftId),
      cartItems,
      idempotencyKey: idempotencyKey || null,
      submittedPayload: submittedPayload || null,
      suspendedSaleId: suspendedSaleId == null ? null : Number(suspendedSaleId),
    })
  );
}

export function readRecoverableCart(userId) {
  const store = storage();
  const id = Number(userId);
  if (!store || !id) return null;
  try {
    const parsed = JSON.parse(store.getItem(keyFor(id)) || "null");
    if (!parsed || Number(parsed.userId) !== id) return null;
    if (!Array.isArray(parsed.cartItems) || !parsed.cartItems.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRecoverableCart(userId) {
  const store = storage();
  const id = Number(userId);
  if (!store || !id) return;
  store.removeItem(keyFor(id));
}
