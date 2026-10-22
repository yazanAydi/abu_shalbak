import { useEffect, useRef } from "react";
import { focusBarcodeInput } from "./focusBarcodeInput";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function isFocusable(el) {
  if (!el || el.disabled) return false;
  if (el.closest("[aria-hidden='true']")) return false;
  if (el.tabIndex < 0 && el.getAttribute("tabindex") === "-1") return false;
  return true;
}

export function listDialogFocusables(dialog) {
  if (!dialog) return [];
  return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isFocusable);
}

/** Prefer the party search field so the cashier can type as soon as the dialog opens. */
export function focusDialogField(dialog) {
  if (!dialog) return false;
  const combo = dialog.querySelector("input[role='combobox']:not([disabled])");
  const field =
    combo ||
    dialog.querySelector("input:not([disabled]):not([type='hidden']), textarea:not([disabled])");
  const target = field || listDialogFocusables(dialog)[0];
  if (!target || typeof target.focus !== "function") return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target || dialog.contains(document.activeElement);
}

function isOpenComboboxTarget(target) {
  const combo = target?.closest?.("[role='combobox']") || target;
  return combo?.getAttribute?.("role") === "combobox" && combo.getAttribute("aria-expanded") === "true";
}

function trapTab(event, dialog) {
  const items = listDialogFocusables(dialog);
  if (!items.length) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const active = document.activeElement;
  const inside = dialog.contains(active);
  const first = items[0];
  const last = items[items.length - 1];
  if (!inside) {
    event.preventDefault();
    event.stopPropagation();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    event.stopPropagation();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    event.stopPropagation();
    first.focus();
  }
}

/**
 * Capture-phase handler. Keys aimed at the register behind the dialog are
 * swallowed so a scan cannot add a sale while the dialog is up.
 */
export function handlePosDialogKeyDown(event, dialog, { allowDismiss = true, onDismiss } = {}) {
  if (!dialog || !event) return;
  if (event.key === "Tab") {
    trapTab(event, dialog);
    return;
  }
  if (event.key === "Escape") {
    if (isOpenComboboxTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (allowDismiss) onDismiss?.();
    return;
  }
  if (!dialog.contains(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    focusDialogField(dialog);
  }
}

function inertBackground(dialog) {
  const screen = dialog.closest(".pos-screen");
  if (!screen) return [];
  const touched = [];
  for (const child of screen.children) {
    if (child === dialog || child.contains(dialog)) continue;
    touched.push([child, !!child.inert]);
    child.inert = true;
  }
  return touched;
}

/**
 * Keep keyboard input inside a POS dialog and hand the scanner back on close.
 * @param {object} args
 * @param {boolean} args.active
 * @param {import("react").RefObject<HTMLElement|null>} args.dialogRef
 * @param {string|number} [args.focusToken] retarget the first field when this changes (tab switch)
 * @param {boolean} [args.allowDismiss]
 * @param {() => void} [args.onDismiss]
 */
export function usePosDialogKeyboard({
  active,
  dialogRef,
  focusToken = "default",
  allowDismiss = true,
  onDismiss,
}) {
  const onDismissRef = useRef(onDismiss);
  const allowDismissRef = useRef(allowDismiss);
  onDismissRef.current = onDismiss;
  allowDismissRef.current = allowDismiss;

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const touched = inertBackground(dialog);
    function onKey(event) {
      handlePosDialogKeyDown(event, dialog, {
        allowDismiss: allowDismissRef.current,
        onDismiss: () => onDismissRef.current?.(),
      });
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const [child, prev] of touched) child.inert = prev;
      focusBarcodeInput();
    };
  }, [active, dialogRef]);

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    focusDialogField(dialog);
    return undefined;
  }, [active, dialogRef, focusToken]);
}
