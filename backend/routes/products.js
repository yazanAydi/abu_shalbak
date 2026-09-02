/**
 * Product identity contract (do not conflate these fields):
 * - products.sku     = رقم المنتج (internal product number). Column name kept
 *                      for backward compatibility. Stored as plain integer text
 *                      (`1`, `2`, `10`) with no leading zeros. Never a barcode.
 * - products.barcode = الباركود (scannable code, digits-only, 4–14 chars).
 *                      Never derived from sku.
 * See docs/PRODUCT_NUMBER_AND_BARCODE.md.
 */
import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { isAdmin } from "../utils/roles.js";
import {
  findProductByBarcode,
  isValidStoredBarcode,
  normalizeBarcodeInput,
  normalizeStoredBarcode,
} from "../utils/barcode.js";
import {
  formatProductSku,
  getNextProductNumber,
} from "../utils/suggestedBarcode.js";
import {
  addProductBarcode,
  ensureProductBarcodeOnCreate,
  syncProductsPrimaryBarcode,
} from "../utils/productBarcodes.js";
import { buildBarcodeLookupResponse } from "../utils/productUnitLookup.js";
import {
  DEFAULT_PACKAGE_UNIT_NAME,
  WEIGHED_BASE_UNIT_NAME,
  checkUnitBarcodeAvailability,
  deleteProductUnit,
  disableWeighedPackageUnit,
  ensureWeighedProductUnits,
  formatProductUnit,
  getDefaultUnit,
  loadUnitsCatalog,
  loadUnitsForProduct,
  renameProductDisplayUnit,
  syncProductFromDefaultUnit,
  upsertProductUnit,
  withScaleCode,
} from "../utils/productUnits.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { ensureEntityCode, parseNumericCode, productSkuLookupValues } from "../utils/entityCodes.js";
import { recordPriceChange } from "../utils/priceHistory.js";
import { getSalesByPrice } from "../utils/salesByPrice.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import {
  BAKERY_CATEGORY_NAME,
  createProductCategory,
  deleteProductCategory,
  ensureProductCategory,
  listProductCategories,
  normalizeCategoryName,
  updateProductCategory,
} from "../utils/productCategories.js";
import {
  createUnitName,
  deleteUnitName,
  ensureUnitName,
  listUnitNames,
  updateUnitName,
} from "../utils/unitNameCatalog.js";
import { round2 } from "../utils/money.js";
import { withTransaction } from "../utils/dbTx.js";
import { MISSING_CATALOG_FILTER } from "../utils/catalogMissingFilter.js";

function clampProductStock(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 1000) / 1000);
}

function isSqliteConstraint(err) {
  return String(err?.code || "").startsWith("SQLITE_CONSTRAINT");
}

function skuConstraintError(err) {
  const msg = String(err?.message || "");
  return isSqliteConstraint(err) && /sku|idx_products_sku/i.test(msg);
}

/**
 * @param {object} db
 * @param {unknown} sku
 * @param {number | null} [excludeId]
 */
