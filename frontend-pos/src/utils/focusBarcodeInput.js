function shouldKeepCurrentFocus(active) {
  if (!active || active === document.body || active === document.documentElement) return false;
  if (active.classList?.contains("barcode-input")) return false;
  if (active.closest?.(".pos-modal, .pos-modal-backdrop, [role='dialog']")) return true;
  if (active.classList?.contains("pos-qty-input") || active.closest?.(".pos-qty-input")) return true;
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

/** Return focus to the POS scan field, unless a dialog or another field already has it. */
export function focusBarcodeInput() {
  if (shouldKeepCurrentFocus(document.activeElement)) return;
  document.querySelector(".barcode-input")?.focus({ preventScroll: true });
}
