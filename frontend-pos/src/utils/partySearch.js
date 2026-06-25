import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";

/** @param {string | null | undefined} notes */
export function customerPartyBadge(notes) {
  const n = String(notes || "");
  if (n.includes("مشغل")) return "مشغل";
  if (n.includes("عمارة")) return "عمارة";
  return "زبون";
}

/**
 * Search customers and suppliers for voucher party picker.
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
export async function searchPartiesApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const limit = opts.limit ?? 30;
  const enc = encodeURIComponent(q);

  const [custRes, supRes] = await Promise.all([
    api.get(`/api/customers?q=${enc}`, { headers: getAuthHeaders() }),
    api.get(`/api/suppliers?q=${enc}`, { headers: getAuthHeaders() }),
  ]);

  const customers = (Array.isArray(custRes.data) ? custRes.data : []).map((c) => ({
    type: "customer",
    id: c.id,
    name: c.name,
    code: c.customer_code || null,
    badge: customerPartyBadge(c.notes),
  }));

  const suppliers = (Array.isArray(supRes.data) ? supRes.data : []).map((s) => ({
    type: "supplier",
    id: s.id,
    name: s.name,
    code: s.supplier_code || null,
    badge: "مورد",
  }));

  return [...customers, ...suppliers].slice(0, limit);
}

/** @param {{ lines?: { customer_name?: string, supplier_name?: string }[] } | null } voucher */
export function voucherPartyName(voucher) {
  const first = voucher?.lines?.[0];
  return first?.customer_name || first?.supplier_name || null;
}
