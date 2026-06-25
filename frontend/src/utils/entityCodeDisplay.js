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
 * Row number in a paginated list (1-based): 1, 2, 3… in visible table order.
 * @param {number} page
 * @param {number} pageSize
 * @param {number} index
 */
export function displayListRowNumber(page, pageSize, index) {
  return String(page * pageSize + index + 1);
}
