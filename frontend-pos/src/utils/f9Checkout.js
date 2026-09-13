/**
 * One-press F9: post a default cash sale. Other methods still use the payment modal.
 */

export function isHeldKeyRepeat(ev) {
  return Boolean(ev?.repeat);
}

export function resolveF9CheckoutAction({
  repeat,
  cartCount,
  shiftReady,
  isLoading,
  isSubmitting,
  payModalOpen,
}) {
  if (repeat) return { action: "ignore-repeat" };
  if (payModalOpen) return { action: "defer-to-modal" };
  if (!cartCount || !shiftReady || isLoading || isSubmitting) return { action: "ignore" };
  return { action: "cash-checkout" };
}

export function onePressCashPayload() {
  return { payment_method: "cash" };
}
