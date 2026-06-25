import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { lookupProductByBarcode, normalizeBarcode } from "./barcode";

/**
 * Search products by name or any barcode (including unit barcodes in product_barcodes).
 * @param {string} query
 * @param {{ limit?: number, excludeIds?: number[] }} [opts]
 */
export async function searchProductsApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const limit = opts.limit ?? 20;
  const exclude = new Set((opts.excludeIds ?? []).map(Number));

  const { data } = await api.get("/api/products", {
    params: { search: q },
    headers: getAuthHeaders(),
  });

  let rows = Array.isArray(data) ? data : [];

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
