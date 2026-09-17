import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { lookupProductByBarcode, normalizeBarcode } from "./barcode";

/**
 * @param {string} query
 * @param {{ limit?: number, excludeIds?: number[] }} [opts]
 */
export async function searchProductsApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const limit = opts.limit ?? 20;
  const exclude = new Set((opts.excludeIds ?? []).map(Number));

  const { data } = await api.get("/api/pos/search", {
    params: { q },
    headers: getAuthHeaders(),
    signal: opts.signal,
  });

  let rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

  if (rows.length === 0 && /^\d+$/.test(normalizeBarcode(q))) {
    try {
      const hit = await lookupProductByBarcode(q);
      if (hit) rows = [hit];
    } catch {
      /* not found */
    }
  }

  if (exclude.size) {
    rows = rows.filter((p) => !exclude.has(Number(p.id)));
  }

  return rows.slice(0, limit);
}
