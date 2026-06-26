import { normalizeBarcodeInput } from "./barcode.js";
import { detectImportType } from "./importDetect.js";
import { formatProductNumber } from "./productImport.js";
import { assignEntityCodeIfMissing, ensureEntityCode } from "./entityCodes.js";
import {
  assertMatrixRowCap,
  findHeaderRowIndex,
  mapColumns,
  matrixToFieldRecords,
  normalizeHeaderCell,
  readXlsxMatrix,
} from "./xlsxHelpers.js";

const PRICE_LIST_PATTERNS = {
  sku: [/^الرقم$|^#$|^no\.?$/i],
  barcode: [/^باركود$|^الباركود$|^كود\s*الصنف$|^رقم\s*الصنف$|^barcode$/i],
  name: [/^الاسم$|^اسم\s*الصنف$|^الصنف$|^name$/i],
  price: [/^مفرق$|^السعر$|^سعر\s*البيع$|^price$/i],
  wholesale: [/^جملة$|^سعر\s*الجملة$|^wholesale$/i],
  half_wholesale: [/^نصف\s*جملة$|^نصف\s*الجملة$/i],
};

/**
 * @param {unknown} val
 */
function parseMoney(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const s = String(val).trim().replace(/,/g, ".");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown[][]} matrix
 * @param {number} headerRowIndex
 */
export function parsePriceListMatrix(matrix, headerRowIndex) {
  const headers = (matrix[headerRowIndex] || []).map(normalizeHeaderCell);
  const colMap = mapColumns(headers, PRICE_LIST_PATTERNS);
  if (colMap.barcode === undefined && colMap.name === undefined) {
    throw new Error("تعذّر العثور على أعمدة الباركود أو الاسم في قائمة الأسعار.");
  }
  if (colMap.price === undefined && colMap.wholesale === undefined) {
    throw new Error("تعذّر العثور على عمود السعر (مفرق/جملة) في قائمة الأسعار.");
  }

  const fieldToCol = { ...colMap };
  assertMatrixRowCap(matrix, headerRowIndex);
  const raw = matrixToFieldRecords(matrix, headerRowIndex, fieldToCol);

  return raw.map((row) => {
    const barcodeRaw = row.barcode != null ? String(row.barcode).trim() : "";
    const barcode = barcodeRaw ? normalizeBarcodeInput(barcodeRaw) || barcodeRaw : "";
    const name = String(row.name ?? "").trim();
    const price = parseMoney(row.price) ?? parseMoney(row.wholesale);
    const min_price = parseMoney(row.wholesale);
    const max_price = parseMoney(row.half_wholesale);
    const sku = formatProductNumber(row.sku);

    return {
      rowNum: Number(row._rowNum) || 0,
      barcode,
      name,
      price,
      min_price: min_price !== price ? min_price : null,
      max_price,
      sku,
    };
  });
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export function parsePriceListFile(buffer, filename) {
  const { matrix } = readXlsxMatrix(buffer);
  if (!matrix.length) return [];

  const detected = detectImportType(matrix, filename);
  const headerIdx =
    detected.headerRowIndex >= 0
      ? detected.headerRowIndex
      : findHeaderRowIndex(matrix, (headers) => {
          const hasBarcode = headers.some((h) => PRICE_LIST_PATTERNS.barcode.some((re) => re.test(h)));
          const hasPrice = headers.some((h) =>
            [...PRICE_LIST_PATTERNS.price, ...PRICE_LIST_PATTERNS.wholesale].some((re) => re.test(h))
          );
          return hasBarcode && hasPrice;
        });

  if (headerIdx < 0) {
    throw new Error("تعذّر تحليل قائمة الأسعار — تحقق من عناوين الأعمدة.");
  }

  return parsePriceListMatrix(matrix, headerIdx);
}

/**
 * @param {object} db
 * @param {string} primaryBc
 * @param {{ barcode: string }[]} [barcodes]
 */
async function resolveProductIdByBarcode(db, primaryBc) {
  const primary = String(primaryBc ?? "").trim();
  if (!primary) return null;

  const fromProducts = await db.get(
    `SELECT id AS product_id FROM products WHERE CAST(barcode AS TEXT) = ?`,
    [primary]
  );
  if (fromProducts) return fromProducts.product_id;

  const fromPb = await db.get(`SELECT product_id FROM product_barcodes WHERE barcode = ?`, [primary]);
  return fromPb?.product_id ?? null;
}

/**
 * @param {object} db
 * @param {ReturnType<parsePriceListFile>[number][]} rows
 * @param {{ createMissing?: boolean }} [options]
 */
export async function applyPriceListImport(db, rows, options = {}) {
  const createMissing = options.createMissing !== false;

  let updated = 0;
  let created = 0;
  let skipped = 0;
  let not_found = 0;
  /** @type {{ row: number, reason: string, barcode?: string }[]} */
  const errors = [];

  await db.run("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      if (!row.barcode && !row.name) {
        errors.push({ row: row.rowNum, reason: "باركود واسم مفقودان" });
        skipped++;
        continue;
      }
      if (row.price == null || !Number.isFinite(row.price)) {
        errors.push({ row: row.rowNum, barcode: row.barcode, reason: "السعر غير صالح" });
        skipped++;
        continue;
      }

      let productId = row.barcode ? await resolveProductIdByBarcode(db, row.barcode) : null;

      if (!productId && row.name) {
        const byName = await db.get(`SELECT id FROM products WHERE TRIM(name) = ? LIMIT 1`, [row.name]);
        productId = byName?.id ?? null;
      }

      if (productId) {
        await db.run(
          `UPDATE products SET price = ?, min_price = COALESCE(?, min_price), max_price = COALESCE(?, max_price)
           WHERE id = ?`,
          [row.price, row.min_price, row.max_price, productId]
        );
        await db.run(
          `UPDATE product_units SET price = ?, updated_at = datetime('now')
           WHERE product_id = ? AND is_default = 1`,
          [row.price, productId]
        );
        await assignEntityCodeIfMissing(db, "product", productId);
        updated++;
        continue;
      }

      if (!createMissing || !row.barcode || !row.name) {
        not_found++;
        errors.push({
          row: row.rowNum,
          barcode: row.barcode,
          reason: "لم يُعثر على منتج مطابق",
        });
        continue;
      }

      const insertSku = await ensureEntityCode(db, "product", null);
      await db.run(
        `INSERT INTO products (barcode, name, price, cost, stock, min_price, max_price, sku)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
        [row.barcode, row.name, row.price, row.min_price, row.max_price, insertSku]
      );
      created++;
    }
    await db.run("COMMIT");
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }

  return {
    type: "hesabati_price_list",
    products_created: created,
    products_updated: updated,
    created,
    updated,
    skipped,
    not_found,
    errors,
    message: `قائمة الأسعار: ${updated} محدّث، ${created} جديد، ${not_found} غير موجود`,
  };
}

/**
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ createMissing?: boolean }} [options]
 */
export async function importPriceListFromBuffer(db, buffer, filename, options = {}) {
  const rows = parsePriceListFile(buffer, filename);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  return applyPriceListImport(db, rows, options);
}
