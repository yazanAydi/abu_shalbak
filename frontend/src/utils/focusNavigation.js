const SKIP_INPUT_TYPES = new Set(["hidden", "file", "button", "submit", "reset"]);

function isNavigableField(el) {
  if (!el || el.disabled) return false;
  if (el.tabIndex === -1) return false;
  if (el.closest("[data-enter-nav-skip]")) return false;
  if (el.closest(".ui-modal__footer")) return false;

  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    if (SKIP_INPUT_TYPES.has(type)) return false;
    return true;
  }
  return false;
}

function isComboboxOpen(el) {
  const combobox = el.closest(".ui-combobox");
  if (!combobox) return false;
  return Boolean(combobox.querySelector(".ui-combobox__list"));
}

function isPickerDropdownOpen(el) {
  const root = el.closest(".party-picker, .barcode-input-row, .ui-search");
  if (!root) return false;
  return Boolean(root.querySelector(".search-dropdown"));
}

/** Resolve the navigation boundary for a focused field. */
export function getNavRoot(el) {
  if (!el?.closest) return null;

  const explicit = el.closest("[data-enter-nav]");
  if (explicit && explicit.getAttribute("data-enter-nav") !== "off") {
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

/** Whether Enter should move focus instead of its default action. */
export function shouldHandleEnterOnField(el) {
  if (!isNavigableField(el)) return false;
  if (el.tagName === "TEXTAREA") return false;
  if (isComboboxOpen(el)) return false;
  if (isPickerDropdownOpen(el)) return false;
  return true;
}

/** Focus the next field in the nav root; returns false when already on the last field. */
export function focusNextField(currentEl) {
  const root = getNavRoot(currentEl);
  if (!root) return false;

  const fields = getFocusableFields(root);
  const idx = fields.indexOf(currentEl);
  if (idx < 0 || idx >= fields.length - 1) return false;

  fields[idx + 1].focus();
  return true;
}

/** Container-level keydown handler (event delegation). */
export function handleEnterNavKeyDown(e) {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  if (!shouldHandleEnterOnField(e.target)) return;

  e.preventDefault();
  focusNextField(e.target);
}
