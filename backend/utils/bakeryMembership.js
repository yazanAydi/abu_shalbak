/**
 * Bakery workspace membership — two independent, explicit flags.
 *
 * Materials (مواد المخبز): products.inventory_scope = 'bakery'.
 * Finished bakery goods (أصناف البيع): current product category is in the
 * configured bakery report categories. Historical sales use that live category
 * (not a snapshot stored on the sale line).
 *
 * Never infer membership from product names. Never rewrite inventory_scope or
 * category as a side effect of opening a bakery screen.
 *
 * Finished-good revenue uses bakery sales categories. Material-sale revenue is
 * independent: bakery scope + an explicit POS-sellable unit. Hidden materials
 * stay out. Purchases / stock / expiry use the workspace union so mixed invoices
 * and ingredient movements still appear.
 */

export const BAKERY_KIND_MATERIALS = "materials";
export const BAKERY_KIND_FINISHED = "finished";
export const BAKERY_KIND_SALES = "sales";
export const BAKERY_KIND_WORKSPACE = "workspace";

export const BAKERY_MEMBERSHIP_RULES = {
  materials:
    "المواد تُحدَّد من نطاق مواد المخبز، وليس من الاسم أو من تصنيفات البيع.",
  finished:
    "أصناف البيع تُحدَّد من تصنيفات تقرير المخبز الحالية — لا تُحفظ مع الفاتورة.",
  sales:
    "أصناف البيع من تصنيفات المخبز. بيع المواد يُحسب فقط إذا أُتيحت للكاشير، دون اشتراط تصنيف بيع.",
  workspace:
    "المشتريات والحركة والصلاحية تشمل المواد وأصناف البيع معاً دون خلط إيراد البيع بمشتريات المواد.",
  historical:
    "التصنيف حسب التصنيف الحالي للمنتج (لا يُحفظ التصنيف عند البيع). تغيير تصنيف المنتج يغيّر نتائج تقرير المخبز للفترات السابقة.",
  pos:
    "إتاحة الكاشير هي إعداد الوحدة «متاح للبيع (كاشير)»، ومستقلة عن انتماء المخبز.",
};

const KINDS = new Set([
  BAKERY_KIND_MATERIALS,
  BAKERY_KIND_FINISHED,
  BAKERY_KIND_SALES,
  BAKERY_KIND_WORKSPACE,
]);

export function parseBakeryKind(value, fallback = BAKERY_KIND_WORKSPACE) {
  const kind = String(value || "").trim().toLowerCase();
  return KINDS.has(kind) ? kind : fallback;
}

export function bakeryCategoryNameSet(categories) {
  const set = new Set();
  for (const row of Array.isArray(categories) ? categories : []) {
    const name = String(row?.name ?? row ?? "").trim();
    if (name) set.add(name);
  }
  return set;
}

export function isBakeryMaterial(product) {
  return String(product?.inventory_scope || "retail") === "bakery";
}

export function inBakerySalesCategory(product, categoryNameSet) {
  const name = String(product?.category || "").trim();
  return Boolean(name) && categoryNameSet instanceof Set && categoryNameSet.has(name);
}

/** True when this unit is flagged for cashier sale (null keeps legacy rows sellable). */
export function isUnitSaleEnabled(unit) {
  if (unit == null) return false;
  if (unit.sale_enabled == null) return true;
  return unit.sale_enabled !== false && Number(unit.sale_enabled) !== 0;
}

/** True when at least one unit is flagged for cashier sale (existing POS setting). */
export function isPosSellableFromUnits(units) {
  const list = Array.isArray(units) ? units : [];
  if (!list.length) return false;
  return list.some((unit) => isUnitSaleEnabled(unit));
}

export function classifyBakeryProduct(product, categoryNameSet, units) {
  const material = isBakeryMaterial(product);
  const inSalesCategory = inBakerySalesCategory(product, categoryNameSet);
  const posAvailable =
    product?.pos_available != null
      ? Number(product.pos_available) === 1
      : units
        ? isPosSellableFromUnits(units)
        : null;
  const overlap = material && inSalesCategory;
  const finished = inSalesCategory && !material;
  const workspace = material || inSalesCategory;
  const salesEligible = finished || (material && posAvailable === true);
  return {
    material,
    finished,
    overlap,
    workspace,
    in_sales_category: inSalesCategory,
    pos_available: posAvailable,
    sales_eligible: salesEligible,
    kind: overlap ? "both" : material ? BAKERY_KIND_MATERIALS : finished ? BAKERY_KIND_FINISHED : null,
  };
}

export function posSaleUnitExistsSql(productIdExpr) {
  return `EXISTS (
    SELECT 1 FROM product_units pu
    WHERE pu.product_id = ${productIdExpr}
      AND COALESCE(pu.sale_enabled, 1) = 1
  )`;
}

