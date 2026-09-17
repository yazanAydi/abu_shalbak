import {
  BAKERY_KIND_FINISHED,
  BAKERY_KIND_MATERIALS,
  BAKERY_KIND_SALES,
  BAKERY_KIND_WORKSPACE,
  bakeryCategoryNameSet,
  bakeryMembershipSql,
  classifyBakeryProduct,
  isUnitSaleEnabled,
  parseBakeryKind,
  posCatalogVisibleSql,
} from "../utils/bakeryMembership.js";

describe("bakery membership helper", () => {
  const categories = bakeryCategoryNameSet([{ name: "مخبز" }, { name: " حلويات " }]);

  test("parseBakeryKind falls back without inferring from names", () => {
    expect(parseBakeryKind("sales")).toBe(BAKERY_KIND_SALES);
    expect(parseBakeryKind("خبز")).toBe(BAKERY_KIND_WORKSPACE);
    expect(parseBakeryKind("Flour")).toBe(BAKERY_KIND_WORKSPACE);
  });

  test("isUnitSaleEnabled treats 0/false as off and null as on", () => {
    expect(isUnitSaleEnabled({ sale_enabled: 0 })).toBe(false);
    expect(isUnitSaleEnabled({ sale_enabled: false })).toBe(false);
    expect(isUnitSaleEnabled({ sale_enabled: 1 })).toBe(true);
    expect(isUnitSaleEnabled({ sale_enabled: true })).toBe(true);
    expect(isUnitSaleEnabled({ sale_enabled: null })).toBe(true);
    expect(isUnitSaleEnabled(null)).toBe(false);
  });

  test("POS catalog SQL hides bakery materials unless a sale unit exists", () => {
    const sql = posCatalogVisibleSql("p.id", "p.inventory_scope");
    expect(sql).toMatch(/inventory_scope/);
    expect(sql).toMatch(/sale_enabled/);
    expect(sql).toMatch(/bakery/);
  });

  test("materials follow inventory_scope only", () => {
    const flour = classifyBakeryProduct(
      { inventory_scope: "bakery", category: "مخبز", name: "طحين" },
      categories
    );
    expect(flour.material).toBe(true);
    expect(flour.finished).toBe(false);
    expect(flour.overlap).toBe(true);
    expect(flour.sales_eligible).toBe(false);

    const retailNamed = classifyBakeryProduct(
      { inventory_scope: "retail", category: "ألبان", name: "خبز الصاج" },
      categories
    );
    expect(retailNamed.workspace).toBe(false);
    expect(retailNamed.sales_eligible).toBe(false);
  });

  test("finished goods are bakery categories that are not materials", () => {
    const bread = classifyBakeryProduct(
      { inventory_scope: "retail", category: "مخبز", name: "خبز" },
      categories,
      [{ sale_enabled: 1 }]
    );
    expect(bread.finished).toBe(true);
    expect(bread.sales_eligible).toBe(true);
    expect(bread.kind).toBe(BAKERY_KIND_FINISHED);
  });

  test("a material becomes sales-eligible only with an explicit POS unit", () => {
    const product = { inventory_scope: "bakery", category: "مخبز", name: "سكر" };
    expect(classifyBakeryProduct(product, categories, [{ sale_enabled: 0 }]).sales_eligible).toBe(false);
    expect(classifyBakeryProduct(product, categories, [{ sale_enabled: 1 }]).sales_eligible).toBe(true);

    const outside = classifyBakeryProduct(
      { inventory_scope: "bakery", category: "ألبان", name: "زيت" },
      categories,
      [{ sale_enabled: 1 }]
    );
    expect(outside.in_sales_category).toBe(false);
    expect(outside.finished).toBe(false);
    expect(outside.sales_eligible).toBe(true);
  });

  test("SQL kinds distinguish materials, finished, sales, and workspace union", () => {
    const names = ["مخبز"];
    const materials = bakeryMembershipSql(names, { kind: BAKERY_KIND_MATERIALS });
    expect(materials.sql).toMatch(/inventory_scope/);
    expect(materials.sql).not.toMatch(/sale_enabled/);

    const finished = bakeryMembershipSql(names, { kind: BAKERY_KIND_FINISHED });
    expect(finished.sql).toMatch(/NOT/);
    expect(finished.params).toEqual(["مخبز"]);

    const sales = bakeryMembershipSql(names, { kind: BAKERY_KIND_SALES });
    expect(sales.sql).toMatch(/sale_enabled/);
    expect(sales.sql).toMatch(/inventory_scope/);

    const salesNoCats = bakeryMembershipSql([], { kind: BAKERY_KIND_SALES });
    expect(salesNoCats.sql).toMatch(/sale_enabled/);
    expect(salesNoCats.sql).not.toMatch(/AND 0/);

    const workspace = bakeryMembershipSql(names, { kind: BAKERY_KIND_WORKSPACE });
    expect(workspace.sql).toMatch(/OR/);
  });
});
