/**
 * Display entity code as a plain integer when it is digits.
 * Strips leading zeros in text — never Number(), which turns long values into 1.78e+28.
 * @param {unknown} code
 * @returns {string}
 */
export function displayEntityCode(code) {
  if (code == null || String(code).trim() === "") return "—";
  const s = String(code).trim();
  if (/^\d+$/.test(s)) return s.replace(/^0+/, "") || "0";
  return s;
}

/**
 * Show the stored scannable barcode. products.barcode is never a رقم.
 * @param {{ barcode?: unknown } | null | undefined} product
 * @returns {string}
 */
export function displayProductBarcode(product) {
  if (product == null) return "—";
  const barcode = product.barcode != null ? String(product.barcode).trim() : "";
  return barcode || "—";
}

/**
 * products.sku is رقم المنتج (not a barcode).
 * Storage and UI both show the plain number (2, not 00000000002).
 * Scientific notation and oversized digit strings are not product numbers.
 */
export function displayProductSku(code) {
  if (code == null || String(code).trim() === "") return "—";
  const n = parseProductSkuNumber(code);
  return n != null ? String(n) : "—";
}

/** Value for an editable الرقم field — empty if the value is not a real رقم. */
export function productSkuInputValue(code) {
  const n = parseProductSkuNumber(code);
  return n != null ? String(n) : "";
}

/**
 * @param {unknown} code
 * @returns {number | null}
 */
export function parseProductSkuNumber(code) {
  if (code == null || String(code).trim() === "") return null;
  const s = String(code).trim();
  if (!/^\d{1,11}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * @param {Array<{ sku?: unknown, id?: unknown }>} rows
 */
export function sortProductsBySku(rows) {
  return [...rows].sort((a, b) => {
    const an = parseProductSkuNumber(a?.sku);
    const bn = parseProductSkuNumber(b?.sku);
    if (an != null && bn != null && an !== bn) return an - bn;
    if (an != null && bn == null) return -1;
    if (an == null && bn != null) return 1;
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  });
}

/**
 * If the query is a product رقم that exists, keep only that item.
 * @param {Array<{ sku?: unknown }>} rows
 * @param {string} query
 */
export function filterProductsBySkuQuery(rows, query) {
  const q = String(query ?? "").trim();
  if (!/^\d+$/.test(q)) return rows;
  const n = parseProductSkuNumber(q);
  if (n == null) return rows;
  const exact = rows.filter((p) => parseProductSkuNumber(p?.sku) === n);
  return exact.length ? exact : rows;
}

/**
 * Row number in a paginated list (1-based): 1, 2, 3… in visible table order.
 * @param {number} page
 * @param {number} pageSize
 * @param {number} index
 */
export function displayListRowNumber(page, pageSize, index) {
  return String(page * pageSize + index + 1);
}
