import { digitsOnly, normalizeBarcodeInput, parseUnitBarcodeLines } from "./barcode.js";
import { ensureEntityCode, assignEntityCodeIfMissing } from "./entityCodes.js";
import {
  buildSourceRowIndex,
  buildSourceRowIndexFromProducts,
  mergeSourceRowIndexes,
  resolveUnitPrice,
} from "./importPriceResolver.js";
import { syncProductsPrimaryBarcode } from "./productBarcodes.js";
import {
  repairProductUnitPrices,
  syncProductFromDefaultUnit,
  upsertProductUnit,
} from "./productUnits.js";
import { looksLikePackOnlyProduct, normalizeUnitName } from "./unitNames.js";

/**
 * @param {object} db
 * @param {string} barcode
 */
async function findProductIdByAnyBarcode(db, barcode) {
  const bc = digitsOnly(normalizeBarcodeInput(barcode));
  if (!bc) return null;

  const fromUnit = await db.get("SELECT product_id FROM product_units WHERE barcode = ?", [bc]);
  if (fromUnit) return fromUnit.product_id;

  const fromAlias = await db.get(
    `SELECT pu.product_id FROM product_unit_barcodes pub
     JOIN product_units pu ON pu.id = pub.product_unit_id WHERE pub.barcode = ?`,
    [bc]
  );
  if (fromAlias) return fromAlias.product_id;

  const fromPb = await db.get("SELECT product_id FROM product_barcodes WHERE barcode = ?", [bc]);
  if (fromPb) return fromPb.product_id;

  const fromProduct = await db.get(
    "SELECT id AS product_id FROM products WHERE CAST(barcode AS TEXT) = ?",
    [bc]
  );
  if (fromProduct) return fromProduct.product_id;

  return null;
}

/**
 * @param {object} db
 * @param {string} primaryBc
 * @param {{ barcode: string }[]} barcodes
 */
async function resolveImportProductId(db, primaryBc, barcodes) {
  const primary = digitsOnly(normalizeBarcodeInput(primaryBc));
  if (primary) {
    const hit = await findProductIdByAnyBarcode(db, primary);
    if (hit) return hit;
  }
  for (const { barcode: bc } of barcodes) {
    const hit = await findProductIdByAnyBarcode(db, bc);
    if (hit) return hit;
  }
  return null;
}

function namesLikelySame(a, b) {
  const na = String(a ?? "").trim().toLowerCase();
  const nb = String(b ?? "").trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(/\s+/).filter((w) => w.length > 2);
  const wb = nb.split(/\s+/).filter((w) => w.length > 2);
  return wa.some((w) => wb.includes(w));
}

/**
 * @param {string} productName
 * @param {string} unitName
 * @param {string} unitBarcode
 * @param {{ price: number, source: string, needsReview: boolean, matchedRowNum?: number }} resolved
 */
function logUnitPriceResolution(productName, unitName, unitBarcode, resolved) {
  const extra =
    resolved.matchedRowNum != null ? ` matchedRow=${resolved.matchedRowNum}` : "";
  const review = resolved.needsReview ? " needs_review=true" : "";
  console.info(
    `[import:unit-price] product="${productName}" unit="${unitName}" barcode="${unitBarcode}" price=${resolved.price} source=${resolved.source}${extra}${review}`
  );
}

/**
 * @param {object} db
 * @param {{ rowNum: number, row: object }[]} validRows
 */
