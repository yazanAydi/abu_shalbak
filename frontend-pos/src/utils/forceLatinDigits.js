/** Convert Eastern Arabic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to ASCII 0-9. */
export function toLatinDigits(str) {
  return String(str)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
  const prev = el.value;
  if (prev == null || prev === "") return;
  const next = toLatinDigits(prev);
  if (next === prev) return;
  try {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = next;
    if (typeof start === "number" && typeof end === "number") {
      el.setSelectionRange(start, end);
    }
  } catch {
    el.value = next;
  }
}

document.addEventListener("input", onInput, true);
