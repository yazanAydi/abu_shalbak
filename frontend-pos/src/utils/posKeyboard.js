/**
 * @param {KeyboardEvent} ev
 * @param {string} shortcutKey e.g. "F2", "Ctrl+Y", "Ctrl+Backspace"
 */
export function matchesShortcut(ev, shortcutKey) {
  const parts = String(shortcutKey).split("+").map((p) => p.trim());
  const needsCtrl = parts.some((p) => p.toLowerCase() === "ctrl");
  const needsShift = parts.some((p) => p.toLowerCase() === "shift");
  const needsAlt = parts.some((p) => p.toLowerCase() === "alt");
  const keyPart = parts.find(
    (p) => !["ctrl", "shift", "alt"].includes(p.toLowerCase())
  );
  if (!keyPart) return false;

  if (!!ev.ctrlKey !== needsCtrl) return false;
  if (!!ev.shiftKey !== needsShift) return false;
  if (!!ev.altKey !== needsAlt) return false;

  if (/^f\d+$/i.test(keyPart)) {
    return ev.key.toLowerCase() === keyPart.toLowerCase();
  }
  return ev.key.toLowerCase() === keyPart.toLowerCase();
}

/**
 * Global POS shortcuts should not fire while typing in normal inputs.
 * Barcode scanner input is excluded so F-keys still work after scanning.
 */
export function shouldHandlePosShortcut(ev) {
  const el = ev.target;
  if (!el || typeof el.closest !== "function") return true;
  if (el.closest(".barcode-input")) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (el.isContentEditable) return false;
  return true;
}
