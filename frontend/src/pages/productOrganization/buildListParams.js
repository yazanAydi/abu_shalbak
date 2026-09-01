export const PRODUCT_ORG_PAGE_SIZE = 200;

/**
 * Query params for GET /api/products on the organization page.
 * Uses catalog_search so POS `search`/`q` mode is not triggered.
 */
export function buildOrganizationListParams({
  search,
  unit,
  category,
  isActive,
  limit = PRODUCT_ORG_PAGE_SIZE,
  offset = 0,
} = {}) {
  const params = {
    limit: Number(limit) || PRODUCT_ORG_PAGE_SIZE,
    offset: Math.max(0, Number(offset) || 0),
  };
  const q = String(search ?? "").trim();
  if (q) params.catalog_search = q;
  const unitName = String(unit ?? "").trim();
  if (unitName) params.unit = unitName;
  const categoryName = String(category ?? "").trim();
  if (categoryName) params.category = categoryName;
  if (isActive === "0" || isActive === "1" || isActive === 0 || isActive === 1) {
    params.is_active = Number(isActive);
  }
  return params;
}
