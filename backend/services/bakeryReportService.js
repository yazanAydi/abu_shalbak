import { parseItemsJson } from "../utils/cogs.js";
import {
  TX_BUSINESS_DAY_JOIN,
  businessDayRangeClause,
  businessDayRangeParams,
  fetchRefundsForShopDateRange,
  rowMatchesShopDateRange,
} from "../utils/businessDay.js";
import { shopDateRange } from "../utils/shopTime.js";
import { round2, sumMoney } from "../utils/money.js";
import { getAppSettings, updateAppSettings, SETTING_KEYS } from "../utils/settings.js";
import { HttpError } from "../utils/httpError.js";
import { resolveExpiryAlertDays } from "./expiryAlertService.js";
import {
  BAKERY_KIND_WORKSPACE,
  BAKERY_MEMBERSHIP_RULES,
  bakeryMembershipMapping,
  bakeryMembershipSql,
  classifyBakeryProduct,
  bakeryCategoryNameSet,
} from "../utils/bakeryMembership.js";

/** Exact product-category name used only when no category IDs are configured. */
export const BAKERY_REPORT_CATEGORY_EXACT_NAME = "مخبز";

export const BAKERY_CLASSIFICATION_NOTE =
  "التصنيف حسب التصنيف الحالي للمنتج (لا يُحفظ التصنيف عند البيع). تغيير تصنيف المنتج يغيّر نتائج تقرير المخبز للفترات السابقة.";

const SALE_LINE_CHUNK = 400;

export function roundQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

function addQty(a, b) {
  return roundQty((Number(a) || 0) + (Number(b) || 0));
}

function displayUnit(product) {
  const unit = String(product?.unit || "").trim();
  return unit || "حبة";
}

function baseQuantity(quantity, conversionToBase) {
  const qty = Number(quantity) || 0;
  const conv = Number(conversionToBase);
  const factor = Number.isFinite(conv) && conv > 0 ? conv : 1;
  return roundQty(qty * factor);
}

/** Net line sales after the stored invoice-discount share. POS tax is 0. */
export function bakeryLineNetRevenue(item) {
  const discount = Number(item?.discount_at_sale) || 0;
  const gross = Number(item?.line_gross);
  if (Number.isFinite(gross)) return round2(gross - discount);
  return round2((Number(item?.line_net) || 0) + (Number(item?.line_tax) || 0));
}

function refundLineNetRevenue(item) {
  const qty = Number(item?.quantity) || 0;
  if (qty <= 0) return 0;
  if (item?.lineTotal != null && Number.isFinite(Number(item.lineTotal))) {
    return round2(Number(item.lineTotal));
  }
  return round2(qty * (Number(item?.price) || 0));
}

function emptyQtyByUnit() {
  return new Map();
}

function addUnitQty(map, unit, qty) {
  const key = String(unit || "حبة").trim() || "حبة";
  map.set(key, addQty(map.get(key) || 0, qty));
}

function qtyByUnitList(map) {
  return [...map.entries()]
    .map(([unit, quantity]) => ({ unit, quantity: roundQty(quantity) }))
    .sort((a, b) => a.unit.localeCompare(b.unit, "ar"));
}

function emptyKpis() {
  return {
    net_revenue: 0,
    finished_net_revenue: 0,
    material_net_revenue: 0,
    sold_quantity_by_unit: [],
    refunded_quantity_by_unit: [],
    net_quantity_by_unit: [],
    invoice_count: 0,
  };
}

export function parseBakeryRevenueKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "material" || kind === "finished" ? kind : null;
}

function productRevenueKind(product) {
  return String(product?.inventory_scope || "retail") === "bakery" ? "material" : "finished";
}

function productMatchesQuery(product, extraBarcodes, rawQuery) {
  const q = String(rawQuery || "").trim().toLowerCase();
  if (!q) return true;
  if (String(product.name || "").toLowerCase().includes(q)) return true;
  const barcode = String(product.barcode || "").toLowerCase();
  if (barcode && barcode.includes(q)) return true;
  for (const code of extraBarcodes || []) {
    if (String(code || "").toLowerCase().includes(q)) return true;
  }
  return false;
}

