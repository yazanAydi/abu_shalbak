/**
 * Cart F9 opens the payment modal (same as إتمام البيع).
 * Modal F9 / ترحيل validates and submits. Do not post cash here.
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
  return { action: "open-modal" };
}
