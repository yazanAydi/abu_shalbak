import { barcodeLookupKeys, digitsOnly, normalizeBarcodeInput, parseWeightBarcode, findProductByBarcode } from "./barcode.js";
import { formatProductUnit, findKgUnit, isKgUnit, loadUnitsForProduct, resolveScaleCode } from "./productUnits.js";
import { isBakeryMaterial, isUnitSaleEnabled } from "./bakeryMembership.js";

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
 * Another product already owns this exact code as a barcode or a scale PLU.
 * Same-product matches are ignored so a weighed item can keep its own codes.
 * @param {object} db
 * @param {string} code
 * @param {number} productId
 */
async function otherProductOwnsCode(db, code, productId) {
  if (!code) return null;
  return db.get(
    `SELECT id, name FROM (
       SELECT id, name FROM products WHERE barcode = ? AND id != ?
       UNION ALL
       SELECT p.id, p.name
         FROM product_barcodes pb
         JOIN products p ON p.id = pb.product_id
        WHERE pb.barcode = ? AND pb.product_id != ?
       UNION ALL
       SELECT p.id, p.name
         FROM product_units pu
         JOIN products p ON p.id = pu.product_id
        WHERE pu.barcode = ? AND pu.product_id != ?
       UNION ALL
       SELECT p.id, p.name
         FROM product_unit_barcodes pub
         JOIN product_units pu ON pu.id = pub.product_unit_id
         JOIN products p ON p.id = pu.product_id
        WHERE pub.barcode = ? AND pu.product_id != ?
     ) AS owners LIMIT 1`,
    [code, productId, code, productId, code, productId, code, productId]
  );
}

/**
 * Build API response for barcode lookup.
 * @param {object} db
 * @param {unknown} rawCode
 * @param {{ forPos?: boolean }} [options] POS callers must not receive units that are not sale_enabled
 */
export async function buildBarcodeLookupResponse(db, rawCode, options = {}) {
  const forPos = options.forPos === true;
  const scannedBarcode = normalizeBarcodeInput(rawCode);
  let found = await findProductUnitByBarcode(db, rawCode);

  if (!found) {
    const byProduct = await findProductByBarcode(db, scannedBarcode);
    if (byProduct?.product) {
      const product = byProduct.product;
      const availableUnits = await loadUnitsForProduct(db, product.id);
      const matchedDigits = digitsOnly(byProduct.matchedBarcode || scannedBarcode);
      const matchedUnit =
        availableUnits.find((u) => u.barcode && digitsOnly(u.barcode) === matchedDigits) ||
        availableUnits.find((u) => u.is_default) ||
        availableUnits[0] ||
        null;
      if (matchedUnit) {
        found = {
          product,
          selectedUnit: matchedUnit,
          availableUnits,
          scannedBarcode,
          matchedBarcode: byProduct.matchedBarcode || matchedUnit.barcode,
          productBarcodeId: byProduct.productBarcodeId ?? null,
        };
      }
    }
  }

  /** @type {{ productCode: string, weightKg: number } | null} */
  let weightInfo = null;
  if (!found) {
    const parsed = parseWeightBarcode(scannedBarcode);
    if (parsed) {
      found = await findProductUnitByBarcode(db, parsed.productCode);
      if (found && Number(found.product.is_weighed) === 1) {
        weightInfo = { productCode: parsed.productCode, weightKg: parsed.weightKg };
        const kgUnit = findKgUnit(found.availableUnits);
        if (kgUnit) {
          found = { ...found, selectedUnit: kgUnit };
        }
      } else {
        found = null;
      }
    }
  }

  if (!found) return null;

  const identityCode = weightInfo
    ? weightInfo.productCode
    : digitsOnly(found.matchedBarcode || scannedBarcode);
  const otherOwner = await otherProductOwnsCode(db, identityCode, found.product.id);
  if (otherOwner) {
    return {
      conflict: true,
      error: "هذا الرمز مستخدم لأكثر من منتج",
    };
  }

  const { product, selectedUnit, availableUnits, matchedBarcode, productBarcodeId } = found;
  if (Number(product.is_active) === 0) {
    return { inactive: true, product };
  }

  const matchedUnitName = selectedUnit?.unit_name ?? null;

  const bakery = isBakeryMaterial(product);
  const saleUnits = availableUnits.filter((u) => isUnitSaleEnabled(u));
  if (forPos && bakery && !saleUnits.length) return null;
  const posUnits = saleUnits.length ? saleUnits : availableUnits;
  let effectiveUnit = selectedUnit;
  if (weightInfo) {
    effectiveUnit = findKgUnit(posUnits) || findKgUnit(availableUnits) || selectedUnit;
  } else if (!isUnitSaleEnabled(selectedUnit)) {
    effectiveUnit =
      posUnits.find((u) => u.is_default) ||
      posUnits[0] ||
      selectedUnit;
  }
  if (!effectiveUnit) return null;
  if (forPos && bakery && !isUnitSaleEnabled(effectiveUnit)) return null;

  const baseResponse = {
    product: {
      id: product.id,
      name: product.name,
      name_en: product.name_en ?? null,
      stock: product.stock,
      category: product.category,
      tax_rate: product.tax_rate ?? null,
      barcode: product.barcode,
      price: product.price,
      cost: product.cost,
      needs_review: Number(product.needs_review) === 1,
      is_weighed: Number(product.is_weighed) === 1,
      scale_only: Number(product.scale_only) === 1,
      scale_code: resolveScaleCode(product, availableUnits),
      inventory_scope: product.inventory_scope || "retail",
    },
    selectedUnit: effectiveUnit,
    availableUnits: posUnits,
    scanned_barcode: scannedBarcode,
    matched_barcode: matchedBarcode,
    matched_unit_name: matchedUnitName,
    product_unit_id: effectiveUnit.id,
    product_barcode_id: productBarcodeId ?? effectiveUnit.id,
    // Legacy flat fields for existing clients
    id: product.id,
    barcode: effectiveUnit.barcode,
    name: product.name,
    price: effectiveUnit.price,
    stock: product.stock,
    tax_rate: product.tax_rate ?? null,
    inventory_scope: product.inventory_scope || "retail",
    unit_id: effectiveUnit.id,
    unit_name: effectiveUnit.unit_name,
    conversion_to_base: effectiveUnit.conversion_to_base,
  };

  if (weightInfo) {
    return {
      ...baseResponse,
      weighed: true,
      weight: weightInfo.weightKg,
      quantity: weightInfo.weightKg,
      needs_weight: false,
    };
  }

  return {
    ...baseResponse,
    needs_weight: isKgUnit(effectiveUnit),
  };
}
