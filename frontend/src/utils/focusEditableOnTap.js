/** Keep touch focus in the user's click, rather than an effect or animation frame. */
export function focusEditableOnTap(event) {
  if (event.defaultPrevented) return;
  const input = event.target?.closest?.("input, textarea");
  if (!input || input.disabled || input.readOnly) return;
  if (input.tagName === "INPUT" && !["text", "search", "number", "tel", "email", "password", "url"].includes(input.type)) return;
  input.focus();
  // Optional enhancement; browsers without this API use native input focus.
  try {
    const result = navigator.virtualKeyboard?.show?.();
    result?.catch?.(() => {});
  } catch {
    // Keyboard availability remains controlled by the phone/browser.
  }
}
