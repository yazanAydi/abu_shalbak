/** Return focus to the POS barcode scan field (for scanner workflow after cart edits). */
export function focusBarcodeInput() {
  const el = document.querySelector(".barcode-input");
  el?.focus({ preventScroll: true });
}
