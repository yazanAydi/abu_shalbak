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
    return functionKeyFromEvent(ev) === keyPart.toLowerCase();
  }
  return ev.key.toLowerCase() === keyPart.toLowerCase();
}

/** F9 and the other function keys, including when key is empty and only keyCode is set. */
export function functionKeyFromEvent(ev) {
  const key = String(ev?.key || "");
  if (/^f\d+$/i.test(key)) return key.toLowerCase();
  const code = String(ev?.code || "");
  if (/^f\d+$/i.test(code)) return code.toLowerCase();
  const which = Number(ev?.keyCode || ev?.which || 0);
  if (which >= 112 && which <= 123) return `f${which - 111}`;
  return "";
}

/**
 * Global POS shortcuts should not fire while typing in normal inputs.
 * Function keys (F9 and the rest) always work, including from the scanner,
 * quantity, and weight fields.
 */
export function shouldHandlePosShortcut(ev) {
  const el = ev.target;
  if (!el || typeof el.closest !== "function") return true;
  if (functionKeyFromEvent(ev)) return true;
  if (el.closest(".barcode-input")) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (el.isContentEditable) return false;
  return true;
}
