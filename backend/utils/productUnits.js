import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import { resolveUnitPrice, buildSourceRowIndexFromProducts } from "./importPriceResolver.js";
import { normalizeUnitName } from "./unitNames.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
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

  await db.run(
    `UPDATE products SET barcode = ?, price = ?, cost = ?, updated_at = datetime('now') WHERE id = ?`,
    [String(unit.barcode), round2(unit.price), round2(unit.cost), productId]
  );

  const existingPb = await db.get(
    "SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?",
    [productId, unit.barcode]
  );
  if (!existingPb) {
    await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
    await db.run(
      "INSERT OR IGNORE INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, 1)",
      [productId, unit.barcode, unit.unit_name]
    );
  } else {
    await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
    await db.run("UPDATE product_barcodes SET is_primary = 1, label = ? WHERE id = ?", [
      unit.unit_name,
      existingPb.id,
    ]);
  }
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {object} data
 */
export async function upsertProductUnit(db, productId, data) {
  const unitName = normalizeUnitName(data.unit_name || data.unitName || "حبة");
  const barcode = digitsOnly(normalizeBarcodeInput(data.barcode));
  if (barcode.length < 4 || barcode.length > 14) {
    throw Object.assign(new Error("باركود غير صالح"), { status: 400 });
  }

  const price = round2(Number(data.price) || 0);
  const cost = round2(Number(data.cost) || 0);
  const conversion = Math.max(0.0001, Number(data.conversion_to_base) || 1);
  const isDefault = data.is_default ? 1 : 0;
  const sourceRowId = data.source_row_id != null ? Number(data.source_row_id) : null;
  const needsReview = data.needs_review ? 1 : 0;

  const owner = await db.get("SELECT id, product_id FROM product_units WHERE barcode = ?", [barcode]);
  const existingByName = await db.get(
    "SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?",
    [productId, unitName]
  );

  if (isDefault) {
    await db.run("UPDATE product_units SET is_default = 0 WHERE product_id = ?", [productId]);
  }

  let unitId;
  if (existingByName) {
    unitId = existingByName.id;
    if (owner && Number(owner.id) !== Number(unitId) && Number(owner.product_id) !== Number(productId)) {
      throw Object.assign(new Error("هذا الباركود مرتبط بوحدة أخرى"), { status: 409 });
    }
    await db.run(
      `UPDATE product_units SET barcode = ?, price = ?, cost = ?, conversion_to_base = ?,
       is_default = ?, needs_review = ?, source_row_id = COALESCE(?, source_row_id), updated_at = datetime('now')
       WHERE id = ?`,
      [barcode, price, cost, conversion, isDefault, needsReview, sourceRowId, unitId]
    );
  } else if (owner) {
    if (Number(owner.product_id) !== Number(productId)) {
      throw Object.assign(new Error("هذا الباركود مرتبط بمنتج آخر"), { status: 409 });
    }
    unitId = owner.id;
    await db.run(
      `UPDATE product_units SET unit_name = ?, price = ?, cost = ?, conversion_to_base = ?,
       is_default = ?, needs_review = ?, source_row_id = COALESCE(?, source_row_id), updated_at = datetime('now')
       WHERE id = ?`,
      [unitName, price, cost, conversion, isDefault, needsReview, sourceRowId, unitId]
    );
  } else {
    const info = await db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, needs_review, source_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, unitName, barcode, price, cost, conversion, isDefault, needsReview, sourceRowId]
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
 * Repair product_units.price from barcode→product price index (e.g. after migration or re-import).
 * @param {object} db
 * @param {import("./importPriceResolver.js").SourceRowIndex | null} [sourceIndex]
 */
export async function repairProductUnitPrices(db, sourceIndex = null) {
  const index = sourceIndex ?? (await buildSourceRowIndexFromProducts(db));
  const units = await db.all(`
    SELECT pu.*, p.barcode AS product_barcode, p.price AS product_price
    FROM product_units pu
    JOIN products p ON p.id = pu.product_id
    ORDER BY pu.id ASC
  `);

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
