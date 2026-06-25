/**
 * One-shot retail import row for هدايا فبراير — run after code updates to backfill unit barcodes.
 * Usage: node scripts/run-retail-import-once.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import dotenv from "dotenv";
import { initDatabase } from "../database/init.js";
import { xlsxBufferToHeaderRows, normalizeProductRow } from "../utils/productImport.js";
import { syncProductsPrimaryBarcode } from "../utils/productBarcodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const FEBRUARY_PRODUCT_NAME = "هدايا فبراير 6064";
const FEBRUARY_UNIT_BARCODE = "6223001858911";

function buildBuffer() {
  const unitBarcodes = [
    "علبة : 9800200498",
    "حبة : 6223001858942",
    `حبة : ${FEBRUARY_UNIT_BARCODE}`,
    "حبة : 6223001858935",
    "حبة : 6223001859291",
    "حبة : 6223001858904",
  ].join("\n");
  const sheet = XLSX.utils.aoa_to_sheet([
    ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
    [6064, FEBRUARY_PRODUCT_NAME, "9800200498", unitBarcodes, 15],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const dbPath = path.resolve(__dirname, "../../", process.env.DATABASE_PATH || "./data/supermarket.db");
const db = await initDatabase(dbPath);
const records = xlsxBufferToHeaderRows(buildBuffer());

let products_created = 0;
let products_updated = 0;
let barcodes_added = 0;
const barcode_conflicts = [];

await db.run("BEGIN IMMEDIATE");
try {
  for (const rec of records) {
    const norm = normalizeProductRow(rec);
    if (!norm.ok) continue;
    const { barcode, barcodes, name, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku } =
      norm.row;
    const skuVal = sku ? String(sku).trim() : null;

    let productId = null;
    for (const { barcode: bc } of barcodes) {
      const hit = await db.get(
        `SELECT pb.product_id FROM product_barcodes pb WHERE pb.barcode = ?`,
        [bc]
      );
      if (hit) {
        productId = hit.product_id;
        break;
      }
    }
    if (!productId) {
      for (const { barcode: bc } of barcodes) {
        const hit = await db.get(`SELECT id AS product_id FROM products WHERE CAST(barcode AS TEXT) = ?`, [bc]);
        if (hit) {
          productId = hit.product_id;
          break;
        }
      }
    }

    if (productId) {
      if (skuVal) {
        await db.run(
          `UPDATE products SET barcode = ?, sku = ?, name = ?, price = ?, cost = ?, category = ?, stock = ?,
              tax_rate = ?, unit = ?, expiry_date = ?, min_price = ?, max_price = ? WHERE id = ?`,
          [barcode, skuVal, name, price, cost, category, stock, tax_rate ?? null, unit ?? null, expiry_date ?? null, min_price ?? null, max_price ?? null, productId]
        );
      } else {
        await db.run(
          `UPDATE products SET barcode = ?, name = ?, price = ?, cost = ?, category = ?, stock = ?,
              tax_rate = ?, unit = ?, expiry_date = ?, min_price = ?, max_price = ? WHERE id = ?`,
          [barcode, name, price, cost, category, stock, tax_rate ?? null, unit ?? null, expiry_date ?? null, min_price ?? null, max_price ?? null, productId]
        );
      }
      products_updated++;
    } else {
      const info = await db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [barcode, name, price, cost, category, stock, tax_rate ?? null, unit ?? null, expiry_date ?? null, min_price ?? null, max_price ?? null, skuVal]
      );
      productId = info.lastID;
      products_created++;
    }

    for (const entry of barcodes) {
      const bc = String(entry.barcode ?? "").trim();
      if (!bc) continue;
      const existing = await db.get(`SELECT product_id FROM product_barcodes WHERE barcode = ?`, [bc]);
      if (existing) {
        if (Number(existing.product_id) !== Number(productId)) {
          barcode_conflicts.push({ barcode: bc, existing_product_id: existing.product_id });
        }
        continue;
      }
      const isPrimary = entry.is_primary === true || bc === String(barcode ?? "").trim() ? 1 : 0;
      if (isPrimary) {
        await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [productId]);
      }
      await db.run(
        "INSERT INTO product_barcodes (product_id, barcode, label, is_primary) VALUES (?, ?, ?, ?)",
        [productId, bc, entry.label ?? null, isPrimary]
      );
      barcodes_added++;
    }
    await syncProductsPrimaryBarcode(db, productId);
  }
  await db.run("COMMIT");
} catch (e) {
  await db.run("ROLLBACK");
  throw e;
}

const unitRow = await db.get(
  `SELECT p.id, p.name FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ?`,
  [FEBRUARY_UNIT_BARCODE]
);

console.log(
  JSON.stringify(
    {
      products_created,
      products_updated,
      barcodes_added,
      barcode_conflicts,
      unitBarcodeFound: Boolean(unitRow),
      product: unitRow,
    },
    null,
    2
  )
);
