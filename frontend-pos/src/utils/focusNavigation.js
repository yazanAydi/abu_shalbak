const SKIP_INPUT_TYPES = new Set(["hidden", "file", "button", "submit", "reset"]);

function isVisible(el) {
  if (!el || el.disabled) return false;
  if (el.tabIndex === -1) return false;
  if (el.readOnly) return false;
  if (el.closest("[hidden], [aria-hidden='true']")) return false;
  const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
  if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  return true;
}

export function isNavigableField(el) {
  if (!isVisible(el)) return false;
  if (el.closest("[data-enter-nav-skip]")) return false;
  if (el.closest(".ui-modal__footer")) return false;
  if (el.closest(".pos-payment-modal-actions, .shift-modal-actions")) return false;

  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    if (SKIP_INPUT_TYPES.has(type)) return false;
    if (type === "checkbox" || type === "radio") return false;
    return true;
  }
  return false;
}

function isComboboxOpen(el) {
  if (el.getAttribute?.("role") === "combobox" && el.getAttribute("aria-expanded") === "true") {
    return true;
  }
  const combobox = el.closest(".ui-combobox");
  if (!combobox) return false;
  return combobox.getAttribute("aria-expanded") === "true" || Boolean(combobox.querySelector(".ui-combobox__list"));
}

function isPickerDropdownOpen(el) {
  const root = el.closest(
    ".party-picker, .barcode-input-row, .ui-search, .invoice-product-cell, .invoice-batch-cell"
  );
  if (!root) return false;
  return Boolean(root.querySelector(".search-dropdown, .invoice-product-cell__list"));
}

/** Resolve the navigation boundary for a focused field. */
export function getNavRoot(el) {
  if (!el?.closest) return null;

  const explicit = el.closest("[data-enter-nav]");
  if (explicit) {
    const mode = explicit.getAttribute("data-enter-nav");
    if (mode === "off") return null;
    return explicit;
  }

  const form = el.closest("form");
  if (form && form.getAttribute("data-enter-nav") !== "off") {
    return form;
  }

  return el.closest(".ui-modal__body");
}

/** Ordered list of navigable fields inside a root container. */
export function getFocusableFields(root) {
  if (!root) return [];
  return [...root.querySelectorAll("input, select, textarea")].filter(isNavigableField);
}

function isComposingEvent(e) {
  return Boolean(e.isComposing || e.keyCode === 229);
}

/** Whether Enter should move focus instead of its default action. */
export function shouldHandleEnterOnField(el, e) {
  if (!isNavigableField(el)) return false;
  if (el.tagName === "TEXTAREA") return false;
  if (isComboboxOpen(el)) return false;
  if (isPickerDropdownOpen(el)) return false;
  if (e && isComposingEvent(e)) return false;
  return true;
}

function focusField(el) {
  if (!el) return false;
  el.focus();
  if (typeof el.select === "function" && el.tagName === "INPUT" && el.type !== "date") {
    try {
      el.select();
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Focus the next or previous field in the nav root. */
export function focusAdjacentField(currentEl, direction = 1) {
  const root = getNavRoot(currentEl);
  if (!root) return false;

  const fields = getFocusableFields(root);
  const idx = fields.indexOf(currentEl);
  const nextIdx = idx + direction;
  if (idx < 0 || nextIdx < 0 || nextIdx >= fields.length) return false;
  return focusField(fields[nextIdx]);
}

/** Focus the next field in the nav root; returns false when already on the last field. */
export function focusNextField(currentEl) {
  return focusAdjacentField(currentEl, 1);
}

export function focusPrevField(currentEl) {
  return focusAdjacentField(currentEl, -1);
}

export function isLastNavigableField(currentEl) {
  const root = getNavRoot(currentEl);
  if (!root) return false;
  const fields = getFocusableFields(root);
  return fields.length > 0 && fields[fields.length - 1] === currentEl;
}

/** Container-level keydown handler (event delegation). */
export function handleEnterNavKeyDown(e) {
  if (e.key !== "Enter" || e.defaultPrevented) return false;
  if (isComposingEvent(e)) return false;
  if (!shouldHandleEnterOnField(e.target, e)) return false;

  const backward = Boolean(e.shiftKey);
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;
  if (backward) focusPrevField(e.target);
  else focusNextField(e.target);
  return true;
}
