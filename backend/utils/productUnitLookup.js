import { barcodeLookupKeys, digitsOnly, normalizeBarcodeInput } from "./barcode.js";
import { formatProductUnit, loadUnitsForProduct } from "./productUnits.js";

/**
 * @param {object} db
 * @param {string} key
 */
async function findUnitByBarcodeKey(db, key) {
  let row = await db.get(
    `SELECT pu.* FROM product_units pu WHERE pu.barcode = ?`,
    [key]
  );
  if (row) return { unit: row, matchedBarcode: row.barcode };

  row = await db.get(
    `SELECT pu.*, pub.barcode AS matched_barcode
     FROM product_unit_barcodes pub
     JOIN product_units pu ON pu.id = pub.product_unit_id
     WHERE pub.barcode = ?`,
    [key]
  );
  if (row) return { unit: row, matchedBarcode: row.matched_barcode };

  return null;
}

/**
 * @param {object} db
 * @param {unknown} rawCode
 */
export async function findProductUnitByBarcode(db, rawCode) {
  const scannedBarcode = normalizeBarcodeInput(rawCode);
  if (!scannedBarcode) return null;

  const keys = barcodeLookupKeys(scannedBarcode);
  for (const k of keys) {
    const hit = await findUnitByBarcodeKey(db, k);
    if (hit) {
      const product = await db.get("SELECT * FROM products WHERE id = ?", [hit.unit.product_id]);
      if (!product) return null;
      const availableUnits = await loadUnitsForProduct(db, product.id);
      return {
        product,
        selectedUnit: formatProductUnit(hit.unit),
        availableUnits,
        scannedBarcode,
        matchedBarcode: hit.matchedBarcode,
      };
    }
  }

  const d = digitsOnly(scannedBarcode);
  if (d.length >= 4 && d.length <= 14 && d !== scannedBarcode) {
    const hit = await findUnitByBarcodeKey(db, d);
    if (hit) {
      const product = await db.get("SELECT * FROM products WHERE id = ?", [hit.unit.product_id]);
      if (!product) return null;
      const availableUnits = await loadUnitsForProduct(db, product.id);
      return {
        product,
        selectedUnit: formatProductUnit(hit.unit),
        availableUnits,
        scannedBarcode,
        matchedBarcode: hit.matchedBarcode,
      };
    }
  }

  return null;
}

/**
 * Build API response for barcode lookup.
 * @param {object} db
 * @param {unknown} rawCode
 */
export async function buildBarcodeLookupResponse(db, rawCode) {
  const found = await findProductUnitByBarcode(db, rawCode);
  if (!found) return null;

  const { product, selectedUnit, availableUnits, scannedBarcode, matchedBarcode } = found;
  if (Number(product.is_active) === 0) {
    return { inactive: true, product };
  }

  return {
    product: {
      id: product.id,
      name: product.name,
      name_en: product.name_en ?? null,
      stock: product.stock,
      category: product.category,
      tax_rate: product.tax_rate ?? null,
      barcode: product.barcode,
      cost: product.cost,
      needs_review: Number(product.needs_review) === 1,
    },
    selectedUnit,
    availableUnits,
    scanned_barcode: scannedBarcode,
    matched_barcode: matchedBarcode,
    product_unit_id: selectedUnit.id,
    product_barcode_id: selectedUnit.id,
    // Legacy flat fields for existing clients
    id: product.id,
    barcode: selectedUnit.barcode,
    name: product.name,
    price: selectedUnit.price,
    stock: product.stock,
    tax_rate: product.tax_rate ?? null,
    unit_id: selectedUnit.id,
    unit_name: selectedUnit.unit_name,
    conversion_to_base: selectedUnit.conversion_to_base,
  };
}
