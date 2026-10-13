const KEY = "abu-purchase-return-prefill";

export function storePurchaseReturnPrefill(payload) {
  sessionStorage.setItem(KEY, JSON.stringify(payload));
}

export function readPurchaseReturnPrefill() {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.supplierId || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPurchaseReturnPrefill() {
  sessionStorage.removeItem(KEY);
}
