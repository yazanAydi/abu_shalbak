import { digitsOnly, normalizeBarcodeInput, normalizeStoredBarcode } from "./barcode.js";
import { resolveUnitPrice, buildSourceRowIndexFromProducts } from "./importPriceResolver.js";
import { normalizeUnitName } from "./unitNames.js";
import { ensureUnitName } from "./unitNameCatalog.js";

import { round2 } from "./money.js";

/** Base unit name for weighed / deli products. */
export const WEIGHED_BASE_UNIT_NAME = "كغم";
export const DEFAULT_PACKAGE_UNIT_NAME = "حبة";

/**
 * Convert a quantity in a sold/purchased unit into base-unit quantity
 * (typically KG). Shared by POS checkout, purchases, and goods-in/out.
 * @param {number} qty
 * @param {number} conversion
 */
export function toBaseQuantity(qty, conversion) {
  const q = Number(qty);
  const c = Number(conversion);
  if (!Number.isFinite(q) || !Number.isFinite(c)) return 0;
  return Math.round(q * c * 1e6) / 1e6;
}

/**
 * True when this sold unit is the kg/base line of a weighed product
 * (fractional qty, price per kg). Package units on the same product are false,
 * even when conversion_to_base is 1 (1 حبة = 1 KG).
 * @param {object | null | undefined} unit
 * @param {boolean} isWeighed
 */
export function isWeighedBaseUnit(unit, isWeighed) {
  if (!isWeighed || !unit) return false;
  return String(unit.unit_name || "") === WEIGHED_BASE_UNIT_NAME;
}

/**
 * @param {Array<{ unit_name?: string, conversion_to_base?: number, is_default?: boolean }>} units
 */
export function findKgUnit(units) {
  const list = Array.isArray(units) ? units : [];
  const byName = list.find((u) => String(u.unit_name || "") === WEIGHED_BASE_UNIT_NAME);
  if (byName) return byName;
  return (
    list.find((u) => {
      if (String(u.unit_name || "") === DEFAULT_PACKAGE_UNIT_NAME) return false;
      return Math.abs(Number(u.conversion_to_base) - 1) < 1e-9;
    }) || null
  );
}

/**
 * Scale PLU lives on the كغم unit barcode (not products.sku, not a new column).
 * @param {object | null | undefined} product
 * @param {object[]} units
 * @returns {string | null}
 */
export function resolveScaleCode(product, units) {
  if (!product || Number(product.is_weighed) !== 1) return null;
  const kg = findKgUnit(units);
  const code = kg?.barcode != null ? String(kg.barcode).trim() : "";
  return code || null;
}

/**
 * @param {object} db
 * @param {object} product
 */
/**
 * Package/حبة unit for a weighed product (conversion may be 1 KG per حبة).
 * @param {object[]} units
 */
export function resolvePackageUnit(units) {
  const list = (Array.isArray(units) ? units : []).filter((u) => u.sale_enabled !== false);
  return (
    list.find((u) => String(u.unit_name || "") === DEFAULT_PACKAGE_UNIT_NAME) ||
    list.find((u) => Number(u.conversion_to_base) > 1) ||
    null
  );
}

export async function withScaleCode(db, product) {
  if (!product) return product;
  if (Number(product.is_weighed) !== 1) {
    return { ...product, scale_code: null, package_price: null, package_conversion: null };
  }
  const units = await loadUnitsForProduct(db, product.id);
  const pack = resolvePackageUnit(units);
  const existingScale = product.scale_code != null && String(product.scale_code).trim() !== ""
    ? String(product.scale_code).trim()
    : resolveScaleCode(product, units);
  return {
    ...product,
    scale_code: existingScale,
    package_price: pack ? round2(Number(pack.price) || 0) : null,
    package_conversion: pack ? Number(pack.conversion_to_base) || null : null,
  };
}

/**
 * Derive the cost of one unit from the authoritative base cost (products.cost)
 * and the unit's conversion factor.
 *
 * products.cost is ALWAYS the source of truth (cost per base unit, e.g. ₪4/kg).
 * product_units.cost is treated as a display cache only and must never be used
 * for COGS calculations.
 *
 * @param {number} baseCost  products.cost — cost per base unit
 * @param {number} conversion  unit.conversion_to_base
 * @returns {number}
 */
export function derivedUnitCost(baseCost, conversion) {
  const base = Number(baseCost) || 0;
  const conv = Math.max(0.0001, Number(conversion) || 1);
  return round2(base * conv);
}

/**
 * Cost of the sold unit, always derived from products.cost × conversion_to_base.
 * product_units.cost is NOT used — it may be stale.
 *
 * Example: products.cost = ₪4/kg, حبة conversion = 2.5 → ₪10/piece.
 */
