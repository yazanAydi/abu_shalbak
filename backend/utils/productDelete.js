/**
 * Remove barcode lookup rows for a product before hard-deleting the product row.
 * Called while foreign keys are disabled so history rows can keep the product_id.
 *
 * @param {object} db
 * @param {number} productId
 */
export async function purgeProductBarcodeRows(db, productId) {
  await purgeProductBarcodeRowsForIds(db, [productId]);
}

/**
 * Batch purge of barcode/unit lookup rows for many products.
 * @param {object} db
 * @param {Array<number|string>} productIds
 */
export async function purgeProductBarcodeRowsForIds(db, productIds) {
  const ids = [...new Set((productIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.run(
    `DELETE FROM product_unit_barcodes
     WHERE product_unit_id IN (SELECT id FROM product_units WHERE product_id IN (${placeholders}))`,
    ids
  );
  await db.run(`DELETE FROM product_units WHERE product_id IN (${placeholders})`, ids);
  await db.run(`DELETE FROM product_barcodes WHERE product_id IN (${placeholders})`, ids);
}
