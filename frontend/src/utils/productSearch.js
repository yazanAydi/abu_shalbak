import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { lookupProductByBarcode, normalizeBarcode } from "./barcode";

/**
 * Search products by name or any barcode (including unit barcodes in product_barcodes).
 * @param {string} query
 * @param {{ limit?: number, excludeIds?: number[], scope?: 'retail' | 'bakery', membership?: string, kind?: string }} [opts]
 */
export async function searchProductsApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const limit = opts.limit ?? 20;
  const exclude = new Set((opts.excludeIds ?? []).map(Number));
  const params = { search: q, limit };
  if (opts.scope) params.scope = opts.scope;
  if (opts.membership) params.membership = opts.membership;
  if (opts.kind) params.kind = opts.kind;

  const { data } = await api.get("/api/products", {
    params,
    headers: getAuthHeaders(),
    signal: opts.signal,
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

/**
 * Posted purchase unit price for a supplier/product/unit as of a return date.
 */
export async function fetchSupplierPurchaseUnitPrice({
  supplierId,
  productId,
  unitId,
  asOf,
  invoiceId,
  signal,
} = {}) {
  const params = { supplier_id: supplierId, product_id: productId };
  if (unitId) params.unit_id = unitId;
  if (asOf) params.as_of = asOf;
  if (invoiceId) params.invoice_id = invoiceId;
  const { data } = await api.get("/api/purchases/supplier-unit-price", {
    params,
    headers: getAuthHeaders(),
    signal,
  });
  return data ?? null;
}

export function supplierPurchasePriceHint(source) {
  if (!source?.invoice_date) return "";
  const inv = source.invoice_no != null && source.invoice_no !== "" ? ` — #${source.invoice_no}` : "";
  return `آخر شراء: ${source.invoice_date}${inv}`;
}
