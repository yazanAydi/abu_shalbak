export const UNKNOWN_EXPIRY_LABEL = "غير محدد";
export const PREFERRED_AUTO = "auto";
export const PREFERRED_UNKNOWN = "__unknown__";

export function formatExpiryLabel(expiryDate) {
  return expiryDate || UNKNOWN_EXPIRY_LABEL;
}

export function formatAllocationsAr(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) return "";
  return allocations
    .map((a) => `${formatExpiryLabel(a.expiry_date)} (${Number(a.quantity) || 0})`)
    .join(" · ");
}

export function previewSaleAllocations(batches, quantity, preferred = PREFERRED_AUTO) {
  const need = Number(quantity) || 0;
  if (need <= 0) return [];
  const dated = (batches || [])
    .filter((b) => b.expiry_date && Number(b.quantity) > 0)
    .map((b) => ({ ...b, quantity: Number(b.quantity) || 0 }))
    .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
  const unknown = (batches || []).find((b) => b.virtual || !b.expiry_date);
  let unknownQty = Math.max(0, Number(unknown?.quantity) || 0);
  let remaining = need;
  const out = [];

  const take = (expiry, qty) => {
    const n = Math.min(qty, remaining);
    if (n <= 0) return;
    out.push({ expiry_date: expiry, quantity: n });
    remaining -= n;
  };

  if (preferred === PREFERRED_UNKNOWN) {
    take(null, unknownQty);
    unknownQty -= out[0]?.quantity || 0;
  } else if (preferred && preferred !== PREFERRED_AUTO) {
    const hit = dated.find((b) => b.expiry_date === preferred);
    if (hit) {
      take(hit.expiry_date, hit.quantity);
      hit.quantity -= out[out.length - 1]?.quantity || 0;
    }
  }

  for (const b of dated) {
    if (remaining <= 0) break;
    take(b.expiry_date, b.quantity);
  }
  if (remaining > 0) take(null, unknownQty);
  if (remaining > 0) out.push({ expiry_date: null, quantity: remaining, overflow: true });
  return out;
}