async function findSkuConflict(db, sku, excludeId = null) {
  const values = productSkuLookupValues(sku);
  if (!values.length) return null;
  const placeholders = values.map(() => "?").join(", ");
  return excludeId
    ? db.get(
        `SELECT id FROM products WHERE sku IN (${placeholders}) AND id != ?`,
        [...values, excludeId]
      )
    : db.get(`SELECT id FROM products WHERE sku IN (${placeholders})`, values);
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Flat product fields for barcode lookup fallbacks (no unit catalog). */
function flatBarcodeLookupFields(found) {
  const row = found.product;
  return {
    id: row.id,
    barcode: row.barcode,
    primary_barcode: row.barcode,
    name: row.name,
    name_en: row.name_en ?? null,
    price: row.price,
    cost: row.cost,
    stock: row.stock,
    category: row.category,
    tax_rate: row.tax_rate ?? null,
    unit: row.unit ?? null,
    expiry_date: row.expiry_date ?? null,
    min_price: row.min_price ?? null,
    max_price: row.max_price ?? null,
    sku: row.sku ?? null,
    image_url: row.image_url ?? null,
    is_active: row.is_active,
    scanned_barcode: found.scannedBarcode,
    product_barcode_id: found.productBarcodeId,
    matched_barcode: found.matchedBarcode,
  };
}

const DEFAULT_PRODUCT_PAGE_SIZE = 200;
const MAX_PRODUCT_PAGE_SIZE = 500;

function parsePagination(query, defLimit = 100, maxLimit = 500) {
  const unlimited = query.limit === "all" || query.limit === "0" || Number(query.limit) === 0;
  const limit = unlimited
    ? 10000
    : Math.min(maxLimit, Math.max(1, Number(query.limit) || defLimit));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}

function parseDateParam(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

function marginPct(price, cost) {
  const p = Number(price) || 0;
  const c = Number(cost) || 0;
  if (p <= 0) return 0;
  return round2(((p - c) / p) * 100);
}

const SCALE_CODE_SQL = `CASE WHEN COALESCE(is_weighed, 0) = 1 THEN (
  SELECT pu.barcode FROM product_units pu
  WHERE pu.product_id = products.id AND pu.unit_name = '${WEIGHED_BASE_UNIT_NAME}'
  ORDER BY pu.is_default DESC, pu.id ASC LIMIT 1
) ELSE NULL END AS scale_code`;

const SCALE_CODE_SQL_P = `CASE WHEN COALESCE(p.is_weighed, 0) = 1 THEN (
  SELECT pu.barcode FROM product_units pu
  WHERE pu.product_id = p.id AND pu.unit_name = '${WEIGHED_BASE_UNIT_NAME}'
  ORDER BY pu.is_default DESC, pu.id ASC LIMIT 1
) ELSE NULL END AS scale_code`;

const PRODUCT_LIST_SELECT = `id, barcode, name, name_en, price, cost, stock, category, tax_rate, unit, expiry_date, min_price, max_price, sku,
              COALESCE(is_active, 1) AS is_active, COALESCE(needs_review, 0) AS needs_review, COALESCE(is_weighed, 0) AS is_weighed,
              COALESCE(inventory_scope, 'retail') AS inventory_scope, min_stock, ${SCALE_CODE_SQL}`;

const PRODUCT_LIST_SELECT_P = `p.id, p.barcode, p.name, p.name_en, p.price, p.cost, p.stock, p.category, p.tax_rate, p.unit, p.expiry_date, p.min_price, p.max_price, p.sku,
              COALESCE(p.is_active, 1) AS is_active, COALESCE(p.needs_review, 0) AS needs_review, COALESCE(p.is_weighed, 0) AS is_weighed,
              COALESCE(p.inventory_scope, 'retail') AS inventory_scope, p.min_stock, ${SCALE_CODE_SQL_P}`;

const VALID_INVENTORY_SCOPES = ["retail", "bakery"];

function parseInventoryScope(value, fallback = "retail") {
  const s = String(value ?? fallback).trim().toLowerCase();
  return VALID_INVENTORY_SCOPES.includes(s) ? s : fallback;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseScaleCodeInput(raw) {
  if (raw === undefined) return { provided: false, value: undefined };
  if (raw === null || String(raw).trim() === "") return { provided: true, value: null };
  const code = normalizeStoredBarcode(raw);
  if (!isValidStoredBarcode(code)) {
    return { provided: true, error: "رمز الميزان غير صالح" };
  }
  return { provided: true, value: code };
}

function parsePackageConversion(raw) {
  if (raw === undefined || raw === null || raw === "") return { provided: false, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { provided: true, error: "وزن الحبة غير صالح" };
  }
  return { provided: true, value: n };
}

function parsePackagePrice(raw) {
  if (raw === undefined || raw === null || raw === "") return { provided: false, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { provided: true, error: "سعر الحبة غير صالح" };
  }
  return { provided: true, value: n };
}

const PACKAGE_PAIR_ERROR = "أدخل وزن الحبة وسعر الحبة معاً، أو اتركهما فارغين";

/**
 * Type A: both package fields omitted/empty → KG only.
 * Type B: both conversion > 0 and price > 0 → كغم + حبة.
 * One-sided → 400.
 * `omit` means the client did not send either key (PUT: leave existing pack).
 */
function parseWeighedPackagePair(body) {
  const src = body && typeof body === "object" ? body : {};
  const hasConv = Object.prototype.hasOwnProperty.call(src, "package_conversion");
  const hasPrice = Object.prototype.hasOwnProperty.call(src, "package_price");
  if (!hasConv && !hasPrice) return { mode: "omit" };
  if (hasConv !== hasPrice) return { error: PACKAGE_PAIR_ERROR };

  const convParsed = parsePackageConversion(src.package_conversion);
  const priceParsed = parsePackagePrice(src.package_price);
  if (convParsed.error) return { error: convParsed.error };
  if (priceParsed.error) return { error: priceParsed.error };
  if (!convParsed.provided && !priceParsed.provided) return { mode: "none" };
  if (convParsed.provided !== priceParsed.provided) return { error: PACKAGE_PAIR_ERROR };
  return { mode: "both", conversion: convParsed.value, price: priceParsed.value };
}

async function assertScaleCodeAvailable(db, scaleCode, productId, excludeUnitId = null) {
  if (!scaleCode) return;
  const avail = await checkUnitBarcodeAvailability(db, {
    barcode: scaleCode,
    productId,
    excludeUnitId,
  });
  if (avail.status === "conflict") {
    throw httpError(409, "رمز الميزان مرتبط بمنتج آخر");
  }
}

/**
 * Metadata-only product update. `products.stock` is never written here —
 * inventory changes go through addLedgerEntry (checkout, refund, purchase,
 * posted stock adjustment / count). A client may still send `stock` (old
 * office forms); it is ignored so a stale form cannot clobber a newer qty.
 *
 * Only columns present on `body` are SET, so two concurrent PUTs of
 * different fields do not last-write-wins the rest of the row.
 */
async function applyProductMetadataPatch(db, req, id, body) {
  const b = body || {};
  return withTransaction(db, async () => {
    const live = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (!live) throw httpError(404, "المنتج غير موجود");

    const sets = [];
    const params = [];
    const setCol = (col, value) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };

    let barcode = live.barcode;
    if (b.barcode !== undefined) {
      barcode = String(b.barcode ?? "").trim() ? normalizeStoredBarcode(b.barcode) : null;
      if (!barcode) throw httpError(400, "الباركود مطلوب");
      if (!isValidStoredBarcode(barcode)) throw httpError(400, "باركود غير صالح");
      if (barcode !== live.barcode) {
        const dup = await db.get("SELECT id FROM products WHERE barcode = ? AND id != ?", [barcode, id]);
        if (dup) throw httpError(409, "الباركود موجود مسبقاً");
        const pbDup = await db.get(
          "SELECT product_id FROM product_barcodes WHERE barcode = ? AND product_id != ?",
          [barcode, id]
        );
        if (pbDup) throw httpError(409, "هذا الباركود مرتبط بمنتج آخر");
      }
      setCol("barcode", barcode);
    }

    let price = live.price;
    if (b.price !== undefined) {
      price = Number(b.price);
      if (!Number.isFinite(price) || price < 0) throw httpError(400, "السعر غير صالح");
      setCol("price", price);
    }

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) throw httpError(400, "الاسم مطلوب");
      setCol("name", name);
    }
    if (b.name_en !== undefined) {
      setCol("name_en", b.name_en ? String(b.name_en).trim() : null);
    }

    let category = live.category;
    if (b.category !== undefined) {
      const next = normalizeCategoryName(b.category);
      if (next) {
        await ensureProductCategory(db, next);
        category = next;
      } else {
        category = null;
      }
      setCol("category", category);
    }

    let unit = live.unit;
    if (b.unit !== undefined) {
      unit = b.unit || null;
      if (unit) await ensureUnitName(db, unit);
    }
    let isWeighed = Number(live.is_weighed) || 0;
    if (b.is_weighed !== undefined) {
      isWeighed = b.is_weighed === 1 || b.is_weighed === true ? 1 : 0;
      setCol("is_weighed", isWeighed);
    }
    const unitForWeighed = isWeighed ? "كغم" : unit;
    if (b.unit !== undefined || (b.is_weighed !== undefined && isWeighed)) {
      if (unitForWeighed) await ensureUnitName(db, unitForWeighed);
      setCol("unit", unitForWeighed);
    }
    if (
      b.unit !== undefined &&
      !isWeighed &&
      Number(live.is_weighed) !== 1
    ) {
      await renameProductDisplayUnit(db, Number(id), {
        currentUnit: live.unit,
        nextUnit: unitForWeighed,
        isWeighed: false,
      });
    }

    if (b.expiry_date !== undefined) setCol("expiry_date", b.expiry_date || null);

    let cost = live.cost;
    if (b.cost !== undefined) {
      cost = Number(b.cost);
      if (!Number.isFinite(cost)) cost = 0;
      setCol("cost", cost);
    }

    if (b.tax_rate !== undefined) {
      const tax_rate = b.tax_rate !== null && b.tax_rate !== "" ? Number(b.tax_rate) : null;
      setCol("tax_rate", tax_rate);
    }
    if (b.min_price !== undefined) {
      setCol(
        "min_price",
        b.min_price != null && b.min_price !== "" ? Number(b.min_price) : null
      );
    }
    if (b.max_price !== undefined) {
      setCol(
        "max_price",
        b.max_price != null && b.max_price !== "" ? Number(b.max_price) : null
      );
    }

    if (b.sku !== undefined) {
      const sku = b.sku ? formatProductSku(String(b.sku).trim()) : live.sku;
      if (sku && sku !== live.sku) {
        const skuDup = await findSkuConflict(db, sku, Number(id));
        if (skuDup) throw httpError(409, "رقم المنتج مستخدم مسبقاً");
      }
      setCol("sku", sku);
    }

    if (b.image_url !== undefined) {
      setCol("image_url", b.image_url ? String(b.image_url).trim() : null);
    }
    if (b.inventory_scope !== undefined) {
      setCol("inventory_scope", parseInventoryScope(b.inventory_scope, live.inventory_scope || "retail"));
    }
    if (b.min_stock !== undefined) {
      setCol(
        "min_stock",
        b.min_stock !== null && b.min_stock !== "" ? Number(b.min_stock) : null
      );
    }

    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      await db.run(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    }

    if (b.barcode !== undefined && barcode && barcode !== live.barcode) {
      const existingPb = await db.get(
        "SELECT id FROM product_barcodes WHERE product_id = ? AND is_primary = 1",
        [id]
      );
      if (existingPb) {
        await db.run("UPDATE product_barcodes SET barcode = ? WHERE id = ?", [barcode, existingPb.id]);
      } else {
        await addProductBarcode(db, Number(id), barcode, { isPrimary: true });
      }
      await syncProductsPrimaryBarcode(db, Number(id));
      const units = await loadUnitsForProduct(db, Number(id));
      if (isWeighed) {
        const oldDigits = normalizeStoredBarcode(live.barcode);
        const packUnit = units.find((u) => {
          const ub = u.barcode ? normalizeStoredBarcode(u.barcode) : "";
          return ub && ub === oldDigits && String(u.unit_name || "") !== WEIGHED_BASE_UNIT_NAME;
        });
        if (packUnit) {
          await db.run("UPDATE product_units SET barcode = ?, updated_at = datetime('now') WHERE id = ?", [
            barcode,
            packUnit.id,
          ]);
        } else {
          const defaultUnit = units.find((u) => u.is_default) || units[0];
          if (
            defaultUnit &&
            (!defaultUnit.barcode ||
              normalizeStoredBarcode(defaultUnit.barcode) === oldDigits)
          ) {
            await db.run("UPDATE product_units SET barcode = ?, updated_at = datetime('now') WHERE id = ?", [
              barcode,
              defaultUnit.id,
            ]);
          }
        }
      } else {
        const defaultUnit = units.find((u) => u.is_default) || units[0];
        if (
          defaultUnit &&
          (!defaultUnit.barcode ||
            normalizeStoredBarcode(defaultUnit.barcode) === normalizeStoredBarcode(live.barcode))
        ) {
          await db.run("UPDATE product_units SET barcode = ?, updated_at = datetime('now') WHERE id = ?", [
            barcode,
            defaultUnit.id,
          ]);
        }
      }
    }

    const priceChanged = b.price !== undefined && round2(live.price) !== round2(price);
    const costChanged = b.cost !== undefined && round2(live.cost) !== round2(cost);
    if (priceChanged || costChanged) {
      const defaultUnit = await getDefaultUnit(db, Number(id));
      if (defaultUnit) {
        if (priceChanged) {
          await db.run("UPDATE product_units SET price = ?, updated_at = datetime('now') WHERE id = ?", [
            round2(price),
            defaultUnit.id,
          ]);
        }
        if (costChanged) {
          await db.run("UPDATE product_units SET cost = ?, updated_at = datetime('now') WHERE id = ?", [
            round2(cost),
            defaultUnit.id,
          ]);
        }
      }
    }

    const scaleParsed = parseScaleCodeInput(b.scale_code);
    if (scaleParsed.error) throw httpError(400, scaleParsed.error);
    const packPair = parseWeighedPackagePair(b);
    if (packPair.error) throw httpError(400, packPair.error);

    if (isWeighed) {
      const kgRow = await db.get(
        `SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?`,
        [Number(id), WEIGHED_BASE_UNIT_NAME]
      );
      if (scaleParsed.provided && scaleParsed.value) {
        await assertScaleCodeAvailable(db, scaleParsed.value, Number(id), kgRow?.id ?? null);
      }
      if (
        scaleParsed.provided &&
        scaleParsed.value &&
        barcode &&
        scaleParsed.value === barcode &&
        packPair.mode === "both"
      ) {
        throw httpError(400, "رمز الميزان يجب أن يختلف عن باركود الحبة");
      }
      const turnedOn = b.is_weighed !== undefined && isWeighed && Number(live.is_weighed) !== 1;
      if (turnedOn || scaleParsed.provided || packPair.mode !== "omit") {
        await ensureWeighedProductUnits(db, Number(id), {
          productBarcode: barcode,
          scaleCode: scaleParsed.provided ? scaleParsed.value : undefined,
          kgPrice: price,
          kgCost: cost,
          packageConversion: packPair.mode === "both" ? packPair.conversion : undefined,
          packageUnitName: b.package_unit_name,
          packagePrice: packPair.mode === "both" ? packPair.price : undefined,
        });
        if (packPair.mode === "none") {
          await disableWeighedPackageUnit(db, Number(id));
        }
      }
    }

    const updated = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (priceChanged) {
      await recordPriceChange(db, req, {
        productId: Number(id),
        oldPrice: live.price,
        newPrice: price,
        reason: b.reason != null && String(b.reason).trim() !== "" ? String(b.reason).trim() : "تعديل المنتج",
      });
    } else if (sets.length || scaleParsed.provided || packPair.mode !== "omit") {
      await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_UPDATE, "products", id, live, updated);
    }
    return withScaleCode(db, updated);
  });
}