export function resolveSoldUnitCost(unit, product) {
  const baseCost = Number(product?.cost) || 0;
  const conversion = Number(unit?.conversion_to_base) || 1;
  return derivedUnitCost(baseCost, conversion);
}

/**
 * True when the sold unit is a KG unit (unit_name === "كغم").
 * This is the gate for allowing fractional quantities at checkout,
 * independently of whether the product is flagged is_weighed.
 *
 * @param {object | null | undefined} unit
 * @returns {boolean}
 */
export function isKgUnit(unit) {
  return String(unit?.unit_name || "") === WEIGHED_BASE_UNIT_NAME;
}

/**
 * @param {object} row
 */
export function formatProductUnit(row) {
  if (!row) return null;
  return {
    id: row.id,
    product_id: row.product_id,
    unit_name: row.unit_name,
    barcode: row.barcode,
    price: round2(Number(row.price) || 0),
    cost: round2(Number(row.cost) || 0),
    conversion_to_base: Number(row.conversion_to_base) || 1,
    is_default: Number(row.is_default) === 1,
    is_default_purchase: Number(row.is_default_purchase) === 1,
    purchase_enabled: row.purchase_enabled == null ? true : Number(row.purchase_enabled) === 1,
    sale_enabled: row.sale_enabled == null ? true : Number(row.sale_enabled) === 1,
    needs_review: Number(row.needs_review) === 1,
    source_row_id: row.source_row_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * @param {object} db
 * @param {number} productId
 */
export async function loadUnitsForProduct(db, productId) {
  const rows = await db.all(
    `SELECT * FROM product_units
     WHERE product_id = ?
     ORDER BY is_default DESC, id ASC`,
    [productId]
  );
  return rows.map(formatProductUnit);
}

/**
 * Rename the display/base unit label without changing conversions, default
 * flags, barcodes, prices, or deleting sibling units.
 *
 * Weighed products stay on كغم. If another unit on the same product already
 * has the new name, reject so the admin uses the units editor instead.
 *
 * @param {object} db
 * @param {number} productId
 * @param {{ currentUnit?: string|null, nextUnit?: string|null, isWeighed?: boolean|number }} [opts]
 * @returns {Promise<{ unit: string|null, renamed: boolean }>}
 */
export async function renameProductDisplayUnit(db, productId, opts = {}) {
  const isWeighed = Number(opts.isWeighed) === 1 || opts.isWeighed === true;
  if (isWeighed) {
    return { unit: WEIGHED_BASE_UNIT_NAME, renamed: false };
  }

  const nextRaw = opts.nextUnit;
  const nextName =
    nextRaw == null || String(nextRaw).trim() === ""
      ? null
      : normalizeUnitName(nextRaw);

  if (!nextName) {
    return { unit: null, renamed: false };
  }

  await ensureUnitName(db, nextName);

  const units = await loadUnitsForProduct(db, productId);
  if (!units.length) {
    return { unit: nextName, renamed: false };
  }

  const currentRaw = opts.currentUnit;
  const currentUnit =
    currentRaw == null || String(currentRaw).trim() === ""
      ? null
      : normalizeUnitName(currentRaw);

  const target =
    (currentUnit && units.find((u) => u.unit_name === currentUnit)) ||
    units.find((u) => u.is_default) ||
    units[0];

  if (!target) {
    return { unit: nextName, renamed: false };
  }
  if (target.unit_name === nextName) {
    return { unit: nextName, renamed: false };
  }

  const collision = units.find((u) => Number(u.id) !== Number(target.id) && u.unit_name === nextName);
  if (collision) {
    const err = new Error("لا يمكن تغيير الوحدة لأن المنتج يملك هذه الوحدة مسبقاً");
    err.status = 409;
    throw err;
  }

  await db.run(
    "UPDATE product_units SET unit_name = ?, updated_at = datetime('now') WHERE id = ?",
    [nextName, target.id]
  );
  return { unit: nextName, renamed: true };
}

/**
 * Load units for many products in one query (avoids N+1 in the units catalog).
 * @param {object} db
 * @param {number[]} productIds
 * @returns {Promise<Map<number, ReturnType<typeof formatProductUnit>[]>>}
 */
export async function loadUnitsForProducts(db, productIds) {
  const ids = [...new Set((productIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  /** @type {Map<number, ReturnType<typeof formatProductUnit>[]>} */
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT * FROM product_units
     WHERE product_id IN (${placeholders})
     ORDER BY is_default DESC, id ASC`,
    ids
  );
  for (const row of rows) {
    const list = map.get(row.product_id) || [];
    list.push(formatProductUnit(row));
    map.set(row.product_id, list);
  }
  return map;
}

const UNITS_CATALOG_HAVING = `
  HAVING COUNT(pu.id) > 1
      OR MAX(CASE WHEN pu.conversion_to_base != 1 THEN 1 ELSE 0 END) = 1
`;

/**
 * Products that have packaging units (more than one unit, or any non-base conversion).
 * @param {object} db
 * @param {{ search?: string, limit?: number, offset?: number }} [opts]
 */
export async function loadUnitsCatalog(db, { search = "", limit = 100, offset = 0 } = {}) {
  const params = [];
  let searchClause = "";
  const term = String(search ?? "").trim();
  if (term) {
    const like = `%${term}%`;
    searchClause = ` AND (
      p.name LIKE ? OR CAST(p.barcode AS TEXT) LIKE ? OR CAST(p.sku AS TEXT) LIKE ?
      OR EXISTS (
        SELECT 1 FROM product_units pu2
        WHERE pu2.product_id = p.id AND pu2.barcode LIKE ?
      )
    )`;
    params.push(like, like, like, like);
  }

  const productRows = await db.all(
    `SELECT p.id AS product_id, p.name AS product_name, p.barcode AS product_barcode,
            p.sku AS product_sku, COUNT(pu.id) AS unit_count
     FROM products p
     JOIN product_units pu ON pu.product_id = p.id
     WHERE 1=1 ${searchClause}
     GROUP BY p.id
     ${UNITS_CATALOG_HAVING}
     ORDER BY p.name ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const unitsByProduct = await loadUnitsForProducts(
    db,
    productRows.map((row) => row.product_id)
  );
  const rows = productRows.map((row) => {
    const units = unitsByProduct.get(row.product_id) || [];
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      product_barcode: row.product_barcode,
      product_sku: row.product_sku ?? null,
      unit_count: Number(row.unit_count) || units.length,
      units,
    };
  });

  const totalRow = await db.get(
    `SELECT COUNT(*) AS n FROM (
       SELECT p.id
       FROM products p
       JOIN product_units pu ON pu.product_id = p.id
       WHERE 1=1 ${searchClause}
       GROUP BY p.id
       ${UNITS_CATALOG_HAVING}
     )`,
    params
  );

  return {
    rows,
    total: Number(totalRow?.n) || 0,
    limit,
    offset,
  };
}

/**
 * Resolve who owns a barcode for live unit-editor validation.
 * @param {object} db
 * @param {{ barcode: string, productId: number, excludeUnitId?: number | null }} opts
 */
export async function checkUnitBarcodeAvailability(db, { barcode, productId, excludeUnitId = null }) {
  const code = digitsOnly(normalizeBarcodeInput(barcode));
  if (!code) {
    return { status: "invalid", message: "باركود غير صالح" };
  }
  if (code.length < 4 || code.length > 14) {
    return { status: "invalid", message: "باركود غير صالح" };
  }

  const pid = Number(productId);
  const excludeId = excludeUnitId != null ? Number(excludeUnitId) : null;

  /** @type {{ product_id: number, product_name: string, unit_id: number | null, unit_name: string } | null} */
  let owner = null;

  const unitRow = await db.get(
    `SELECT pu.id AS unit_id, pu.unit_name, pu.product_id, p.name AS product_name
     FROM product_units pu
     JOIN products p ON p.id = pu.product_id
     WHERE pu.barcode = ?`,
    [code]
  );
  if (unitRow) {
    owner = {
      product_id: unitRow.product_id,
      product_name: unitRow.product_name,
      unit_id: unitRow.unit_id,
      unit_name: unitRow.unit_name,
    };
  }

  if (!owner) {
    const aliasRow = await db.get(
      `SELECT pu.id AS unit_id, pu.unit_name, pu.product_id, p.name AS product_name
       FROM product_unit_barcodes pub
       JOIN product_units pu ON pu.id = pub.product_unit_id
       JOIN products p ON p.id = pu.product_id
       WHERE pub.barcode = ?`,
      [code]
    );
    if (aliasRow) {
      owner = {
        product_id: aliasRow.product_id,
        product_name: aliasRow.product_name,
        unit_id: aliasRow.unit_id,
        unit_name: aliasRow.unit_name,
      };
    }
  }

  if (!owner) {
    const pbRow = await db.get(
      `SELECT pb.product_id, p.name AS product_name, pb.label AS unit_name
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [code]
    );
    if (pbRow) {
      owner = {
        product_id: pbRow.product_id,
        product_name: pbRow.product_name,
        unit_id: null,
        unit_name: pbRow.unit_name || "أساسي",
      };
    }
  }

  if (!owner) {
    const prodRow = await db.get(
      `SELECT id AS product_id, name AS product_name, unit AS unit_name
       FROM products WHERE barcode = ?`,
      [code]
    );
    if (prodRow) {
      owner = {
        product_id: prodRow.product_id,
        product_name: prodRow.product_name,
        unit_id: null,
        unit_name: prodRow.unit_name || "أساسي",
      };
    }
  }

  if (!owner) {
    return { status: "free", message: "الباركود متاح" };
  }

  if (Number(owner.product_id) === pid) {
    if (excludeId != null && owner.unit_id != null && Number(owner.unit_id) === excludeId) {
      return { status: "free", message: "الباركود متاح" };
    }
    return {
      status: "self",
      product_name: owner.product_name,
      unit_name: owner.unit_name,
      message: `مستخدم لوحدة ${owner.unit_name} على هذا المنتج`,
    };
  }

  return {
    status: "conflict",
    product_name: owner.product_name,
    unit_name: owner.unit_name,
    message: `مرتبط بمنتج ${owner.product_name}${owner.unit_name ? ` — وحدة ${owner.unit_name}` : ""}`,
  };
}

/**
 * @param {object} db
 * @param {number} productId
 */
export async function getDefaultUnit(db, productId) {
  const row = await db.get(
    `SELECT * FROM product_units
     WHERE product_id = ?
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
    [productId]
  );
  return formatProductUnit(row);
}

/**
 * Sync products.barcode, price, cost from default unit.
 * @param {object} db
 * @param {number} productId
 */
export async function syncProductFromDefaultUnit(db, productId) {
  const unit = await db.get(
    `SELECT * FROM product_units WHERE product_id = ? ORDER BY is_default DESC, id ASC LIMIT 1`,
    [productId]
  );
  if (!unit) return;

  const unitBarcode = unit.barcode != null && String(unit.barcode).trim()
    ? String(unit.barcode).trim()
    : null;

  const product = await db.get(
    "SELECT id, barcode, is_weighed, cost FROM products WHERE id = ?",
    [productId]
  );
  const productBarcode = product?.barcode != null ? String(product.barcode).trim() : "";
  const keepProductBarcode =
    Number(product?.is_weighed) === 1 &&
    Boolean(productBarcode) &&
    Boolean(unitBarcode) &&
    productBarcode !== unitBarcode;

  // IMPORTANT: We sync selling price (unit.price) from the default unit.
  // We do NOT sync cost from the unit — products.cost is the authoritative
  // base cost, and product_units.cost is only a display cache derived from it.
  // Writing unit.cost back to products.cost would corrupt WAC with a stale value.

  if (keepProductBarcode) {
    await db.run(
      `UPDATE products SET price = ?, updated_at = datetime('now') WHERE id = ?`,
      [round2(unit.price), productId]
    );
  } else if (unitBarcode) {
    await db.run(
      `UPDATE products SET barcode = ?, price = ?, updated_at = datetime('now') WHERE id = ?`,
      [unitBarcode, round2(unit.price), productId]
    );

    const existingPb = await db.get(
      "SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?",
      [productId, unitBarcode]
    );
    if (!existingPb) {
      await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
      await db.run(
        "INSERT OR IGNORE INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, 1)",
        [productId, unitBarcode, unit.unit_name]
      );
    } else {
      await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
      await db.run("UPDATE product_barcodes SET is_primary = 1, label = ? WHERE id = ?", [
        unit.unit_name,
        existingPb.id,
      ]);
    }
  } else {
    await db.run(
      `UPDATE products SET price = ?, updated_at = datetime('now') WHERE id = ?`,
      [round2(unit.price), productId]
    );
  }

  // Refresh the unit-cost cache (base → units direction only).
  // The current products.cost may not have changed here, but if called after a
  // WAC update (purchase post) the cached unit costs become consistent with it.
  await refreshUnitCostCache(db, productId);
}

/**
 * Refresh product_units.cost for all units of a product from the authoritative
 * products.cost (base cost per base unit × conversion_to_base).
 *
 * This is a ONE-WAY cache refresh: base cost → derived unit costs.
 * It must never run in the reverse direction.
 *
 * @param {object} db
 * @param {number} productId
 */
export async function refreshUnitCostCache(db, productId) {
  const product = await db.get("SELECT cost FROM products WHERE id = ?", [productId]);
  if (!product) return;
  const baseCost = Number(product.cost) || 0;
  const units = await db.all(
    "SELECT id, conversion_to_base FROM product_units WHERE product_id = ?",
    [productId]
  );
  for (const u of units) {
    const cached = derivedUnitCost(baseCost, u.conversion_to_base);
    await db.run(
      "UPDATE product_units SET cost = ?, updated_at = datetime('now') WHERE id = ?",
      [cached, u.id]
    );
  }
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {object} data
 */
export async function upsertProductUnit(db, productId, data) {
  const unitName = normalizeUnitName(data.unit_name || data.unitName || "حبة");
  await ensureUnitName(db, unitName);
  const barcode = data.barcode != null && String(data.barcode).trim()
    ? digitsOnly(normalizeBarcodeInput(data.barcode))
    : "";
  if (barcode && (barcode.length < 4 || barcode.length > 14)) {
    throw Object.assign(new Error("باركود غير صالح"), { status: 400 });
  }

  const price = round2(Number(data.price) || 0);
  const cost = round2(Number(data.cost) || 0);
  const requestedConversion = Number(data.conversion_to_base);
  const conversion = Number.isFinite(requestedConversion) && requestedConversion > 0
    ? requestedConversion
    : null;
  const isDefault = data.is_default ? 1 : 0;
  const sourceRowId = data.source_row_id != null ? Number(data.source_row_id) : null;
  const needsReview = data.needs_review ? 1 : 0;
  // null => keep existing on update / default to 0/1 on insert (COALESCE below).
  const purchaseEnabled = data.purchase_enabled == null ? null : data.purchase_enabled ? 1 : 0;
  const isDefaultPurchase = data.is_default_purchase == null ? null : data.is_default_purchase ? 1 : 0;
  const saleEnabled = data.sale_enabled == null ? null : data.sale_enabled ? 1 : 0;

  const storedBarcode = barcode || null;
  const owner = storedBarcode
    ? await db.get("SELECT id, product_id FROM product_units WHERE barcode = ?", [storedBarcode])
    : null;
  const existingByName = await db.get(
    "SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?",
    [productId, unitName]
  );

  if (storedBarcode) {
    const pbOwner = await db.get(
      "SELECT product_id FROM product_barcodes WHERE barcode = ?",
      [storedBarcode]
    );
    if (pbOwner && Number(pbOwner.product_id) !== Number(productId)) {
      throw Object.assign(new Error("هذا الباركود مرتبط بمنتج آخر"), { status: 409 });
    }
    const prodOwner = await db.get(
      "SELECT id FROM products WHERE barcode = ? AND id != ?",
      [storedBarcode, productId]
    );
    if (prodOwner) {
      throw Object.assign(new Error("هذا الباركود مرتبط بمنتج آخر"), { status: 409 });
    }
  }

  if (isDefault) {
    await db.run("UPDATE product_units SET is_default = 0 WHERE product_id = ?", [productId]);
  }
  if (isDefaultPurchase === 1) {
    await db.run("UPDATE product_units SET is_default_purchase = 0 WHERE product_id = ?", [productId]);
  }

  let unitId;
  if (existingByName) {
    unitId = existingByName.id;
    if (owner && Number(owner.id) !== Number(unitId) && Number(owner.product_id) !== Number(productId)) {
      throw Object.assign(new Error("هذا الباركود مرتبط بوحدة أخرى"), { status: 409 });
    }
    await db.run(
      `UPDATE product_units SET barcode = ?, price = ?, cost = ?, conversion_to_base = COALESCE(?, conversion_to_base),
       is_default = ?, needs_review = ?, purchase_enabled = COALESCE(?, purchase_enabled),
       is_default_purchase = COALESCE(?, is_default_purchase),
       sale_enabled = COALESCE(?, sale_enabled),
       source_row_id = COALESCE(?, source_row_id), updated_at = datetime('now')
       WHERE id = ?`,
      [storedBarcode, price, cost, conversion, isDefault, needsReview, purchaseEnabled, isDefaultPurchase, saleEnabled, sourceRowId, unitId]
    );
  } else if (owner) {
    if (Number(owner.product_id) !== Number(productId)) {
      throw Object.assign(new Error("هذا الباركود مرتبط بمنتج آخر"), { status: 409 });
    }
    unitId = owner.id;
    await db.run(
      `UPDATE product_units SET unit_name = ?, price = ?, cost = ?, conversion_to_base = COALESCE(?, conversion_to_base),
       is_default = ?, needs_review = ?, purchase_enabled = COALESCE(?, purchase_enabled),
       is_default_purchase = COALESCE(?, is_default_purchase),
       sale_enabled = COALESCE(?, sale_enabled),
       source_row_id = COALESCE(?, source_row_id), updated_at = datetime('now')
       WHERE id = ?`,
      [unitName, price, cost, conversion, isDefault, needsReview, purchaseEnabled, isDefaultPurchase, saleEnabled, sourceRowId, unitId]
    );
  } else {
    const info = await db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, needs_review, purchase_enabled, is_default_purchase, sale_enabled, source_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), COALESCE(?, 0), COALESCE(?, 1), ?)`,
      [productId, unitName, storedBarcode, price, cost, conversion ?? 1, isDefault, needsReview, purchaseEnabled, isDefaultPurchase, saleEnabled, sourceRowId]
    );
    unitId = info.lastID;
  }

  const aliasBarcodes = Array.isArray(data.alias_barcodes) ? data.alias_barcodes : [];
  for (const rawAlias of aliasBarcodes) {
    const alias = digitsOnly(normalizeBarcodeInput(rawAlias));
    if (!alias || alias === barcode) continue;
    await db.run(
      "INSERT OR IGNORE INTO product_unit_barcodes (product_unit_id, barcode) VALUES (?, ?)",
      [unitId, alias]
    );
  }

  const hasDefault = await db.get(
    "SELECT id FROM product_units WHERE product_id = ? AND is_default = 1",
    [productId]
  );
  if (!hasDefault) {
    await db.run("UPDATE product_units SET is_default = 1 WHERE id = ?", [unitId]);
  }

  await syncProductFromDefaultUnit(db, productId);
  return db.get("SELECT * FROM product_units WHERE id = ?", [unitId]);
}

/**
 * Ensure a weighed product has a كغم base unit and, optionally, a package unit
 * with per-product conversion_to_base (1 حبة = N كغم). Scale PLU is stored on
 * the كغم unit barcode; the package/normal barcode stays on products.barcode
 * and the package unit.
 *
 * @param {object} db
 * @param {number} productId
 * @param {object} [opts]
 * @param {string | null} [opts.productBarcode]
 * @param {string | null | undefined} [opts.scaleCode] undefined = keep existing
 * @param {number} [opts.kgPrice]
 * @param {number} [opts.kgCost]
 * @param {number} [opts.packageConversion]
 * @param {string} [opts.packageUnitName]
 * @param {number} [opts.packagePrice]
 * @param {number} [opts.packageCost]
 */
export async function ensureWeighedProductUnits(db, productId, opts = {}) {
  const product = await db.get("SELECT * FROM products WHERE id = ?", [productId]);
  if (!product) return;

  const productBarcode = opts.productBarcode != null
    ? (String(opts.productBarcode).trim() || null)
    : (product.barcode != null ? String(product.barcode).trim() : null);
  const kgPrice = opts.kgPrice != null ? round2(Number(opts.kgPrice) || 0) : round2(Number(product.price) || 0);
  const kgCost = opts.kgCost != null ? round2(Number(opts.kgCost) || 0) : round2(Number(product.cost) || 0);

  const existingKg = await db.get(
    `SELECT * FROM product_units WHERE product_id = ? AND unit_name = ?`,
    [productId, WEIGHED_BASE_UNIT_NAME]
  );

  const packageConversion = Number(opts.packageConversion);
  const packagePriceNum = Number(opts.packagePrice);
  const hasPackage =
    Number.isFinite(packageConversion) &&
    packageConversion > 0 &&
    opts.packagePrice != null &&
    opts.packagePrice !== "" &&
    Number.isFinite(packagePriceNum) &&
    packagePriceNum > 0;

  let kgBarcode;
  if (opts.scaleCode !== undefined) {
    kgBarcode = opts.scaleCode ? normalizeStoredBarcode(opts.scaleCode) : null;
  } else if (existingKg?.barcode) {
    kgBarcode = String(existingKg.barcode).trim() || null;
  } else if (hasPackage) {
    kgBarcode = null;
  } else {
    kgBarcode = productBarcode;
  }

  await upsertProductUnit(db, productId, {
    unit_name: WEIGHED_BASE_UNIT_NAME,
    barcode: kgBarcode || "",
    price: kgPrice,
    cost: kgCost,
    conversion_to_base: 1,
    is_default: true,
    sale_enabled: true,
    purchase_enabled: true,
    is_default_purchase: hasPackage ? false : existingKg ? undefined : true,
  });

  const pkgName = opts.packageUnitName
    ? normalizeUnitName(opts.packageUnitName)
    : DEFAULT_PACKAGE_UNIT_NAME;
  const existingPack = await db.get(
    `SELECT * FROM product_units WHERE product_id = ? AND unit_name = ?`,
    [productId, pkgName]
  );

  if (!hasPackage) return;

  // Selling prices are independent of conversion. Conversion only drives inventory.
  const pkgPrice = round2(packagePriceNum);
  const pkgCost = opts.packageCost != null
    ? round2(Number(opts.packageCost) || 0)
    : existingPack
      ? round2(Number(existingPack.cost) || 0)
      : 0;

  await upsertProductUnit(db, productId, {
    unit_name: pkgName,
    barcode: productBarcode || "",
    price: pkgPrice,
    cost: pkgCost,
    conversion_to_base: packageConversion,
    is_default: false,
    sale_enabled: true,
    purchase_enabled: true,
    is_default_purchase: true,
  });
}

/**
 * Repair product_units.price from barcode→product price index (e.g. after migration or re-import).
 * @param {object} db
 * @param {import("./importPriceResolver.js").SourceRowIndex | null} [sourceIndex]
 */
export async function repairProductUnitPrices(db, sourceIndex = null, options = {}) {
  const productIds = Array.isArray(options.productIds)
    ? options.productIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : null;
  const index = sourceIndex ?? (await buildSourceRowIndexFromProducts(db, { productIds }));
  let sql = `
    SELECT pu.*, p.barcode AS product_barcode, p.price AS product_price
    FROM product_units pu
    JOIN products p ON p.id = pu.product_id
  `;
  const params = [];
  if (productIds?.length) {
    sql += ` WHERE pu.product_id IN (${productIds.map(() => "?").join(",")})`;
    params.push(...productIds);
  }
  sql += " ORDER BY pu.id ASC";
  const units = await db.all(sql, params);

  let updated = 0;
  let needs_review_count = 0;

  for (const unit of units) {
    const resolved = resolveUnitPrice({
      unitBarcode: unit.barcode,
      currentRowNum: unit.product_id,
      currentRowPrimary: unit.product_barcode,
      currentRowPrice: unit.product_price,
      sourceIndex: index,
    });

    const newPrice = round2(resolved.price);
    const newNeedsReview = resolved.needsReview ? 1 : 0;
    const priceChanged = Math.abs(newPrice - round2(Number(unit.price))) > 0.009;
    const reviewChanged = newNeedsReview !== Number(unit.needs_review || 0);

    if (priceChanged || reviewChanged) {
      await db.run(
        `UPDATE product_units SET price = ?, needs_review = ?, updated_at = datetime('now') WHERE id = ?`,
        [newPrice, newNeedsReview, unit.id]
      );
      updated++;
      if (newNeedsReview) needs_review_count++;
      console.info(
        `[repair:unit-price] product_id=${unit.product_id} unit="${unit.unit_name}" barcode="${unit.barcode}" price=${newPrice} source=${resolved.source}${resolved.matchedRowNum != null ? ` matchedRow=${resolved.matchedRowNum}` : ""}${resolved.needsReview ? " needs_review=true" : ""}`
      );
    }
  }

  return { updated, needs_review_count };
}

/**
 * Idempotent backfill from product_barcodes → product_units.
 * @param {object} db
 */
export async function migrateProductBarcodesToUnits(db) {
  const products = await db.all(`
    SELECT p.* FROM products p
    WHERE NOT EXISTS (SELECT 1 FROM product_units pu WHERE pu.product_id = p.id)
    ORDER BY p.id ASC
  `);

  for (const p of products) {
    const barcodes = await db.all(
      "SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, id ASC",
      [p.id]
    );

    if (barcodes.length === 0) {
      const bc = digitsOnly(normalizeBarcodeInput(p.barcode));
      if (bc.length >= 4) {
        await db.run(
          `INSERT OR IGNORE INTO product_units
             (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
           VALUES (?, ?, ?, ?, ?, 1, 1)`,
          [p.id, normalizeUnitName(p.unit || "حبة"), bc, round2(p.price), round2(p.cost)]
        );
      }
      continue;
    }

    for (const pb of barcodes) {
      const bc = digitsOnly(normalizeBarcodeInput(pb.barcode));
      if (bc.length < 4) continue;
      const unitName = normalizeUnitName(pb.label || p.unit || "حبة");
      const isDefault = Number(pb.is_primary) === 1 ? 1 : 0;
      await db.run(
        `INSERT OR IGNORE INTO product_units
           (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [p.id, unitName, bc, round2(p.price), round2(p.cost), isDefault]
      );
    }

    const hasDefault = await db.get(
      "SELECT id FROM product_units WHERE product_id = ? AND is_default = 1",
      [p.id]
    );
    if (!hasDefault) {
      const first = await db.get(
        "SELECT id FROM product_units WHERE product_id = ? ORDER BY id ASC LIMIT 1",
        [p.id]
      );
      if (first) await db.run("UPDATE product_units SET is_default = 1 WHERE id = ?", [first.id]);
    }

    await syncProductFromDefaultUnit(db, p.id);
  }
}

/**
 * Ensure a sellable default unit exists (e.g. products created after migration).
 * @param {object} db
 * @param {number} productId
 */
export async function ensureDefaultProductUnit(db, productId) {
  const existing = await db.get("SELECT id FROM product_units WHERE product_id = ? LIMIT 1", [
    productId,
  ]);
  if (existing) return;

  const p = await db.get("SELECT * FROM products WHERE id = ?", [productId]);
  if (!p) return;

  const bc = digitsOnly(normalizeBarcodeInput(p.barcode));
  if (bc.length < 4) return;

  await upsertProductUnit(db, productId, {
    unit_name: normalizeUnitName(p.unit || "حبة"),
    barcode: bc,
    price: round2(p.price),
    cost: round2(p.cost),
    conversion_to_base: 1,
    is_default: true,
  });
}

const PRODUCT_UNIT_REF_TABLES = [
  ["transaction_items", "product_unit_id"],
  ["purchase_invoice_items", "product_unit_id"],
  ["purchase_order_items", "product_unit_id"],
  ["purchase_return_items", "product_unit_id"],
  ["inventory_document_items", "product_unit_id"],
  ["sales_invoice_items", "product_unit_id"],
  ["suspended_sale_items", "product_unit_id"],
  ["promotions", "product_unit_id"],
];

/**
 * @param {object} db
 * @param {number} unitId
 */
export async function productUnitIsReferenced(db, unitId) {
  const id = Number(unitId);
  if (!id) return false;
  for (const [table, col] of PRODUCT_UNIT_REF_TABLES) {
    const row = await db.get(`SELECT 1 AS ok FROM ${table} WHERE ${col} = ? LIMIT 1`, [id]);
    if (row) return true;
  }
  return false;
}

/**
 * Remove or disable the حبة unit when a dual-sale weighed product is saved as KG-only.
 * Hard-delete only when no history rows reference the unit.
 * @param {object} db
 * @param {number} productId
 */
export async function disableWeighedPackageUnit(db, productId) {
  const pack = await db.get(
    `SELECT * FROM product_units WHERE product_id = ? AND unit_name = ?`,
    [productId, DEFAULT_PACKAGE_UNIT_NAME]
  );
  if (!pack) return { disabled: false, deleted: false };

  if (await productUnitIsReferenced(db, pack.id)) {
    await db.run(
      `UPDATE product_units
       SET sale_enabled = 0, purchase_enabled = 0, barcode = NULL, is_default_purchase = 0,
           updated_at = datetime('now')
       WHERE id = ?`,
      [pack.id]
    );
    await db.run("DELETE FROM product_unit_barcodes WHERE product_unit_id = ?", [pack.id]);
  } else {
    await deleteProductUnit(db, productId, pack.id);
    await db.run(
      `UPDATE product_units SET is_default_purchase = 1, updated_at = datetime('now')
       WHERE product_id = ? AND unit_name = ?`,
      [productId, WEIGHED_BASE_UNIT_NAME]
    );
    return { disabled: true, deleted: true };
  }

  await db.run(
    `UPDATE product_units SET is_default_purchase = 1, updated_at = datetime('now')
     WHERE product_id = ? AND unit_name = ?`,
    [productId, WEIGHED_BASE_UNIT_NAME]
  );
  return { disabled: true, deleted: false };
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {number} unitId
 */
export async function deleteProductUnit(db, productId, unitId) {
  const count = await db.get("SELECT COUNT(*) AS n FROM product_units WHERE product_id = ?", [productId]);
  if (Number(count?.n) <= 1) {
    throw Object.assign(new Error("لا يمكن حذف الوحدة الوحيدة للمنتج"), { status: 400 });
  }
  const unit = await db.get("SELECT * FROM product_units WHERE id = ? AND product_id = ?", [
    unitId,
    productId,
  ]);
  if (!unit) throw Object.assign(new Error("الوحدة غير موجودة"), { status: 404 });

  await db.run("DELETE FROM product_unit_barcodes WHERE product_unit_id = ?", [unitId]);
  await db.run("DELETE FROM product_units WHERE id = ?", [unitId]);

  const hasDefault = await db.get(
    "SELECT id FROM product_units WHERE product_id = ? AND is_default = 1",
    [productId]
  );
  if (!hasDefault) {
    const next = await db.get(
      "SELECT id FROM product_units WHERE product_id = ? ORDER BY id ASC LIMIT 1",
      [productId]
    );
    if (next) await db.run("UPDATE product_units SET is_default = 1 WHERE id = ?", [next.id]);
  }
  await syncProductFromDefaultUnit(db, productId);
}
