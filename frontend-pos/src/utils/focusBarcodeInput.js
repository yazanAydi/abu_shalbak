const DIALOG_SELECTOR = "[role='dialog'], .shift-modal-overlay, .pos-modal";
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "option",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='option']",
  "[role='tab']",
  "[role='listbox']",
  "[role='dialog']",
  ".search-dropdown",
].join(", ");

let barcodeInputEl = null;

/** Checkout scan field. BarcodeInput registers its ref so we do not hunt the DOM. */
export function registerBarcodeInput(el) {
  barcodeInputEl = el || null;
}

function barcodeInput() {
  if (barcodeInputEl?.isConnected) return barcodeInputEl;
  return document.querySelector(".barcode-input");
}

export function checkoutDialogOpen() {
  return Boolean(document.querySelector(DIALOG_SELECTOR));
}

function isCartEditField(active) {
  if (!active?.closest) return false;
  return Boolean(
    active.classList?.contains("pos-qty-input") ||
      active.closest(".pos-qty-controls, .pos-unit-select")
  );
}

/**
 * True when focus should stay put.
 * releaseCartEdit: a finished cart action may leave the qty/weight field.
 */
export function shouldKeepCurrentFocus(active, { releaseCartEdit = false } = {}) {
  if (checkoutDialogOpen()) return true;
  if (!active || active === document.body || active === document.documentElement) return false;
  if (active.classList?.contains("barcode-input")) return false;
  if (active.closest?.(".search-dropdown")) return true;
  if (isCartEditField(active)) return !releaseCartEdit;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

/** Return focus to the POS scan field, unless a dialog or another editor needs it. */
export function focusBarcodeInput(options) {
  if (shouldKeepCurrentFocus(document.activeElement, options)) return false;
  const input = barcodeInput();
  if (!input) return false;
  input.focus({ preventScroll: true });
  return true;
}

/** Clicking blank cart, quick-button, or page space should arm the scanner again. */
export function isBarcodeFocusSurface(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest(DIALOG_SELECTOR)) return false;
  if (target.closest(INTERACTIVE_SELECTOR)) return false;
  return Boolean(target.closest(".pos-cart-panel, .pos-quick-panel, .pos-screen"));
}