export async function resolveBakeryReportCategories(db) {
  const available_categories = await db.all(
    `SELECT id, name, active FROM product_categories
     ORDER BY active DESC, name COLLATE NOCASE`
  );
  const settings = await getAppSettings(db);
  const configured = Array.isArray(settings.bakery_report_category_ids)
    ? settings.bakery_report_category_ids.map(Number)
    : [];
  const byId = new Map(available_categories.map((row) => [Number(row.id), row]));
  const selected = [];
  for (const id of configured) {
    const row = byId.get(Number(id));
    if (row) selected.push(row);
  }
  if (selected.length > 0) {
    return {
      needs_configuration: false,
      source: "settings",
      categories: selected,
      available_categories,
    };
  }

  const exactName = BAKERY_REPORT_CATEGORY_EXACT_NAME.toLowerCase();
  const exact = available_categories.filter(
    (row) => String(row.name || "").trim().toLowerCase() === exactName
  );
  if (exact.length === 1) {
    return {
      needs_configuration: false,
      source: "exact_name",
      categories: exact,
      available_categories,
    };
  }

  return {
    needs_configuration: true,
    source: exact.length > 1 ? "ambiguous" : "unconfigured",
    categories: [],
    available_categories,
  };
}

async function loadCategoryMembership(db) {
  const countRows = await db.all(
    `SELECT TRIM(category) AS name, COUNT(*) AS product_count
     FROM products
     WHERE category IS NOT NULL AND TRIM(category) != ''
     GROUP BY TRIM(category)`
  );
  const countByName = new Map(
    countRows.map((row) => [row.name, Number(row.product_count) || 0])
  );

  const sampleByName = new Map();
  try {
    const sampleRows = await db.all(
      `SELECT category, name FROM (
         SELECT TRIM(category) AS category, name,
           ROW_NUMBER() OVER (
             PARTITION BY TRIM(category) ORDER BY name COLLATE NOCASE, id
           ) AS rn
         FROM products
         WHERE category IS NOT NULL AND TRIM(category) != ''
       ) ranked
       WHERE rn <= 3`
    );
    for (const row of sampleRows) {
      const list = sampleByName.get(row.category) || [];
      list.push(row.name);
      sampleByName.set(row.category, list);
    }
  } catch {
    /* older SQLite without window functions: counts still work */
  }

  const uncategorized = await db.get(
    `SELECT COUNT(*) AS n FROM products
     WHERE category IS NULL OR TRIM(category) = ''`
  );

  return {
    countByName,
    sampleByName,
    uncategorized: Number(uncategorized?.n) || 0,
  };
}

export function presentBakeryCategory(row, membership) {
  const name = row?.name;
  return {
    id: Number(row.id),
    name,
    active: Number(row.active) ? 1 : 0,
    product_count: membership.countByName.get(name) || 0,
    sample_names: membership.sampleByName.get(name) || [],
  };
}

export async function presentBakeryCategoryLists(db, resolved) {
  const membership = await loadCategoryMembership(db);
  return {
    selected_categories: resolved.categories.map((row) =>
      presentBakeryCategory(row, membership)
    ),
    available_categories: resolved.available_categories.map((row) =>
      presentBakeryCategory(row, membership)
    ),
    uncategorized_product_count: membership.uncategorized,
  };
}

export async function saveBakeryReportCategories(db, rawIds) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawIds) ? rawIds : []) {
    const id = Math.floor(Number(raw));
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  if (unique.length > 0) {
    const placeholders = unique.map(() => "?").join(",");
    const found = await db.all(
      `SELECT id FROM product_categories WHERE id IN (${placeholders})`,
      unique
    );
    if (found.length !== unique.length) {
      throw new HttpError(400, "تصنيف المخبز غير موجود", "VALIDATION_ERROR");
    }
  }

  await updateAppSettings(db, {
    [SETTING_KEYS.bakery_report_category_ids]: unique,
  });
  return resolveBakeryReportCategories(db);
}

