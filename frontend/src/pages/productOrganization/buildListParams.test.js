import { buildOrganizationListParams, PRODUCT_ORG_PAGE_SIZE } from "./buildListParams";

describe("buildOrganizationListParams", () => {
  test("defaults to paginated catalogue without POS search", () => {
    expect(buildOrganizationListParams()).toEqual({
      limit: PRODUCT_ORG_PAGE_SIZE,
      offset: 0,
    });
  });

  test("maps search to catalog_search, not search/q", () => {
    const params = buildOrganizationListParams({ search: "  جبنة  " });
    expect(params.catalog_search).toBe("جبنة");
    expect(params.search).toBeUndefined();
    expect(params.q).toBeUndefined();
  });

  test("includes unit, category, and active filters together", () => {
    expect(
      buildOrganizationListParams({
        search: "مرتديلا",
        unit: "كغم",
        category: "لحوم",
        isActive: "1",
        offset: 200,
        limit: 200,
      })
    ).toEqual({
      limit: 200,
      offset: 200,
      catalog_search: "مرتديلا",
      unit: "كغم",
      category: "لحوم",
      is_active: 1,
    });
  });

  test("omits blank filters and maps inactive", () => {
    expect(
      buildOrganizationListParams({
        search: "   ",
        unit: "",
        category: "",
        isActive: "0",
      })
    ).toEqual({
      limit: PRODUCT_ORG_PAGE_SIZE,
      offset: 0,
      is_active: 0,
    });
  });
});
