import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { lookupProductByBarcode, normalizeBarcode } from "./barcode";

/**
 * Search products by name or any barcode (including unit barcodes in product_barcodes).
 * @param {string} query
 * @param {{ limit?: number, excludeIds?: number[], scope?: 'retail' | 'bakery' }} [opts]
 */
export async function searchProductsApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const limit = opts.limit ?? 20;
  const exclude = new Set((opts.excludeIds ?? []).map(Number));
  const params = { search: q };
  if (opts.scope) params.scope = opts.scope;

  const { data } = await api.get("/api/products", {
    params,
    headers: getAuthHeaders(),
  });

  let rows = Array.isArray(data?.data ?? data) ? (data?.data ?? data) : [];

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

/**
 * Latest posted purchase cost + current sell price for purchase invoice prefill.
 * @param {number} productId
 * @returns {Promise<{ product_id: number, sell_price: number, min_price: number|null, max_price: number|null, last_purchase: { unit_cost: number, product_unit_id: number|null, unit_name: string|null, invoice_date: string|null }|null }|null>}
 */
export async function fetchLastPurchaseCost(productId) {
  try {
    const { data } = await api.get(`/api/products/${productId}/last-purchase-cost`, {
      headers: getAuthHeaders(),
    });
    return data ?? null;
  } catch {
    return null;
  }
}
