/**
 * One-time repair: when products.barcode holds the رقم (products.sku), promote a
 * real barcode from units/aliases if one can be determined with certainty.
 *
 * products.sku is رقم المنتج (name kept for backward compatibility).
 * products.barcode is the scannable barcode only.
 */
import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import { ensureEntityCode, formatProductSku } from "./entityCodes.js";
import { isProductNumberShaped } from "./suggestedBarcode.js";

export const SKU_BARCODE_SEPARATION_VERSION = "2026.08-sku-barcode-separation";

function storedBarcode(raw) {
  const digits = digitsOnly(normalizeBarcodeInput(raw));
  return digits || null;
}

/**
 * @param {object} db
 */
async function ensureSchemaMigrations(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {unknown} sku
 * @returns {Promise<string[]>}
 */
async function collectDistinctRealBarcodes(db, productId, sku) {
  const [fromUnits, fromAliases] = await Promise.all([
    db.all(
      `SELECT barcode FROM product_units
       WHERE product_id = ? AND barcode IS NOT NULL AND TRIM(barcode) != ''`,
      [productId]
    ),
    db.all(
      `SELECT barcode FROM product_barcodes
       WHERE product_id = ? AND barcode IS NOT NULL AND TRIM(barcode) != ''`,
      [productId]
    ),
  ]);

  const unique = new Set();
  for (const row of [...fromUnits, ...fromAliases]) {
    const code = storedBarcode(row.barcode);
    if (!code) continue;
    if (isProductNumberShaped(code, sku)) continue;
    unique.add(code);
  }
  return [...unique];
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {unknown} sku
 */
async function clearSkuShapedBarcodes(db, productId, sku) {
  const units = await db.all(
    "SELECT id, barcode FROM product_units WHERE product_id = ?",
    [productId]
  );
  for (const unit of units) {
    if (isProductNumberShaped(unit.barcode, sku)) {
      await db.run("UPDATE product_units SET barcode = NULL WHERE id = ?", [unit.id]);
    }
  }

  const aliases = await db.all(
    "SELECT id, barcode FROM product_barcodes WHERE product_id = ?",
    [productId]
  );
  for (const alias of aliases) {
    if (isProductNumberShaped(alias.barcode, sku)) {
      await db.run("DELETE FROM product_barcodes WHERE id = ?", [alias.id]);
    }
  }
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {string} barcode
 * @param {string | null} label
 */
async function promotePrimaryBarcode(db, productId, barcode, label) {
  await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
  const existing = await db.get(
    "SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?",
    [productId, barcode]
  );
  if (existing) {
    await db.run("UPDATE product_barcodes SET is_primary = 1, label = COALESCE(?, label) WHERE id = ?", [
      label,
      existing.id,
    ]);
    return;
  }
  await db.run(
    "INSERT INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, 1)",
    [productId, barcode, label]
  );
}

/**
 * @param {object} db
 * @returns {Promise<{ skipped: boolean, report: object[] }>}
 */
export async function migrateSkuBarcodeSeparation(db) {
  await ensureSchemaMigrations(db);
  const already = await db.get(
    "SELECT version FROM schema_migrations WHERE version = ?",
    [SKU_BARCODE_SEPARATION_VERSION]
  );
  if (already) {
    return { skipped: true, report: [] };
  }

  /** @type {object[]} */
  const report = [];
  const products = await db.all("SELECT id, barcode, sku, name FROM products ORDER BY id");

  for (const product of products) {
    if (!product.barcode || !isProductNumberShaped(product.barcode, product.sku)) {
      continue;
    }

    const candidates = await collectDistinctRealBarcodes(db, product.id, product.sku);
    if (candidates.length === 1) {
      const next = candidates[0];
      const clash = await db.get(
        "SELECT id FROM products WHERE barcode = ? AND id != ?",
        [next, product.id]
      );
      if (clash) {
        await db.run("UPDATE products SET needs_review = 1 WHERE id = ?", [product.id]);
        report.push({
          product_id: product.id,
          name: product.name,
          old_barcode: product.barcode,
          new_barcode: product.barcode,
          action: "flagged",
          reason: "candidate barcode already used by another product",
          candidates,
        });
        continue;
      }

      await db.run("UPDATE products SET barcode = ? WHERE id = ?", [next, product.id]);
      const unitLabel = await db.get(
        "SELECT unit_name FROM product_units WHERE product_id = ? AND barcode = ? LIMIT 1",
        [product.id, next]
      );
      await clearSkuShapedBarcodes(db, product.id, product.sku);
      await promotePrimaryBarcode(db, product.id, next, unitLabel?.unit_name ?? null);
      report.push({
        product_id: product.id,
        name: product.name,
        old_barcode: product.barcode,
        new_barcode: next,
        action: "repaired",
        reason: "promoted distinct unit/alias barcode",
      });
      continue;
    }

    await db.run("UPDATE products SET needs_review = 1 WHERE id = ?", [product.id]);
    report.push({
      product_id: product.id,
      name: product.name,
      old_barcode: product.barcode,
      new_barcode: product.barcode,
      action: "flagged",
      reason:
        candidates.length === 0
          ? "no distinct barcode found on units or aliases"
          : "multiple candidate barcodes; left untouched",
      candidates,
    });
  }

  const after = await db.all("SELECT id, sku FROM products ORDER BY id");
  /** @type {Map<string, number>} */
  const seenSku = new Map();
  for (const product of after) {
    const formatted = formatProductSku(product.sku);
    if (!formatted) continue;
    const owner = seenSku.get(formatted);
    if (owner != null && owner !== product.id) {
      const replacement = await ensureEntityCode(db, "product", null);
      await db.run("UPDATE products SET sku = ?, needs_review = 1 WHERE id = ?", [
        replacement,
        product.id,
      ]);
      report.push({
        product_id: product.id,
        old_sku: product.sku,
        new_sku: replacement,
        action: "sku_reassigned",
        reason: "duplicate رقم after normalize",
      });
      continue;
    }
    seenSku.set(formatted, product.id);
    if (formatted !== product.sku) {
      await db.run("UPDATE products SET sku = ? WHERE id = ?", [formatted, product.id]);
      report.push({
        product_id: product.id,
        old_sku: product.sku,
        new_sku: formatted,
        action: "sku_normalized",
      });
    }
  }

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku
    ON products(sku)
    WHERE sku IS NOT NULL AND TRIM(sku) != '';
  `);

  await db.run("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)", [
    SKU_BARCODE_SEPARATION_VERSION,
  ]);

  try {
    await db.run(
      `INSERT INTO audit_logs (user_id, username, role, action, entity_type, entity_id, old_value, new_value)
       VALUES (NULL, 'system', 'system', 'SKU_BARCODE_REPAIR', 'products', NULL, NULL, ?)`,
      [JSON.stringify({ version: SKU_BARCODE_SEPARATION_VERSION, report })]
    );
  } catch (e) {
    console.warn("[sku-barcode-repair] audit log skipped:", e?.message || e);
  }

  if (report.length) {
    console.info(`[sku-barcode-repair] ${report.length} decision(s):`, JSON.stringify(report));
  } else {
    console.info("[sku-barcode-repair] no rows needed barcode/رقم repair");
  }

  return { skipped: false, report };
}