function inventoryScopeClause(scope, alias) {
  if (!scope) return { sql: "", params: [] };
  const col = alias ? `${alias}.inventory_scope` : "inventory_scope";
  return { sql: ` AND COALESCE(${col}, 'retail') = ?`, params: [scope] };
}

/**
 * Admin catalogue filters for the paginated GET /products list.
 * POS `search`/`q` mode is handled separately and must stay unchanged.
 * @param {Record<string, unknown>} query
 * @param {string} [alias]
 */
function adminCatalogFilters(query, alias = "") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  let sql = "";
  const params = [];
  let needsBarcodeJoin = false;

  const category = String(query.category ?? "").trim();
  if (category === MISSING_CATALOG_FILTER) {
    sql += ` AND (${col("category")} IS NULL OR TRIM(${col("category")}) = '')`;
  } else if (category) {
    sql += ` AND ${col("category")} = ?`;
    params.push(category);
  }

  const unit = String(query.unit ?? "").trim();
  if (unit === MISSING_CATALOG_FILTER) {
    sql += ` AND (${col("unit")} IS NULL OR TRIM(${col("unit")}) = '')`;
  } else if (unit) {
    sql += ` AND ${col("unit")} = ?`;
    params.push(unit);
  }

  const activeRaw = query.is_active;
  if (activeRaw === "0" || activeRaw === "1" || activeRaw === 0 || activeRaw === 1) {
    sql += ` AND COALESCE(${col("is_active")}, 1) = ?`;
    params.push(Number(activeRaw));
  }

  const catalogSearch = String(query.catalog_search ?? "").trim();
  if (catalogSearch) {
    needsBarcodeJoin = true;
    const like = `%${catalogSearch}%`;
    const likeLower = `%${catalogSearch.toLowerCase()}%`;
    const skuValues = productSkuLookupValues(catalogSearch);
    const parts = [
      `LOWER(${col("name")}) LIKE ?`,
      `CAST(${col("barcode")} AS TEXT) LIKE ?`,
    ];
    const searchParams = [likeLower, like];
    if (skuValues.length) {
      parts.push(`${col("sku")} IN (${skuValues.map(() => "?").join(", ")})`);
      searchParams.push(...skuValues);
    } else {
      parts.push(`CAST(${col("sku")} AS TEXT) LIKE ?`);
      searchParams.push(like);
    }
    parts.push("pb.barcode LIKE ?");
    searchParams.push(like);
    sql += ` AND (${parts.join(" OR ")})`;
    params.push(...searchParams);
  }

  return { sql, params, needsBarcodeJoin };
}

export async function searchProducts(db, rawQuery, options = {}) {
  const normalized = normalizeBarcodeInput(String(rawQuery ?? "").trim());
  if (!normalized) return null;

  const scope = options.scope ? parseInventoryScope(options.scope) : null;
  const { sql: scopeSql, params: scopeParams } = inventoryScopeClause(scope, "p");
  const scopeSqlPlain = scope ? " AND COALESCE(inventory_scope, 'retail') = ?" : "";
  const scopeParamsPlain = scope ? [scope] : [];
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));

  const like = `%${normalized}%`;
  const likeLower = `%${normalized.toLowerCase()}%`;

  console.info(`[products-search] q=${JSON.stringify(normalized)} joinsProductBarcodes=true scope=${scope ?? "all"}`);

  /** @type {Map<number, object>} */
  const byId = new Map();

  if (/^\d+$/.test(normalized)) {
    const fromUnits = await db.all(
      `SELECT DISTINCT ${PRODUCT_LIST_SELECT_P},
              pu.barcode AS matched_barcode, pu.unit_name AS matched_barcode_label,
              pu.id AS unit_id, pu.price AS unit_price, pu.conversion_to_base
       FROM product_units pu
       JOIN products p ON p.id = pu.product_id
       WHERE pu.barcode = ?${scopeSql}`,
      [normalized, ...scopeParams]
    );
    for (const row of fromUnits) {
      byId.set(row.id, { ...row, price: row.unit_price ?? row.price });
    }

    const fromPb = await db.all(
      `SELECT ${PRODUCT_LIST_SELECT_P},
              pb.barcode AS matched_barcode, pb.label AS matched_barcode_label
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?${scopeSql}`,
      [normalized, ...scopeParams]
    );
    for (const row of fromPb) {
      byId.set(row.id, row);
    }

    if (!byId.size) {
      const fromPrimary = await db.all(
        `SELECT ${PRODUCT_LIST_SELECT},
                CAST(barcode AS TEXT) AS matched_barcode, 'أساسي' AS matched_barcode_label
         FROM products
         WHERE CAST(barcode AS TEXT) = ?${scopeSqlPlain}`,
        [normalized, ...scopeParamsPlain]
      );
      for (const row of fromPrimary) {
        byId.set(row.id, row);
      }
    }

    const skuValues = productSkuLookupValues(normalized);
    if (skuValues.length) {
      const skuPlaceholders = skuValues.map(() => "?").join(", ");
      const fromSku = await db.all(
        `SELECT ${PRODUCT_LIST_SELECT_P}
         FROM products p
         WHERE p.sku IN (${skuPlaceholders})${scopeSql}`,
        [...skuValues, ...scopeParams]
      );
      for (const row of fromSku) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
    }
  }

  const skuQuery = /^\d+$/.test(normalized) ? parseNumericCode(normalized) : null;
  const hasExactSku = skuQuery != null
    && [...byId.values()].some((row) => parseNumericCode(row.sku) === skuQuery);

  // A الرقم query like "4" must not also pull barcodes that merely contain the digit 4.
  if (!hasExactSku) {
    const likeRows = await db.all(
      `SELECT DISTINCT ${PRODUCT_LIST_SELECT_P}
       FROM products p
       LEFT JOIN product_barcodes pb ON pb.product_id = p.id
       WHERE (p.name LIKE ?
          OR CAST(p.barcode AS TEXT) LIKE ?
          OR pb.barcode LIKE ?)${scopeSql}
       ORDER BY p.name ASC
       LIMIT ?`,
      [likeLower, like, like, ...scopeParams, limit]
    );

    for (const row of likeRows) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }

  const rows = [...byId.values()]
    .sort((a, b) => {
      if (skuQuery != null) {
        const aExact = parseNumericCode(a.sku) === skuQuery;
        const bExact = parseNumericCode(b.sku) === skuQuery;
        if (aExact !== bExact) return aExact ? -1 : 1;
        const aSku = parseNumericCode(a.sku);
        const bSku = parseNumericCode(b.sku);
        if (aSku != null && bSku != null && aSku !== bSku) return aSku - bSku;
      }
      return String(a.name ?? "").localeCompare(String(b.name ?? ""), "ar");
    })
    .slice(0, limit);
  return rows;
}