const BAKERY_PRODUCT_SELECT = `SELECT p.id, p.name, p.barcode, p.sku, p.unit, p.stock, p.is_active, p.is_weighed,
            p.category, p.price, p.min_stock,
            COALESCE(p.inventory_scope, 'retail') AS inventory_scope,
            pc.id AS category_id, pc.name AS category_name
     FROM products p
     LEFT JOIN product_categories pc ON TRIM(p.category) = pc.name`;

async function loadBakeryProducts(db, categoryIds) {
  if (!categoryIds.length) return [];
  const placeholders = categoryIds.map(() => "?").join(",");
  return db.all(
    `${BAKERY_PRODUCT_SELECT}
     WHERE pc.id IN (${placeholders})
     ORDER BY p.name COLLATE NOCASE, p.id`,
    categoryIds
  );
}

async function loadSellableBakeryMaterials(db) {
  return db.all(
    `${BAKERY_PRODUCT_SELECT}
     WHERE COALESCE(p.inventory_scope, 'retail') = 'bakery'
       AND EXISTS (
         SELECT 1 FROM product_units pu
         WHERE pu.product_id = p.id AND COALESCE(pu.sale_enabled, 1) = 1
       )
     ORDER BY p.name COLLATE NOCASE, p.id`
  );
}

async function loadPosAvailableSet(db, productIds) {
  const set = new Set();
  if (!productIds.length) return set;
  for (let i = 0; i < productIds.length; i += SALE_LINE_CHUNK) {
    const chunk = productIds.slice(i, i + SALE_LINE_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT DISTINCT product_id FROM product_units
       WHERE product_id IN (${placeholders}) AND COALESCE(sale_enabled, 1) = 1`,
      chunk
    );
    for (const row of rows) set.add(Number(row.product_id));
  }
  return set;
}

async function loadBakeryWorkspaceAlerts(db, categoryNames) {
  const filter = bakeryMembershipSql(categoryNames, { alias: "p", kind: BAKERY_KIND_WORKSPACE });
  const days = await resolveExpiryAlertDays(db);
  const [lowStock, expiry, batches, negative] = await Promise.all([
    db.all(
      `SELECT p.id, p.name, p.barcode, p.unit, p.stock, p.min_stock, p.category,
              COALESCE(p.inventory_scope, 'retail') AS inventory_scope
       FROM products p
       WHERE (
         (p.min_stock IS NOT NULL AND p.stock <= p.min_stock)
         OR (p.min_stock IS NULL AND p.stock <= 5)
       )${filter.sql}
       ORDER BY p.stock ASC, p.name COLLATE NOCASE
       LIMIT 8`,
      filter.params
    ),
    db.all(
      `SELECT p.id, p.name, p.barcode, p.unit, p.stock, p.expiry_date, p.category,
              CAST(julianday(p.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
       FROM products p
       WHERE p.expiry_date IS NOT NULL AND p.expiry_date != ''
         AND julianday(p.expiry_date) <= julianday('now', '+' || ? || ' days')
         ${filter.sql}
       ORDER BY p.expiry_date ASC
       LIMIT 8`,
      [days, ...filter.params]
    ),
    db.all(
      `SELECT b.id, b.batch_no, b.expiry_date, b.quantity, p.name AS product_name, p.barcode,
              CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
       FROM product_batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.expiry_date IS NOT NULL AND b.expiry_date != ''
         AND b.quantity > 0
         AND julianday(b.expiry_date) <= julianday('now', '+' || ? || ' days')
         ${filter.sql}
       ORDER BY b.expiry_date ASC
       LIMIT 8`,
      [days, ...filter.params]
    ),
    db.all(
      `SELECT p.id, p.name, p.barcode, p.unit, p.stock, p.category
       FROM products p
       WHERE COALESCE(p.stock, 0) < 0${filter.sql}
       ORDER BY p.stock ASC, p.name COLLATE NOCASE
       LIMIT 8`,
      filter.params
    ),
  ]);
  return {
    low_stock: lowStock,
    expiry,
    batches,
    negative_stock: negative,
    expiry_days: days,
    stock_is_current: true,
  };
}

async function loadExtraBarcodes(db, productIds) {
  const map = new Map(productIds.map((id) => [id, []]));
  if (!productIds.length) return map;
  for (let i = 0; i < productIds.length; i += SALE_LINE_CHUNK) {
    const chunk = productIds.slice(i, i + SALE_LINE_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT product_id, barcode FROM product_barcodes WHERE product_id IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      const pid = Number(row.product_id);
      const list = map.get(pid) || [];
      if (row.barcode) list.push(String(row.barcode));
      map.set(pid, list);
    }
  }
  return map;
}

async function fetchSaleLinesForProducts(db, productIds, fromYmd, toYmd) {
  if (!productIds.length) return [];
  const rows = [];
  for (let i = 0; i < productIds.length; i += SALE_LINE_CHUNK) {
    const chunk = productIds.slice(i, i + SALE_LINE_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const part = await db.all(
      `SELECT
         ti.transaction_id,
         ti.product_id,
         ti.quantity,
         ti.line_gross,
         ti.line_net,
         ti.line_tax,
         ti.discount_at_sale,
         ti.unit_name,
         ti.conversion_to_base,
         t.created_at,
         t.business_day AS business_day,
         cs.business_day AS shift_business_day,
         cs.start_time AS start_time
       FROM transaction_items ti
       JOIN transactions t ON t.id = ti.transaction_id
       ${TX_BUSINESS_DAY_JOIN}
       WHERE ti.product_id IN (${placeholders})
         AND COALESCE(t.status, 'completed') = 'completed'
         AND ${businessDayRangeClause("t", "cs")}`,
      [...chunk, ...businessDayRangeParams(fromYmd, toYmd)]
    );
    rows.push(...part);
  }
  return rows.filter((row) => rowMatchesShopDateRange(row, fromYmd, toYmd));
}

function compareBakeryRows(a, b, sort, dir) {
  const mul = dir === "asc" ? 1 : -1;
  if (sort === "sold_quantity") {
    const diff = (Number(a.sold_quantity) || 0) - (Number(b.sold_quantity) || 0);
    if (diff !== 0) return mul * diff;
  } else if (sort === "net_revenue") {
    const diff = (Number(a.net_revenue) || 0) - (Number(b.net_revenue) || 0);
    if (diff !== 0) return mul * diff;
  } else if (sort === "stock") {
    const diff = (Number(a.stock) || 0) - (Number(b.stock) || 0);
    if (diff !== 0) return mul * diff;
  }
  const byName = String(a.name || "").localeCompare(String(b.name || ""), "ar");
  if (byName !== 0) return byName;
  return Number(a.product_id) - Number(b.product_id);
}

export async function getBakeryReport(db, filters = {}) {
  const fromYmd = filters.from;
  const toYmd = filters.to;
  const productIdFilter =
    filters.productId != null && Number.isFinite(Number(filters.productId))
      ? Number(filters.productId)
      : null;
  const query = String(filters.q || "").trim();
  const sort = ["sold_quantity", "net_revenue", "stock", "name"].includes(filters.sort)
    ? filters.sort
    : "name";
  const dir = filters.dir === "asc" || filters.dir === "desc"
    ? filters.dir
    : sort === "name"
      ? "asc"
      : "desc";
  const revenueKind = parseBakeryRevenueKind(filters.revenueKind);

  const resolved = await resolveBakeryReportCategories(db);
  const presented = await presentBakeryCategoryLists(db, resolved);
  const categoryNames = (resolved.categories || []).map((row) => String(row.name || "").trim());
  const categoryNameSet = bakeryCategoryNameSet(resolved.categories);
  const mapping = await bakeryMembershipMapping(db, categoryNames);
  const alerts = await loadBakeryWorkspaceAlerts(db, categoryNames);
  const classification = {
    mode: "current_product_category",
    historical_category_snapshot: false,
    includes_inactive_products: true,
    stored_as: "products.category_name",
    note: BAKERY_CLASSIFICATION_NOTE,
    materials_rule: BAKERY_MEMBERSHIP_RULES.materials,
    finished_rule: BAKERY_MEMBERSHIP_RULES.finished,
    sales_rule: BAKERY_MEMBERSHIP_RULES.sales,
    workspace_rule: BAKERY_MEMBERSHIP_RULES.workspace,
    pos_rule: BAKERY_MEMBERSHIP_RULES.pos,
  };

  const baseMeta = {
    from: fromYmd,
    to: toYmd,
    needs_configuration: resolved.needs_configuration,
    configuration_source: resolved.source,
    selected_categories: presented.selected_categories,
    available_categories: presented.available_categories,
    uncategorized_product_count: presented.uncategorized_product_count,
    empty_selected_catalog: false,
    classification,
    membership: mapping,
    alerts,
    stock_note: "المخزون الحالي — لا يتأثر بالفترة المختارة",
    classification_note: BAKERY_CLASSIFICATION_NOTE,
    invoice_count_note:
      "عدد الفواتير على مستوى الصنف لا يُجمع إلى إجمالي فواتير المخبز",
  };

  const categoryIds = resolved.categories.map((c) => Number(c.id));
  const [inCategory, sellableMaterials] = await Promise.all([
    loadBakeryProducts(db, categoryIds),
    loadSellableBakeryMaterials(db),
  ]);
  const catalogById = new Map();
  for (const product of inCategory) {
    const classified = classifyBakeryProduct(product, categoryNameSet, null);
    if (!classified.finished) continue;
    product.membership_kind = classified.kind;
    product.revenue_kind = "finished";
    catalogById.set(Number(product.id), product);
  }
  for (const product of sellableMaterials) {
    const classified = classifyBakeryProduct(product, categoryNameSet, null);
    product.membership_kind = classified.kind;
    product.revenue_kind = "material";
    catalogById.set(Number(product.id), product);
  }
  const catalog = [...catalogById.values()];
  const posAvailable = await loadPosAvailableSet(
    db,
    catalog.map((p) => Number(p.id))
  );
  for (const product of catalog) {
    product.pos_available = posAvailable.has(Number(product.id)) ? 1 : 0;
    if (!product.revenue_kind) product.revenue_kind = productRevenueKind(product);
  }
  baseMeta.empty_selected_catalog = catalog.length === 0;
  if (catalog.length === 0) {
    return {
      ...baseMeta,
      kpis: emptyKpis(),
      products: [],
    };
  }
  const extraBarcodes = await loadExtraBarcodes(
    db,
    catalog.map((p) => Number(p.id))
  );

  const visible = catalog.filter((product) => {
    if (revenueKind && product.revenue_kind !== revenueKind) return false;
    if (productIdFilter != null && Number(product.id) !== productIdFilter) return false;
    return productMatchesQuery(product, extraBarcodes.get(Number(product.id)), query);
  });

  const visibleIds = visible.map((p) => Number(p.id));
  const visibleSet = new Set(visibleIds);

  const [saleLines, refunds] = await Promise.all([
    fetchSaleLinesForProducts(db, visibleIds, fromYmd, toYmd),
    fetchRefundsForShopDateRange(db, fromYmd, toYmd),
  ]);

  const byProduct = new Map(
    visible.map((product) => {
      const pid = Number(product.id);
      return [
        pid,
        {
          product_id: pid,
          name: product.name,
          barcode: product.barcode || null,
          sku: product.sku ?? null,
          unit: displayUnit(product),
          stock: Number(product.stock) || 0,
          is_active: Number(product.is_active) === 0 ? 0 : 1,
          is_weighed: Number(product.is_weighed) === 1 ? 1 : 0,
          category_id: Number(product.category_id),
          category_name: product.category_name,
          pos_available: Number(product.pos_available) === 1 ? 1 : 0,
          membership_kind: product.membership_kind,
          revenue_kind: product.revenue_kind === "material" ? "material" : "finished",
          sold_quantity: 0,
          refunded_quantity: 0,
          net_quantity: 0,
          sold_revenue: 0,
          refunded_revenue: 0,
          net_revenue: 0,
          invoice_ids: new Set(),
        },
      ];
    })
  );

  const bakeryInvoiceIds = new Set();
  const soldByUnit = emptyQtyByUnit();

  for (const line of saleLines) {
    const pid = Number(line.product_id);
    const row = byProduct.get(pid);
    if (!row) continue;
    const qty = baseQuantity(line.quantity, line.conversion_to_base);
    const revenue = bakeryLineNetRevenue(line);
    row.sold_quantity = addQty(row.sold_quantity, qty);
    row.sold_revenue = round2(row.sold_revenue + revenue);
    row.invoice_ids.add(Number(line.transaction_id));
    bakeryInvoiceIds.add(Number(line.transaction_id));
    addUnitQty(soldByUnit, row.unit, qty);
  }

  const refundedByUnit = emptyQtyByUnit();
  for (const refund of refunds) {
    const items = parseItemsJson(refund.items_json);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const pid = Number(item.product_id);
      if (!visibleSet.has(pid)) continue;
      const row = byProduct.get(pid);
      if (!row) continue;
      const qty = baseQuantity(item.quantity, item.conversion_to_base);
      if (qty <= 0) continue;
      const revenue = refundLineNetRevenue(item);
      row.refunded_quantity = addQty(row.refunded_quantity, qty);
      row.refunded_revenue = round2(row.refunded_revenue + revenue);
      addUnitQty(refundedByUnit, row.unit, qty);
    }
  }

  const netByUnit = emptyQtyByUnit();
  const products = [...byProduct.values()].map((row) => {
    const netQuantity = roundQty(row.sold_quantity - row.refunded_quantity);
    addUnitQty(netByUnit, row.unit, netQuantity);
    return {
      product_id: row.product_id,
      name: row.name,
      barcode: row.barcode,
      sku: row.sku ?? null,
      unit: row.unit,
      stock: row.stock,
      is_active: row.is_active,
      is_weighed: row.is_weighed,
      category_id: row.category_id,
      category_name: row.category_name,
      pos_available: Number(row.pos_available) === 1 ? 1 : 0,
      membership_kind: row.membership_kind,
      revenue_kind: row.revenue_kind === "material" ? "material" : "finished",
      sold_quantity: roundQty(row.sold_quantity),
      refunded_quantity: roundQty(row.refunded_quantity),
      net_quantity: netQuantity,
      net_revenue: round2(row.sold_revenue - row.refunded_revenue),
      invoice_count: row.invoice_ids.size,
    };
  });

  products.sort((a, b) => compareBakeryRows(a, b, sort, dir));

  const finished_net_revenue = sumMoney(
    products.filter((p) => p.revenue_kind === "finished").map((p) => p.net_revenue)
  );
  const material_net_revenue = sumMoney(
    products.filter((p) => p.revenue_kind === "material").map((p) => p.net_revenue)
  );

  return {
    ...baseMeta,
    kpis: {
      net_revenue: sumMoney([finished_net_revenue, material_net_revenue]),
      finished_net_revenue,
      material_net_revenue,
      sold_quantity_by_unit: qtyByUnitList(soldByUnit),
      refunded_quantity_by_unit: qtyByUnitList(refundedByUnit),
      net_quantity_by_unit: qtyByUnitList(netByUnit),
      invoice_count: bakeryInvoiceIds.size,
    },
    products,
  };
}

export function assertBakeryDateRange(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) {
    throw new HttpError(400, "مطلوب معلما from و to بصيغة YYYY-MM-DD", "VALIDATION_ERROR");
  }
  if (fromYmd > toYmd) {
    throw new HttpError(400, "from يجب أن يسبق to أو يساويه", "VALIDATION_ERROR");
  }
  const dates = shopDateRange(fromYmd, toYmd);
  if (dates.length > 366) {
    throw new HttpError(400, "الفترة تتجاوز 366 يوماً", "VALIDATION_ERROR");
  }
  return dates;
}