/** POS may sell any retail SKU; bakery materials need an explicit sale_enabled unit. */
export function posCatalogVisibleSql(productIdExpr, scopeExpr) {
  return `(COALESCE(${scopeExpr}, 'retail') != 'bakery' OR ${posSaleUnitExistsSql(productIdExpr)})`;
}

function col(alias, name) {
  return alias ? `${alias}.${name}` : name;
}

function materialsSql(alias) {
  return `COALESCE(${col(alias, "inventory_scope")}, 'retail') = 'bakery'`;
}

function categoryInSql(alias, categoryNames) {
  const names = [...new Set((categoryNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  if (!names.length) return { sql: "0", params: [] };
  const placeholders = names.map(() => "?").join(", ");
  return {
    sql: `TRIM(COALESCE(${col(alias, "category")}, '')) IN (${placeholders})`,
    params: names,
  };
}

/**
 * SQL fragment (including leading AND) matching bakery membership.
 * @param {string[]} categoryNames configured bakery report category names
 * @param {{ alias?: string, kind?: string }} [options]
 */
export function bakeryMembershipSql(categoryNames, options = {}) {
  const alias = options.alias || "";
  const kind = parseBakeryKind(options.kind, BAKERY_KIND_WORKSPACE);
  const material = materialsSql(alias);
  const finished = categoryInSql(alias, categoryNames);
  const idExpr = col(alias, "id");
  const pos = posSaleUnitExistsSql(idExpr);

  if (kind === BAKERY_KIND_MATERIALS) {
    return { sql: ` AND (${material})`, params: [] };
  }
  if (kind === BAKERY_KIND_FINISHED) {
    if (!finished.params.length) return { sql: " AND 0", params: [] };
    return { sql: ` AND (${finished.sql}) AND NOT (${material})`, params: finished.params };
  }
  if (kind === BAKERY_KIND_SALES) {
    const materialSales = `(${material}) AND ${pos}`;
    if (!finished.params.length) {
      return { sql: ` AND (${materialSales})`, params: [] };
    }
    return {
      sql: ` AND (((${finished.sql}) AND NOT (${material})) OR (${materialSales}))`,
      params: finished.params,
    };
  }
  if (!finished.params.length) {
    return { sql: ` AND (${material})`, params: [] };
  }
  return { sql: ` AND ((${material}) OR (${finished.sql}))`, params: finished.params };
}

export function bakeryMembershipSelectExtras(alias = "p") {
  const idExpr = col(alias, "id");
  return `, CASE WHEN ${posSaleUnitExistsSql(idExpr)} THEN 1 ELSE 0 END AS pos_available`;
}

export async function loadBakeryCategoryNames(db, resolveCategories) {
  const resolved = await resolveCategories(db);
  return {
    resolved,
    names: (resolved.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean),
    ids: (resolved.categories || []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0),
  };
}

export async function bakeryMembershipMapping(db, categoryNames) {
  const names = (categoryNames || []).map((n) => String(n || "").trim()).filter(Boolean);
  const material = materialsSql("");
  const finished = categoryInSql("", names);

  const materialsCount = await db.get(
    `SELECT COUNT(*) AS n FROM products WHERE ${material}`
  );
  let finishedCount = { n: 0 };
  let overlapCount = { n: 0 };
  let overlapSamples = [];
  const pos = posSaleUnitExistsSql("products.id");
  let salesEligible = await db.get(
    `SELECT COUNT(*) AS n FROM products WHERE (${material}) AND ${pos}`
  );
  if (names.length) {
    finishedCount = await db.get(
      `SELECT COUNT(*) AS n FROM products WHERE (${finished.sql}) AND NOT (${material})`,
      finished.params
    );
    overlapCount = await db.get(
      `SELECT COUNT(*) AS n FROM products WHERE (${finished.sql}) AND (${material})`,
      finished.params
    );
    overlapSamples = await db.all(
      `SELECT id, name, category, COALESCE(inventory_scope, 'retail') AS inventory_scope
       FROM products
       WHERE (${finished.sql}) AND (${material})
       ORDER BY name COLLATE NOCASE, id
       LIMIT 8`,
      finished.params
    );
    salesEligible = await db.get(
      `SELECT COUNT(*) AS n FROM products
       WHERE ((${finished.sql}) AND NOT (${material})) OR ((${material}) AND ${pos})`,
      finished.params
    );
  }

  return {
    materials_count: Number(materialsCount?.n) || 0,
    finished_count: Number(finishedCount?.n) || 0,
    overlap_count: Number(overlapCount?.n) || 0,
    sales_eligible_count: Number(salesEligible?.n) || 0,
    overlap_samples: overlapSamples.map((row) => ({
      product_id: Number(row.id),
      name: row.name,
      category_name: row.category,
      kind: "both",
    })),
    rules: BAKERY_MEMBERSHIP_RULES,
  };
}