export async function persistProductImportRows(db, validRows) {
  const sourceIndex = buildSourceRowIndex(validRows);
  /** @type {Set<number>} */
  const absorbedRows = new Set();

  let products_created = 0;
  let products_updated = 0;
  let units_upserted = 0;
  let barcodes_added = 0;
  let duplicate_barcodes_skipped = 0;
  let needs_review_count = 0;
  /** @type {{ row: number, barcode: string, existing_product_id: number, existing_product_name: string }[]} */
  const barcode_conflicts = [];
  /** @type {{ row: number, reason: string }[]} */
  const rowErrors = [];

  for (const { rowNum, row } of validRows) {
    await db.run("SAVEPOINT import_row");
    try {
      const {
        barcode,
        barcodes,
        name,
        name_en,
        price,
        cost,
        category,
        stock,
        tax_rate,
        unit,
        expiry_date,
        min_price,
        max_price,
        sku,
        _rawUnitBarcodes,
      } = row;

      const primaryBc = digitsOnly(normalizeBarcodeInput(barcode));
      if (!primaryBc) {
        await db.run("RELEASE SAVEPOINT import_row");
        continue;
      }

      const currentRowPrice = Number(price) || 0;
      const unitLines = parseUnitBarcodeLines(_rawUnitBarcodes ?? "");
      const linkedOwner = await findProductIdByAnyBarcode(db, primaryBc);
      const isPackOnly = looksLikePackOnlyProduct(name);

      if (linkedOwner && isPackOnly) {
        const owner = await db.get("SELECT id, name FROM products WHERE id = ?", [linkedOwner]);
        const unitRow = await db.get(
          "SELECT * FROM product_units WHERE product_id = ? AND barcode = ?",
          [linkedOwner, primaryBc]
        );
        if (unitRow) {
          const resolved = resolveUnitPrice({
            unitBarcode: primaryBc,
            currentRowNum: rowNum,
            currentRowPrimary: primaryBc,
            currentRowPrice,
            sourceIndex,
          });
          logUnitPriceResolution(name, unitRow.unit_name, primaryBc, resolved);
          await db.run(
            `UPDATE product_units SET price = ?, cost = ?, needs_review = ?, updated_at = datetime('now') WHERE id = ?`,
            [
              resolved.price,
              Number(cost) || unitRow.cost,
              resolved.needsReview ? 1 : 0,
              unitRow.id,
            ]
          );
          if (resolved.needsReview) needs_review_count++;
          units_upserted++;
          absorbedRows.add(rowNum);
          await syncProductFromDefaultUnit(db, linkedOwner);
          await db.run("RELEASE SAVEPOINT import_row");
          continue;
        }
        if (owner && !namesLikelySame(name, owner.name)) {
          await db.run("UPDATE products SET needs_review = 1 WHERE id = ?", [linkedOwner]);
          needs_review_count++;
        }
      }

      let productId = await resolveImportProductId(db, primaryBc, barcodes);

      const productFields = [
        name,
        name_en ?? null,
        currentRowPrice,
        Number(cost) || 0,
        category ?? null,
        Number(stock) || 0,
        tax_rate ?? null,
        unit ?? null,
        expiry_date ?? null,
        min_price ?? null,
        max_price ?? null,
      ];

      if (productId) {
        await db.run(
          `UPDATE products SET name = ?, name_en = ?, price = ?, cost = ?, category = ?, stock = ?,
              tax_rate = ?, unit = ?, expiry_date = ?, min_price = ?, max_price = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [...productFields, productId]
        );
        await assignEntityCodeIfMissing(db, "product", productId);
        products_updated++;
      } else if (isPackOnly && linkedOwner) {
        productId = linkedOwner;
        absorbedRows.add(rowNum);
      } else {
        const insertSku = await ensureEntityCode(db, "product", sku);
        const info = await db.run(
          `INSERT INTO products (barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [primaryBc, ...productFields, insertSku]
        );
        productId = info.lastID;
        products_created++;
      }

      /** @type {Map<string, { unitName: string, barcodes: string[], price: number, isDefault: boolean, needsReview: boolean }>} */
      const unitsByName = new Map();

      const defaultUnitName = normalizeUnitName(unit || "حبة");
      const defaultResolved = resolveUnitPrice({
        unitBarcode: primaryBc,
        currentRowNum: rowNum,
        currentRowPrimary: primaryBc,
        currentRowPrice,
        sourceIndex,
      });
      logUnitPriceResolution(name, defaultUnitName, primaryBc, defaultResolved);
      if (defaultResolved.needsReview) needs_review_count++;

      unitsByName.set(defaultUnitName, {
        unitName: defaultUnitName,
        barcodes: [primaryBc],
        price: defaultResolved.price,
        isDefault: true,
        needsReview: defaultResolved.needsReview,
      });

      for (const line of unitLines) {
        const unitName = normalizeUnitName(line.unitName);
        const unitBc = digitsOnly(normalizeBarcodeInput(line.barcodes[0]));
        if (!unitBc) continue;

        const resolved = resolveUnitPrice({
          unitBarcode: unitBc,
          currentRowNum: rowNum,
          currentRowPrimary: primaryBc,
          currentRowPrice,
          sourceIndex,
        });
        logUnitPriceResolution(name, unitName, unitBc, resolved);
        if (resolved.needsReview) needs_review_count++;

        const existing = unitsByName.get(unitName);
        if (existing) {
          existing.barcodes.push(...line.barcodes.filter((b) => !existing.barcodes.includes(b)));
          existing.price = resolved.price;
          existing.needsReview = resolved.needsReview;
          if (line.barcodes.some((b) => digitsOnly(normalizeBarcodeInput(b)) === primaryBc)) {
            existing.isDefault = true;
          }
        } else {
          unitsByName.set(unitName, {
            unitName,
            barcodes: [...line.barcodes],
            price: resolved.price,
            isDefault: line.barcodes.some((b) => digitsOnly(normalizeBarcodeInput(b)) === primaryBc),
            needsReview: resolved.needsReview,
          });
        }
      }

      for (const entry of barcodes || []) {
        const bc = digitsOnly(normalizeBarcodeInput(entry.barcode));
        if (!bc) continue;
        const unitName = normalizeUnitName(entry.label || defaultUnitName);

        const resolved = resolveUnitPrice({
          unitBarcode: bc,
          currentRowNum: rowNum,
          currentRowPrimary: primaryBc,
          currentRowPrice,
          sourceIndex,
        });
        logUnitPriceResolution(name, unitName, bc, resolved);
        if (resolved.needsReview) needs_review_count++;

        const existing = unitsByName.get(unitName);
        if (existing) {
          if (!existing.barcodes.includes(bc)) existing.barcodes.push(bc);
          existing.price = resolved.price;
          existing.needsReview = resolved.needsReview;
          if (bc === primaryBc) existing.isDefault = true;
        } else {
          unitsByName.set(unitName, {
            unitName,
            barcodes: [bc],
            price: resolved.price,
            isDefault: bc === primaryBc,
            needsReview: resolved.needsReview,
          });
        }
      }

      if (![...unitsByName.values()].some((u) => u.isDefault)) {
        const first = unitsByName.values().next().value;
        if (first) first.isDefault = true;
      }

      for (const unitDef of unitsByName.values()) {
        const primaryUnitBc = digitsOnly(normalizeBarcodeInput(unitDef.barcodes[0]));
        const aliasBarcodes = unitDef.barcodes.slice(1);
        try {
          await upsertProductUnit(db, productId, {
            unit_name: unitDef.unitName,
            barcode: primaryUnitBc,
            price: unitDef.price,
            cost: Number(cost) || 0,
            conversion_to_base: 1,
            is_default: unitDef.isDefault,
            needs_review: unitDef.needsReview,
            source_row_id: rowNum,
            alias_barcodes: aliasBarcodes,
          });
          units_upserted++;
          barcodes_added += unitDef.barcodes.length;
        } catch (e) {
          if (e.status === 409) {
            barcode_conflicts.push({
              row: rowNum,
              barcode: primaryUnitBc,
              existing_product_id: productId,
              existing_product_name: name,
            });
            duplicate_barcodes_skipped++;
          } else {
            throw e;
          }
        }
      }

      for (const entry of barcodes || []) {
        const bc = digitsOnly(normalizeBarcodeInput(entry.barcode));
        if (!bc) continue;
        const existing = await db.get(
          "SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?",
          [productId, bc]
        );
        if (existing) {
          duplicate_barcodes_skipped++;
          continue;
        }
        const conflict = await db.get(
          "SELECT pb.product_id, p.name FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ? AND pb.product_id != ?",
          [bc, productId]
        );
        if (conflict) {
          barcode_conflicts.push({
            row: rowNum,
            barcode: bc,
            existing_product_id: conflict.product_id,
            existing_product_name: conflict.name,
          });
          if (!namesLikelySame(name, conflict.name)) {
            await db.run("UPDATE products SET needs_review = 1 WHERE id = ?", [productId]);
            needs_review_count++;
          }
          continue;
        }
        const isPrimary = bc === primaryBc ? 1 : 0;
        if (isPrimary) {
          await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
        }
        await db.run(
          "INSERT INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, ?)",
          [productId, bc, entry.label ?? null, isPrimary]
        );
      }

      await syncProductsPrimaryBarcode(db, productId);
      await syncProductFromDefaultUnit(db, productId);
      await db.run("RELEASE SAVEPOINT import_row");
    } catch (rowErr) {
      try {
        await db.run("ROLLBACK TO SAVEPOINT import_row");
      } catch (_) {}
      rowErrors.push({
        row: rowNum,
        reason:
          rowErr.code === "SQLITE_CONSTRAINT"
            ? `تعارض باركود: ${rowErr.message}`
            : rowErr.message || "فشل استيراد الصف",
      });
    }
  }

  const dbIndex = await buildSourceRowIndexFromProducts(db);
  const mergedIndex = mergeSourceRowIndexes(dbIndex, sourceIndex);
  const repairResult = await repairProductUnitPrices(db, mergedIndex);

  return {
    products_created,
    products_updated,
    units_upserted,
    barcodes_added,
    duplicate_barcodes_skipped,
    barcode_conflicts,
    needs_review_count: needs_review_count + repairResult.needs_review_count,
    units_repaired: repairResult.updated,
    absorbed_rows: absorbedRows.size,
    row_errors: rowErrors,
  };
}