export function createProductsRouter(db) {
  const router = Router();

  async function loadProductById(id) {
    const pid = parsePositiveInt(id);
    if (!pid) return null;
    return db.get("SELECT * FROM products WHERE id = ?", [pid]);
  }

  router.get("/", requireAuth, async (req, res) => {
    const scope = req.query.scope ? parseInventoryScope(req.query.scope) : null;
    const searchTerm = String(req.query.search ?? req.query.q ?? "").trim();
    if (searchTerm) {
      const searchLimit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const rows = await searchProducts(db, searchTerm, {
        scope: scope || undefined,
        limit: searchLimit,
      });
      return res.json(rows ?? []);
    }

    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ success: false, error: "للمسؤول فقط", code: "FORBIDDEN" });
    }

    const { sql: scopeSql, params: scopeParams } = inventoryScopeClause(scope);
    const idsParam = String(req.query.ids ?? "").trim();
    if (idsParam) {
      const ids = idsParam
        .split(",")
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 100);
      if (ids.length === 0) return res.json([]);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await db.all(
        `SELECT ${PRODUCT_LIST_SELECT}
         FROM products WHERE id IN (${placeholders})${scopeSql}`,
        [...ids, ...scopeParams]
      );
      return res.json(rows);
    }

    if (String(req.query.fields || "") === "id") {
      const rows = await db.all(
        `SELECT id FROM products WHERE 1=1${scopeSql} ORDER BY CAST(sku AS INTEGER) ASC, id ASC LIMIT 5000`,
        scopeParams
      );
      return res.json(rows);
    }

    // Always paginate. This used to return the entire table when the client sent
    // no limit, which is megabytes of JSON at a few thousand SKUs and the single
    // largest payload in the app. Clients that genuinely need everything — the
    // CSV export — still pass limit=all.
    const { limit, offset } = parsePagination(
      req.query,
      DEFAULT_PRODUCT_PAGE_SIZE,
      MAX_PRODUCT_PAGE_SIZE
    );
    const needsJoin = String(req.query.catalog_search ?? "").trim() !== "";
    const alias = needsJoin ? "p" : "";
    const catalogFilters = adminCatalogFilters(req.query, alias);
    const scoped = needsJoin ? inventoryScopeClause(scope, "p") : { sql: scopeSql, params: scopeParams };
    const reviewCol = alias ? "p.needs_review" : "needs_review";
    const skuCol = alias ? "p.sku" : "sku";
    const idCol = alias ? "p.id" : "id";
    let whereSql = `WHERE 1=1${scoped.sql}${catalogFilters.sql}`;
    const params = [...scoped.params, ...catalogFilters.params];
    if (req.query.needs_review === "1" || req.query.needs_review === "true") {
      whereSql += ` AND COALESCE(${reviewCol}, 0) = 1`;
    }
    const fromSql = needsJoin
      ? "FROM products p LEFT JOIN product_barcodes pb ON pb.product_id = p.id"
      : "FROM products";
    const countSql = needsJoin
      ? `SELECT COUNT(DISTINCT p.id) AS total ${fromSql} ${whereSql}`
      : `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`;
    const selectSql = needsJoin
      ? `SELECT DISTINCT ${PRODUCT_LIST_SELECT_P} ${fromSql} ${whereSql} ORDER BY CAST(${skuCol} AS INTEGER) ASC, ${idCol} ASC LIMIT ? OFFSET ?`
      : `SELECT ${PRODUCT_LIST_SELECT} ${fromSql} ${whereSql} ORDER BY CAST(${skuCol} AS INTEGER) ASC, ${idCol} ASC LIMIT ? OFFSET ?`;
    const countRow = await db.get(countSql, params);
    const rows = await db.all(selectSql, [...params, limit, offset]);
    return res.json({
      items: rows,
      total: Number(countRow?.total) || 0,
      limit,
      offset,
    });
  });

  router.get("/by-barcode/:barcode", requireAuth, async (req, res) => {
    const barcode = normalizeBarcodeInput(decodeURIComponent(req.params.barcode));
    const payload = await buildBarcodeLookupResponse(db, barcode);
    if (!payload) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    if (payload.inactive) {
      return res.status(404).json({ error: "المنتج غير متاح", code: "PRODUCT_INACTIVE" });
    }
    return res.json(payload);
  });

  function sendCategoryError(res, e) {
    const status = Number(e?.status) || 500;
    return res.status(status).json({
      error: e?.message || "خطأ",
      code: e?.code || "ERROR",
    });
  }

  router.get("/categories", requireAuth, async (req, res) => {
    const activeOnly =
      req.query.active === "1" ||
      req.query.active === "true" ||
      String(req.query.active || "").toLowerCase() === "yes";
    res.setHeader("Cache-Control", "no-store");
    return res.json(await listProductCategories(db, { activeOnly }));
  });

  router.post("/categories", requireAuth, requireAdmin, async (req, res) => {
    try {
      const row = await createProductCategory(db, req.body?.name);
      res.status(201).json(row);
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.put("/categories/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const row = await updateProductCategory(db, req.params.id, req.body || {});
      res.json(row);
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.delete("/categories/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await deleteProductCategory(db, req.params.id));
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.get("/unit-names", requireAuth, async (req, res) => {
    const activeOnly =
      req.query.active === "1" ||
      req.query.active === "true" ||
      String(req.query.active || "").toLowerCase() === "yes";
    res.setHeader("Cache-Control", "no-store");
    return res.json(await listUnitNames(db, { activeOnly }));
  });

  router.post("/unit-names", requireAuth, requireAdmin, async (req, res) => {
    try {
      const row = await createUnitName(db, req.body?.name);
      res.status(201).json(row);
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.put("/unit-names/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const row = await updateUnitName(db, req.params.id, req.body || {});
      res.json(row);
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.delete("/unit-names/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await deleteUnitName(db, req.params.id));
    } catch (e) {
      if (e?.status) return sendCategoryError(res, e);
      throw e;
    }
  });

  router.get("/units/catalog", requireAuth, requireAdmin, async (req, res) => {
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const search = String(req.query.search ?? req.query.q ?? "").trim();
    const payload = await loadUnitsCatalog(db, { search, limit, offset });
    res.json(payload);
  });

  router.get("/barcode-check", requireAuth, requireAdmin, async (req, res) => {
    const productId = parsePositiveInt(req.query.product_id ?? req.query.productId);
    if (!productId) {
      return res.status(400).json({ error: "معرّف المنتج مطلوب", code: "VALIDATION_ERROR" });
    }
    const barcode = String(req.query.barcode ?? "").trim();
    const unitId = parsePositiveInt(req.query.unit_id ?? req.query.unitId);
    const result = await checkUnitBarcodeAvailability(db, {
      barcode,
      productId,
      excludeUnitId: unitId,
    });
    res.json(result);
  });

  async function sendNextSku(_req, res) {
    try {
      const sku = await getNextProductNumber(db);
      return res.json({ sku });
    } catch (e) {
      console.error("[products-next-sku]", e);
      return res.status(500).json({ error: "تعذّر توليد رقم مقترح" });
    }
  }

  router.get("/next-sku", requireAuth, requireAdmin, sendNextSku);
  /** @deprecated Use /next-sku — this never returns a barcode. */
  router.get("/next-barcode", requireAuth, requireAdmin, sendNextSku);

  /**
   * Duplicate-check for the admin add-product form. Always 200 so Chrome
   * does not log "Failed to load resource" for a free barcode.
   * POS / checkout still use GET /:barcode and GET /by-barcode/:barcode (404).
   */
  router.get("/lookup", requireAuth, async (req, res) => {
    const barcode = normalizeBarcodeInput(String(req.query.barcode || ""));
    if (!barcode) {
      return res.json({ found: false });
    }

    const payload = await buildBarcodeLookupResponse(db, barcode);
    if (payload) {
      return res.json({
        found: true,
        inactive: Boolean(payload.inactive),
        ...payload,
      });
    }

    const found = await findProductByBarcode(db, barcode);
    if (!found) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      inactive: Number(found.product.is_active) === 0,
      ...flatBarcodeLookupFields(found),
    });
  });

  router.get("/:barcode", requireAuth, async (req, res) => {
    const barcode = normalizeBarcodeInput(decodeURIComponent(req.params.barcode));
    const payload = await buildBarcodeLookupResponse(db, barcode);
    if (!payload) {
      const found = await findProductByBarcode(db, barcode);
      if (!found) {
        return res.status(404).json({ error: "المنتج غير موجود" });
      }
      if (Number(found.product.is_active) === 0) {
        return res.status(404).json({ error: "المنتج غير متاح", code: "PRODUCT_INACTIVE" });
      }
      return res.json(flatBarcodeLookupFields(found));
    }
    if (payload.inactive) {
      return res.status(404).json({ error: "المنتج غير متاح", code: "PRODUCT_INACTIVE" });
    }
    res.json(payload);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const { barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku, image_url, min_stock } = req.body || {};
    const inventoryScope = parseInventoryScope(req.body?.inventory_scope, "retail");
    const isBakery = inventoryScope === "bakery";
    const isWeighed = req.body?.is_weighed === 1 || req.body?.is_weighed === true ? 1 : 0;
    const resolvedBarcode = normalizeStoredBarcode(barcode);
    if (!resolvedBarcode) {
      return res.status(400).json({ error: "الباركود مطلوب" });
    }
    if (!isValidStoredBarcode(resolvedBarcode)) {
      return res.status(400).json({ error: "باركود غير صالح" });
    }
    if (!name || stock === undefined) {
      return res.status(400).json({ error: "الباركود والاسم والمخزون مطلوبة" });
    }
    if (!isBakery && price === undefined) {
      return res.status(400).json({ error: "الباركود والاسم والسعر والمخزون مطلوبة" });
    }
    const finalPrice = price !== undefined && price !== null && price !== "" ? Number(price) : 0;
    if (!Number.isFinite(finalPrice) || finalPrice < 0) {
      return res.status(400).json({ error: "السعر غير صالح" });
    }
    const barcodeDup = await db.get(
      `SELECT id FROM products WHERE barcode = ?
       UNION
       SELECT product_id AS id FROM product_units WHERE barcode = ?
       UNION
       SELECT product_id AS id FROM product_barcodes WHERE barcode = ?
       LIMIT 1`,
      [resolvedBarcode, resolvedBarcode, resolvedBarcode]
    );
    if (barcodeDup) {
      return res.status(409).json({ error: "هذا الباركود مرتبط بمنتج آخر" });
    }
    if (sku) {
      const skuDup = await findSkuConflict(db, sku);
      if (skuDup) {
        return res.status(409).json({ error: "رقم المنتج مستخدم مسبقاً" });
      }
    }
    const c = cost !== undefined ? Number(cost) : 0;
    const taxR = tax_rate !== undefined && tax_rate !== null && tax_rate !== "" ? Number(tax_rate) : null;
    if (taxR !== null && (!Number.isFinite(taxR) || taxR < 0 || taxR > 1)) {
      return res.status(400).json({ error: "نسبة الضريبة يجب أن تكون بين 0 و 1" });
    }
    const scaleParsed = parseScaleCodeInput(req.body?.scale_code);
    if (scaleParsed.error) {
      return res.status(400).json({ error: scaleParsed.error });
    }
    const packPair = parseWeighedPackagePair(req.body || {});
    if (isWeighed && packPair.error) {
      return res.status(400).json({ error: packPair.error });
    }
    if (
      isWeighed &&
      scaleParsed.value &&
      scaleParsed.value === resolvedBarcode &&
      packPair.mode === "both"
    ) {
      return res.status(400).json({ error: "رمز الميزان يجب أن يختلف عن باركود الحبة" });
    }
    if (isWeighed && scaleParsed.value && scaleParsed.value !== resolvedBarcode) {
      const scaleDup = await db.get(
        `SELECT id FROM products WHERE barcode = ?
         UNION
         SELECT product_id AS id FROM product_units WHERE barcode = ?
         UNION
         SELECT product_id AS id FROM product_barcodes WHERE barcode = ?
         LIMIT 1`,
        [scaleParsed.value, scaleParsed.value, scaleParsed.value]
      );
      if (scaleDup) {
        return res.status(409).json({ error: "رمز الميزان مرتبط بمنتج آخر" });
      }
    }
    const needsReview = req.body?.needs_review === 1 || req.body?.needs_review === true ? 1 : 0;
    try {
      const row = await withTransaction(db, async () => {
        const skuCode = formatProductSku(await ensureEntityCode(db, "product", sku));
        const unitName = isWeighed ? WEIGHED_BASE_UNIT_NAME : unit ? String(unit).trim() : null;
        if (unitName) await ensureUnitName(db, unitName);
        let finalCategory = normalizeCategoryName(category);
        if (finalCategory) {
          await ensureProductCategory(db, finalCategory);
        } else if (isBakery) {
          await ensureProductCategory(db, BAKERY_CATEGORY_NAME);
          finalCategory = BAKERY_CATEGORY_NAME;
        } else {
          finalCategory = null;
        }
        const minStockVal =
          min_stock !== undefined && min_stock !== null && min_stock !== ""
            ? Number(min_stock)
            : null;
        const info = await db.run(
          `INSERT INTO products (barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku, image_url, is_weighed, inventory_scope, min_stock, needs_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resolvedBarcode,
            String(name).trim(),
            name_en ? String(name_en).trim() : null,
            finalPrice,
            c,
            finalCategory,
            clampProductStock(stock),
            taxR,
            unitName,
            expiry_date ? String(expiry_date).trim() : null,
            min_price != null && min_price !== "" ? Number(min_price) : null,
            max_price != null && max_price !== "" ? Number(max_price) : null,
            skuCode,
            image_url ? String(image_url).trim() : null,
            isWeighed,
            inventoryScope,
            Number.isFinite(minStockVal) ? minStockVal : null,
            needsReview,
          ]
        );
        await ensureProductBarcodeOnCreate(db, info.lastID, resolvedBarcode);
        if (isWeighed) {
          await ensureWeighedProductUnits(db, info.lastID, {
            productBarcode: resolvedBarcode,
            scaleCode: scaleParsed.provided ? scaleParsed.value : undefined,
            kgPrice: finalPrice,
            kgCost: c,
            packageConversion: packPair.mode === "both" ? packPair.conversion : undefined,
            packageUnitName: req.body?.package_unit_name || DEFAULT_PACKAGE_UNIT_NAME,
            packagePrice: packPair.mode === "both" ? packPair.price : undefined,
          });
        } else {
          await upsertProductUnit(db, info.lastID, {
            unit_name: unitName || DEFAULT_PACKAGE_UNIT_NAME,
            barcode: resolvedBarcode,
            price: finalPrice,
            cost: c,
            conversion_to_base: 1,
            is_default: true,
            sale_enabled: !isBakery,
            purchase_enabled: true,
            is_default_purchase: true,
          });
        }
        const created = await db.get("SELECT * FROM products WHERE id = ?", [info.lastID]);
        await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_CREATE, "products", created.id, null, { name: created.name, price: created.price, stock: created.stock });
        if (Number(created.price) > 0) {
          await recordPriceChange(db, req, {
            productId: created.id,
            oldPrice: null,
            newPrice: Number(created.price),
            reason: "السعر الأولي عند إنشاء المنتج",
          });
        }
        return withScaleCode(db, created);
      });
      let nextSku = null;
      try {
        nextSku = await getNextProductNumber(db);
      } catch {
        nextSku = null;
      }
      res.status(201).json(nextSku ? { ...row, next_sku: nextSku } : row);
    } catch (e) {
      if (e?.status === 400 || e?.status === 409) {
        return res.status(e.status).json({ error: e.message });
      }
      if (skuConstraintError(e)) {
        return res.status(409).json({ error: "رقم المنتج مستخدم مسبقاً" });
      }
      if (isSqliteConstraint(e)) {
        return res.status(409).json({ error: "الباركود موجود مسبقاً" });
      }
      throw e;
    }
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const row = await applyProductMetadataPatch(db, req, req.params.id, req.body || {});
      res.json(row);
    } catch (e) {
      if (e?.status === 404) {
        return res.status(404).json({ error: e.message });
      }
      if (e?.status === 400 || e?.status === 409) {
        return res.status(e.status).json({ error: e.message });
      }
      if (skuConstraintError(e)) {
        return res.status(409).json({ error: "رقم المنتج مستخدم مسبقاً" });
      }
      if (isSqliteConstraint(e)) {
        return res.status(409).json({ error: "الباركود موجود مسبقاً" });
      }
      throw e;
    }
  });

  router.patch("/:id/active", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح", code: "VALIDATION_ERROR" });
    const existing = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const nextActive = req.body?.is_active === 0 || req.body?.is_active === false ? 0 : 1;
    await db.run("UPDATE products SET is_active = ? WHERE id = ?", [nextActive, id]);
    const row = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_UPDATE, "products", id, existing, row);
    res.json(row);
  });

  // ════════════════════ Product units (admin-only) ════════════════════

  router.get("/:id/units", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const units = await loadUnitsForProduct(db, product.id);
    res.json({ product_id: product.id, units });
  });

  router.get("/:id/last-purchase-cost", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const row = await db.get(
      `SELECT pii.unit_cost, pii.product_unit_id, pii.unit_name, pi.invoice_date
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC LIMIT 1`,
      [product.id]
    );

    res.json({
      product_id: product.id,
      sell_price: round2(product.price),
      min_price: product.min_price ?? null,
      max_price: product.max_price ?? null,
      last_purchase: row
        ? {
            unit_cost: round2(row.unit_cost),
            product_unit_id: row.product_unit_id ?? null,
            unit_name: row.unit_name ?? null,
            invoice_date: row.invoice_date ?? null,
          }
        : null,
    });
  });

  router.post("/:id/units", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    if (!b.barcode) return res.status(400).json({ error: "الباركود مطلوب" });
    try {
      const row = await upsertProductUnit(db, product.id, {
        unit_name: b.unit_name || b.unitName,
        barcode: b.barcode,
        price: b.price ?? product.price,
        cost: b.cost ?? product.cost,
        conversion_to_base: b.conversion_to_base ?? 1,
        is_default: b.is_default === true,
        purchase_enabled: b.purchase_enabled,
        is_default_purchase: b.is_default_purchase,
        sale_enabled: b.sale_enabled,
        alias_barcodes: b.alias_barcodes,
      });
      res.status(201).json(formatProductUnit(row));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  router.put("/:id/units/:unitId", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const unitId = parsePositiveInt(req.params.unitId);
    if (!unitId) return res.status(400).json({ error: "معرّف غير صالح" });
    const existing = await db.get("SELECT * FROM product_units WHERE id = ? AND product_id = ?", [
      unitId,
      product.id,
    ]);
    if (!existing) return res.status(404).json({ error: "الوحدة غير موجودة" });
    const b = req.body || {};
    try {
      const row = await upsertProductUnit(db, product.id, {
        unit_name: b.unit_name ?? existing.unit_name,
        barcode: b.barcode ?? existing.barcode,
        price: b.price ?? existing.price,
        cost: b.cost ?? existing.cost,
        conversion_to_base: b.conversion_to_base ?? existing.conversion_to_base,
        is_default: b.is_default === true || Number(existing.is_default) === 1,
        purchase_enabled: b.purchase_enabled,
        is_default_purchase: b.is_default_purchase,
        sale_enabled: b.sale_enabled,
      });
      if (b.is_default === true) {
        await db.run("UPDATE product_units SET is_default = 0 WHERE product_id = ? AND id != ?", [
          product.id,
          unitId,
        ]);
        await db.run("UPDATE product_units SET is_default = 1 WHERE id = ?", [unitId]);
        await syncProductFromDefaultUnit(db, product.id);
      }
      res.json(formatProductUnit(row));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  router.delete("/:id/units/:unitId", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const unitId = parsePositiveInt(req.params.unitId);
    if (!unitId) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      await deleteProductUnit(db, product.id, unitId);
      res.json({ success: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // ════════════════════ Product barcodes (admin-only) ════════════════════

  router.get("/:id/barcodes", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT id, product_id, barcode, label, is_primary, created_at
       FROM product_barcodes WHERE product_id = ?
       ORDER BY is_primary DESC, id ASC`,
      [product.id]
    );
    res.json({ product_id: product.id, barcodes: rows });
  });

  router.post("/:id/barcodes", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { barcode, label } = req.body || {};
    if (!barcode) return res.status(400).json({ error: "الباركود مطلوب" });
    try {
      const result = await addProductBarcode(db, product.id, barcode, {
        label: label ?? null,
        isPrimary: false,
      });
      if (result.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, id: result.id, barcode: result.barcode });
      }
      const row = await db.get("SELECT * FROM product_barcodes WHERE id = ?", [result.id]);
      res.status(201).json(row);
    } catch (e) {
      if (e.status === 409) {
        return res.status(409).json({
          error: e.message,
          existing_product_id: e.existingProductId,
          existing_product_name: e.existingProductName,
        });
      }
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  router.delete("/:id/barcodes/:barcodeId", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const barcodeId = parsePositiveInt(req.params.barcodeId);
    if (!barcodeId) return res.status(400).json({ error: "معرّف غير صالح" });
    const pb = await db.get(
      "SELECT * FROM product_barcodes WHERE id = ? AND product_id = ?",
      [barcodeId, product.id]
    );
    if (!pb) return res.status(404).json({ error: "الباركود غير موجود" });
    const count = await db.get(
      "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?",
      [product.id]
    );
    if (Number(count.n) <= 1) {
      return res.status(400).json({ error: "لا يمكن حذف آخر باركود للمنتج" });
    }
    await db.run("DELETE FROM product_barcodes WHERE id = ?", [barcodeId]);
    if (Number(pb.is_primary) === 1) {
      const next = await db.get(
        "SELECT id FROM product_barcodes WHERE product_id = ? ORDER BY id ASC LIMIT 1",
        [product.id]
      );
      if (next) {
        await db.run("UPDATE product_barcodes SET is_primary = 1 WHERE id = ?", [next.id]);
        await syncProductsPrimaryBarcode(db, product.id);
      }
    }
    res.status(204).send();
  });

  router.patch("/:id/barcodes/:barcodeId/primary", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const barcodeId = parsePositiveInt(req.params.barcodeId);
    if (!barcodeId) return res.status(400).json({ error: "معرّف غير صالح" });
    const pb = await db.get(
      "SELECT * FROM product_barcodes WHERE id = ? AND product_id = ?",
      [barcodeId, product.id]
    );
    if (!pb) return res.status(404).json({ error: "الباركود غير موجود" });
    await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [product.id]);
    await db.run("UPDATE product_barcodes SET is_primary = 1 WHERE id = ?", [barcodeId]);
    await syncProductsPrimaryBarcode(db, product.id);
    const rows = await db.all(
      "SELECT id, product_id, barcode, label, is_primary, created_at FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, id ASC",
      [product.id]
    );
    res.json({ product_id: product.id, barcodes: rows });
  });

  // ════════════════════ Product 360 Dashboard (admin-only) ════════════════════

  router.get("/:id/dashboard", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const pid = product.id;

    const today = shopTodayYmd();
    const monthStart = `${today.slice(0, 8)}01`;

    const todayRow = await db.get(
      `SELECT COALESCE(SUM(ti.line_gross),0) AS revenue, COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed' AND date(t.created_at) = ?`,
      [pid, today]
    );
    const monthRow = await db.get(
      `SELECT COALESCE(SUM(ti.line_gross),0) AS revenue, COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed' AND date(t.created_at) >= ?`,
      [pid, monthStart]
    );
    const totalsRow = await db.get(
      `SELECT COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'`,
      [pid]
    );
    const lastPurchase = await db.get(
      `SELECT pii.unit_cost
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC LIMIT 1`,
      [pid]
    );
    const supplierRow = await db.get(
      `SELECT COUNT(DISTINCT pi.supplier_id) AS n
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ?`,
      [pid]
    );
    const priceChangeRow = await db.get(
      "SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?",
      [pid]
    );

    const stock = Number(product.stock) || 0;
    const price = Number(product.price) || 0;
    const avgCost = Number(product.cost) || 0;
    const withScale = await withScaleCode(db, product);

    const barcodeCount = await db.get(
      "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?",
      [pid]
    );
    res.json({
      product: {
        id: product.id,
        barcode: product.barcode,
        barcode_count: Number(barcodeCount?.n) || 0,
        sku: product.sku ?? null,
        name: product.name,
        name_en: product.name_en ?? null,
        image_url: product.image_url ?? null,
        category: product.category ?? null,
        unit: product.unit ?? null,
        is_active: Number(product.is_active ?? 1),
        is_weighed: Number(product.is_weighed) === 1 ? 1 : 0,
        scale_code: withScale.scale_code ?? null,
        package_price: withScale.package_price ?? null,
        package_conversion: withScale.package_conversion ?? null,
        tax_rate: product.tax_rate ?? null,
        expiry_date: product.expiry_date ?? null,
        min_price: product.min_price ?? null,
        max_price: product.max_price ?? null,
        stock,
        price,
        cost: avgCost,
      },
      summary: {
        current_stock: stock,
        today_sales: round2(todayRow?.revenue),
        today_qty: round2(todayRow?.qty),
        month_sales: round2(monthRow?.revenue),
        month_qty: round2(monthRow?.qty),
        total_qty_sold: round2(totalsRow?.qty),
        current_price: price,
        average_cost: avgCost,
        last_purchase_cost: lastPurchase ? round2(lastPurchase.unit_cost) : null,
        profit_margin_pct: marginPct(price, avgCost),
        estimated_gross_profit: round2(stock * (price - avgCost)),
        inventory_value: round2(stock * avgCost),
        supplier_count: Number(supplierRow?.n) || 0,
        price_changes: Number(priceChangeRow?.n) || 0,
      },
    });
  });

  router.get("/:id/overview", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const warehouses = await db.all(
      `SELECT w.id AS warehouse_id, w.name AS warehouse_name, w.code, w.type, ws.quantity
       FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
       WHERE ws.product_id = ? AND ws.quantity != 0
       ORDER BY w.name`,
      [product.id]
    );

    let daysUntilExpiry = null;
    if (product.expiry_date) {
      const row = await db.get(
        "SELECT CAST(julianday(?) - julianday('now') AS INTEGER) AS d",
        [product.expiry_date]
      );
      daysUntilExpiry = row?.d ?? null;
    }

    const stock = Number(product.stock) || 0;
    const withScale = await withScaleCode(db, product);
    res.json({
      basic: {
        id: product.id,
        barcode: product.barcode,
        sku: product.sku ?? null,
        name: product.name,
        name_en: product.name_en ?? null,
        category: product.category ?? null,
        unit: product.unit ?? null,
        tax_rate: product.tax_rate ?? null,
        is_weighed: Number(product.is_weighed) === 1 ? 1 : 0,
        scale_code: withScale.scale_code ?? null,
        package_price: withScale.package_price ?? null,
        package_conversion: withScale.package_conversion ?? null,
      },
      inventory: {
        current_stock: stock,
        inventory_value: round2(stock * (Number(product.cost) || 0)),
        low_stock: stock <= 10,
        out_of_stock: stock <= 0,
      },
      pricing: {
        current_price: Number(product.price) || 0,
        average_cost: Number(product.cost) || 0,
        min_price: product.min_price ?? null,
        max_price: product.max_price ?? null,
        margin_pct: marginPct(product.price, product.cost),
      },
      expiry: {
        expiry_date: product.expiry_date ?? null,
        days_until_expiry: daysUntilExpiry,
      },
      warehouses,
    });
  });

  router.get("/:id/price-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT ph.id, ph.old_price, ph.new_price,
              ROUND(ph.new_price - COALESCE(ph.old_price, ph.new_price), 2) AS difference,
              ph.reason, ph.created_at,
              u.username AS changed_by
       FROM product_price_history ph
       LEFT JOIN users u ON u.id = ph.changed_by_user_id
       WHERE ph.product_id = ?
       ORDER BY ph.created_at DESC, ph.id DESC`,
      [product.id]
    );
    res.json({ product_id: product.id, product_name: product.name, current_price: Number(product.price) || 0, rows });
  });

  router.get("/:id/sales-by-price", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const dateFrom = parseDateParam(req.query.date_from);
    const dateTo = parseDateParam(req.query.date_to);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({ error: "date_from يجب أن يسبق date_to", code: "VALIDATION_ERROR" });
    }
    const includeRefunds = req.query.include_refunds === undefined
      ? true
      : !["false", "0"].includes(String(req.query.include_refunds).toLowerCase());

    const { rows, summary } = await getSalesByPrice(
      db,
      product.id,
      { dateFrom, dateTo },
      includeRefunds
    );
    for (const r of rows) {
      r.product_id = product.id;
      r.product_name = product.name;
    }
    res.json({ product_id: product.id, product_name: product.name, rows, summary });
  });

  router.get("/:id/supplier-prices", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const rows = await db.all(
      `SELECT s.id AS supplier_id, s.name AS supplier_name,
              COUNT(DISTINCT pi.id) AS purchase_count,
              ROUND(SUM(pii.quantity), 3) AS total_quantity,
              ROUND(SUM(pii.unit_cost * pii.quantity) / NULLIF(SUM(pii.quantity), 0), 2) AS avg_cost,
              ROUND(MIN(pii.unit_cost), 2) AS min_cost,
              ROUND(MAX(pii.unit_cost), 2) AS max_cost,
              MAX(pi.invoice_date) AS last_purchase_date,
              (SELECT pii2.unit_cost FROM purchase_invoice_items pii2
                 JOIN purchase_invoices pi2 ON pi2.id = pii2.invoice_id AND pi2.status = 'posted'
                 WHERE pii2.product_id = ? AND pi2.supplier_id = s.id
                 ORDER BY pi2.invoice_date DESC, pi2.id DESC LIMIT 1) AS last_purchase_cost,
              (SELECT pi3.invoice_no FROM purchase_invoice_items pii3
                 JOIN purchase_invoices pi3 ON pi3.id = pii3.invoice_id AND pi3.status = 'posted'
                 WHERE pii3.product_id = ? AND pi3.supplier_id = s.id
                 ORDER BY pi3.invoice_date DESC, pi3.id DESC LIMIT 1) AS invoice_number
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.product_id = ?
       GROUP BY s.id, s.name
       ORDER BY avg_cost ASC, s.name`,
      [product.id, product.id, product.id]
    );

    let bestAvg = null;
    for (const r of rows) {
      if (r.avg_cost != null && (bestAvg === null || r.avg_cost < bestAvg)) bestAvg = r.avg_cost;
    }
    for (const r of rows) {
      r.last_purchase_cost = r.last_purchase_cost != null ? round2(r.last_purchase_cost) : null;
      r.is_best = bestAvg !== null && r.avg_cost === bestAvg;
    }

    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/supplier-prices/:supplierId/history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const supplierId = parsePositiveInt(req.params.supplierId);
    if (!supplierId) return res.status(400).json({ error: "معرف المورد غير صالح", code: "VALIDATION_ERROR" });

    const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
    const rows = await db.all(
      `SELECT pi.id AS invoice_id, pi.invoice_no AS invoice_number, pi.invoice_date,
              pii.quantity, pii.unit_cost, pii.line_total
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ? AND pi.supplier_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC`,
      [product.id, supplierId]
    );
    res.json({ product_id: product.id, supplier_id: supplierId, supplier_name: supplier?.name ?? null, rows });
  });

  router.get("/:id/purchase-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT pi.id AS invoice_id, pi.invoice_no AS invoice_number, pi.invoice_date,
              pi.supplier_id, s.name AS supplier_name,
              pii.quantity, pii.unit_cost, pii.line_total
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.product_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/inventory-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT l.id, l.movement_type, l.quantity_delta, l.qty_before, l.qty_after,
              l.reference_type, l.reference_id, l.notes, l.created_at,
              u.username AS user_name,
              CASE
                WHEN l.reference_type = 'inventory_receipt'
                  THEN 'سند إدخال بضاعة #' || d.document_number
                WHEN l.reference_type = 'inventory_issue'
                  THEN 'سند إخراج بضاعة #' || d.document_number
                WHEN l.reference_type = 'inventory_document' AND d.document_type = 'receipt'
                  THEN 'سند إدخال بضاعة #' || d.document_number
                WHEN l.reference_type = 'inventory_document' AND d.document_type = 'issue'
                  THEN 'سند إخراج بضاعة #' || d.document_number
                ELSE NULL
              END AS reference_label
       FROM inventory_ledger l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN inventory_documents d
         ON d.id = l.reference_id
        AND l.reference_type IN ('inventory_document', 'inventory_receipt', 'inventory_issue')
       WHERE l.product_id = ?
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/profit-analysis", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const series = await db.all(
      `SELECT date(t.created_at) AS day,
              ROUND(SUM(ti.line_gross), 2) AS revenue,
              ROUND(SUM(COALESCE(ti.gross_profit, 0)), 2) AS profit,
              ROUND(SUM(ti.quantity), 3) AS quantity,
              ROUND(SUM(ti.unit_cost_at_sale * ti.quantity), 2) AS cost,
              ROUND(SUM(ti.unit_price * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_price
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'
       GROUP BY date(t.created_at)
       ORDER BY day ASC`,
      [product.id]
    );

    const withMargin = series.map((d) => ({
      ...d,
      margin_pct: Number(d.revenue) > 0 ? round2((Number(d.profit) / Number(d.revenue)) * 100) : 0,
    }));

    const totals = await db.get(
      `SELECT ROUND(SUM(ti.line_gross), 2) AS revenue,
              ROUND(SUM(COALESCE(ti.gross_profit, 0)), 2) AS profit,
              ROUND(SUM(ti.quantity), 3) AS quantity,
              ROUND(SUM(ti.unit_price * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_selling_price,
              ROUND(SUM(ti.unit_cost_at_sale * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_purchase_cost
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'`,
      [product.id]
    );

    const marginValues = withMargin.filter((d) => Number(d.revenue) > 0).map((d) => d.margin_pct);
    const historicalMargin = Number(totals?.revenue) > 0
      ? round2((Number(totals.profit) / Number(totals.revenue)) * 100)
      : 0;

    res.json({
      product_id: product.id,
      product_name: product.name,
      cards: {
        avg_selling_price: totals?.avg_selling_price != null ? round2(totals.avg_selling_price) : 0,
        avg_purchase_cost: totals?.avg_purchase_cost != null ? round2(totals.avg_purchase_cost) : 0,
        current_margin: marginPct(product.price, product.cost),
        historical_margin: historicalMargin,
        highest_margin: marginValues.length ? Math.max(...marginValues) : 0,
        lowest_margin: marginValues.length ? Math.min(...marginValues) : 0,
        total_revenue: round2(totals?.revenue),
        total_profit: round2(totals?.profit),
      },
      series: withMargin,
    });
  });

  router.get("/:id/batches", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT b.id, b.batch_no, b.expiry_date, b.quantity, b.cost, b.notes, b.created_at,
              CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_remaining
       FROM product_batches b
       WHERE b.product_id = ?
       ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, b.id DESC`,
      [product.id]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/audit-log", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT id, user_id, username, role, action, old_value, new_value, created_at
       FROM audit_logs
       WHERE entity_type = 'products' AND entity_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.post("/:id/change-price", requireAuth, requireAdmin, async (req, res, next) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const b = req.body || {};
    const newPrice = Number(b.new_price);
    if (!Number.isFinite(newPrice) || newPrice < 0) {
      return res.status(400).json({ error: "السعر الجديد غير صالح", code: "VALIDATION_ERROR" });
    }
    const reason = b.reason != null && String(b.reason).trim() !== "" ? String(b.reason).trim() : null;
    if (!reason) {
      return res.status(400).json({ error: "سبب تغيير السعر مطلوب", code: "VALIDATION_ERROR" });
    }
    if (product.min_price != null && newPrice < Number(product.min_price)) {
      return res.status(400).json({ error: `السعر أقل من الحد الأدنى (${product.min_price})`, code: "PRICE_BELOW_MIN" });
    }
    if (product.max_price != null && newPrice > Number(product.max_price)) {
      return res.status(400).json({ error: `السعر أعلى من الحد الأقصى (${product.max_price})`, code: "PRICE_ABOVE_MAX" });
    }

    const oldPrice = round2(product.price);
    if (round2(newPrice) === oldPrice) {
      return res.status(400).json({ error: "السعر الجديد مطابق للسعر الحالي", code: "NO_CHANGE" });
    }

    try {
      await withTransaction(db, async () => {
        await db.run("UPDATE products SET price = ? WHERE id = ?", [round2(newPrice), product.id]);
        const defaultUnit = await getDefaultUnit(db, product.id);
        if (defaultUnit) {
          await db.run("UPDATE product_units SET price = ?, updated_at = datetime('now') WHERE id = ?", [
            round2(newPrice),
            defaultUnit.id,
          ]);
        }
        await recordPriceChange(db, req, {
          productId: product.id,
          oldPrice,
          newPrice: round2(newPrice),
          reason,
        });
      });
    } catch (e) {
      return next(e);
    }

    const updated = await db.get("SELECT * FROM products WHERE id = ?", [product.id]);
    const history = await db.get(
      "SELECT * FROM product_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [product.id]
    );
    res.json({ success: true, product: updated, history });
  });

  return router;
}
