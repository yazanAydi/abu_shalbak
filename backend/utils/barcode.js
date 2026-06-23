/**
 * Normalize scanner / manual input (trim, strip invisible chars, Arabic digits → Latin).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeBarcodeInput(raw) {
  if (raw == null) return "";
  let t = String(raw).trim();
  t = t.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  t = t.replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
  t = t.replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
  return t;
}

/**
 * Possible DB keys to try for numeric barcodes (leading zeros, EAN-13 vs UPC).
 * @param {string} key
 * @returns {string[]}
 */
/** Digits only — for matching ": 2100002" vs scanned "2100002" */
export function digitsOnly(s) {
  return String(s ?? "").replace(/\D/g, "");
}

export function barcodeLookupKeys(key) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  push(key);
  if (!/^\d+$/.test(key)) return out;

  const stripped = key.replace(/^0+/, "") || "0";
  push(stripped);

  if (key.length === 12) push("0" + key);
  if (key.length === 13 && key.startsWith("0")) push(key.slice(1));

  const d = digitsOnly(key);
  if (d.length >= 4 && d.length <= 14 && d !== key) push(d);

  return out;
}
