const PRODUCT_SKU_LENGTH = 11;

/**
 * Display entity code (sku / customer_code / supplier_code) as plain integer when numeric.
 * @param {unknown} code
 * @returns {string}
 */
export function displayEntityCode(code) {
  if (code == null || String(code).trim() === "") return "—";
  const n = Number(String(code).trim());
  return Number.isFinite(n) ? String(n) : String(code).trim();
}

/**
 * Product رقم keeps leading zeros (11 digits when numeric).
 * @param {unknown} code
 * @returns {string}
 */
export function displayProductBarcode(product) {
  if (product == null) return "—";
  const shown = product.barcode_display != null && String(product.barcode_display).trim() !== ""
    ? String(product.barcode_display).trim()
    : "";
  if (shown) return shown;
  const barcode = product.barcode != null ? String(product.barcode).trim() : "";
  if (!barcode) return "—";
  const skuShown = displayProductSku(product.sku);
  const barcodeAsSku = displayProductSku(barcode);
  if (skuShown !== "—" && barcodeAsSku === skuShown) return "—";
  return barcode;
}

export function displayProductSku(code) {
  if (code == null || String(code).trim() === "") return "—";
  const s = String(code).trim();
  if (!/^\d+$/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  return String(Math.floor(n)).padStart(PRODUCT_SKU_LENGTH, "0");
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
