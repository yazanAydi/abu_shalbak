/**
 * Remove barcode lookup rows for a product before hard-deleting the product row.
 * Called while foreign keys are disabled so history rows can keep the product_id.
 *
 * @param {object} db
 * @param {number} productId
 */
export async function purgeProductBarcodeRows(db, productId) {
  await db.run(
    `DELETE FROM product_unit_barcodes
     WHERE product_unit_id IN (SELECT id FROM product_units WHERE product_id = ?)`,
    [productId]
  );
  await db.run("DELETE FROM product_units WHERE product_id = ?", [productId]);
  await db.run("DELETE FROM product_barcodes WHERE product_id = ?", [productId]);
}
