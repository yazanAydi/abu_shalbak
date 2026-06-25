import { digitsOnly, normalizeBarcodeInput } from "./barcode.js";

/**
 * @param {object} db
 * @param {number} productId
 */
export async function syncProductsPrimaryBarcode(db, productId) {
  const primary = await db.get(
    "SELECT barcode FROM product_barcodes WHERE product_id = ? AND is_primary = 1 LIMIT 1",
    [productId]
  );
  if (!primary) return;

  const owner = await db.get(
    "SELECT id FROM products WHERE CAST(barcode AS TEXT) = ? AND id != ?",
    [primary.barcode, productId]
  );
  if (owner) return;

  await db.run("UPDATE products SET barcode = ? WHERE id = ?", [primary.barcode, productId]);
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {string} rawBarcode
 * @param {{ label?: string | null, isPrimary?: boolean }} [opts]
 * @returns {Promise<{ id: number, barcode: string }>}
 */
export async function addProductBarcode(db, productId, rawBarcode, opts = {}) {
  const barcode = digitsOnly(normalizeBarcodeInput(rawBarcode));
  if (barcode.length < 4 || barcode.length > 14) {
    throw Object.assign(new Error("باركود غير صالح"), { status: 400 });
  }

  const existing = await db.get(
    "SELECT pb.*, p.name AS product_name FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ?",
    [barcode]
  );
  if (existing) {
    if (Number(existing.product_id) === Number(productId)) {
      return { id: existing.id, barcode: existing.barcode, duplicate: true };
    }
    const err = Object.assign(new Error("هذا الباركود مرتبط بمنتج آخر"), { status: 409 });
    err.existingProductId = existing.product_id;
    err.existingProductName = existing.product_name;
    throw err;
  }

  const isPrimary = opts.isPrimary ? 1 : 0;
  if (isPrimary) {
    await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
  } else {
    const hasPrimary = await db.get(
      "SELECT id FROM product_barcodes WHERE product_id = ? AND is_primary = 1",
      [productId]
    );
    if (!hasPrimary) {
      opts.isPrimary = true;
    }
  }

  const info = await db.run(
    "INSERT INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, ?)",
    [productId, barcode, opts.label ?? null, opts.isPrimary ? 1 : isPrimary]
  );

  if (opts.isPrimary || isPrimary) {
    await syncProductsPrimaryBarcode(db, productId);
  }

  return { id: info.lastID, barcode };
}

/**
 * @param {object} db
 * @param {number} productId
 * @param {string} rawBarcode
 * @param {{ label?: string | null, isPrimary?: boolean }} [opts]
 */
export async function ensureProductBarcodeOnCreate(db, productId, rawBarcode, opts = {}) {
  return addProductBarcode(db, productId, rawBarcode, { isPrimary: true, ...opts });
}
