/**
 * Seed a large SQLite file for performance benchmarks.
 *
 * Usage:
 *   node scripts/seed-perf-db.mjs
 *   node scripts/seed-perf-db.mjs --products 50000 --transactions 100000
 *
 * Writes backend/data/perf.db (override with --out or PERF_DB_PATH).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "../database/init.js";
import { formatProductSku } from "../utils/entityCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const PRODUCT_COUNT = Math.max(100, Number(arg("products", process.env.PERF_PRODUCTS || 25000)));
const TX_COUNT = Math.max(0, Number(arg("transactions", process.env.PERF_TRANSACTIONS || 60000)));
const CATEGORY_COUNT = Math.max(10, Number(arg("categories", 200)));
const outPath = path.resolve(
  arg("out", process.env.PERF_DB_PATH || path.join(__dirname, "..", "data", "perf.db"))
);

const CATEGORIES = Array.from({ length: CATEGORY_COUNT }, (_, i) => `تصنيف ${String(i + 1).padStart(3, "0")}`);

function padBarcode(n, prefix = "2") {
  return `${prefix}${String(n).padStart(12, "0")}`.slice(0, 13);
}

async function insertMany(db, sqlPrefix, rows, paramCount) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(900 / paramCount));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => `(${Array(paramCount).fill("?").join(",")})`).join(",");
    const params = chunk.flat();
    await db.run(`${sqlPrefix} VALUES ${placeholders}`, params);
  }
}

async function seed() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${outPath}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log(`[seed-perf] opening ${outPath}`);
  const db = await initDatabase(outPath);
  const started = Date.now();

  const cashier = await db.get("SELECT id FROM users WHERE username = 'admin'");
  const cashierId = cashier?.id || 1;

  await db.exec(`
    DELETE FROM product_unit_barcodes;
    DELETE FROM product_units;
    DELETE FROM product_barcodes;
    DELETE FROM transaction_items;
    DELETE FROM sale_payments;
    DELETE FROM inventory_ledger;
    DELETE FROM transactions;
    DELETE FROM products;
    DELETE FROM sqlite_sequence WHERE name IN (
      'products','product_units','product_barcodes','product_unit_barcodes',
      'transactions','transaction_items','inventory_ledger'
    );
  `);

  await db.run("BEGIN IMMEDIATE");
  try {
    for (const name of CATEGORIES) {
      await db.run("INSERT OR IGNORE INTO product_categories (name, active) VALUES (?, 1)", [name]);
    }

    console.log(`[seed-perf] inserting ${PRODUCT_COUNT} products…`);
    const productRows = [];
    const barcodeRows = [];
    const unitRows = [];
    const extraBarcodeRows = [];

    for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
      const sku = formatProductSku(i);
      const barcode = padBarcode(i);
      const category = CATEGORIES[(i - 1) % CATEGORIES.length];
      const price = 1 + (i % 40);
      const cost = Math.max(0.5, price * 0.65);
      const name = `منتج أداء ${i}`;
      productRows.push([
        barcode,
        name,
        `Perf Product ${i}`,
        price,
        cost,
        category,
        50 + (i % 200),
        0.16,
        "حبة",
        sku,
        1,
        0,
        "retail",
        5,
      ]);
      barcodeRows.push([i, barcode, 1]);
      unitRows.push([i, "حبة", barcode, price, cost, 1, 1, 1, 1, 1]);
      if (i % 3 === 0) {
        extraBarcodeRows.push([i, padBarcode(i, "8"), 0]);
      }
      if (i % 5 === 0) {
        unitRows.push([i, "كرتون", padBarcode(i, "5"), price * 12, cost * 12, 12, 0, 1, 1, 0]);
      }
    }

    await insertMany(
      db,
      `INSERT INTO products
        (barcode, name, name_en, price, cost, category, stock, tax_rate, unit, sku,
         is_active, is_weighed, inventory_scope, min_stock)`,
      productRows,
      14
    );
    await insertMany(
      db,
      "INSERT INTO product_barcodes (product_id, barcode, is_primary)",
      barcodeRows.concat(extraBarcodeRows),
      3
    );
    await insertMany(
      db,
      `INSERT INTO product_units
        (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default,
         purchase_enabled, sale_enabled, is_default_purchase)`,
      unitRows,
      10
    );

    await db.run(
      `INSERT INTO entity_code_sequences (entity_type, last_seq)
       VALUES ('product', ?)
       ON CONFLICT(entity_type) DO UPDATE SET last_seq = excluded.last_seq`,
      [PRODUCT_COUNT]
    );

    if (TX_COUNT > 0) {
      console.log(`[seed-perf] inserting ${TX_COUNT} sales…`);
      const now = Date.now();
      const txRows = [];
      const itemRows = [];
      const ledgerRows = [];
      for (let i = 1; i <= TX_COUNT; i += 1) {
        const pid = ((i - 1) % PRODUCT_COUNT) + 1;
        const qty = 1 + (i % 3);
        const price = 1 + (pid % 40);
        const total = price * qty;
        const created = new Date(now - (i % 14) * 86_400_000 - (i % 3600) * 1000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        txRows.push([
          cashierId,
          JSON.stringify([{ product_id: pid, quantity: qty, price }]),
          total,
          0,
          total,
          "cash",
          created,
          `PERF-${String(i).padStart(8, "0")}`,
          "completed",
        ]);
        itemRows.push([i, pid, padBarcode(pid), `منتج أداء ${pid}`, qty, price, total, 0, total, 0, created]);
        ledgerRows.push([pid, "sale", -qty, 100, 100 - qty, "transaction", i, created]);
      }
      await insertMany(
        db,
        `INSERT INTO transactions
          (cashier_id, items_json, subtotal, tax, total, payment_method, created_at, receipt_number, status)`,
        txRows,
        9
      );
      await insertMany(
        db,
        `INSERT INTO transaction_items
          (transaction_id, product_id, barcode, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate, created_at)`,
        itemRows,
        11
      );
      await insertMany(
        db,
        `INSERT INTO inventory_ledger
          (product_id, movement_type, quantity_delta, qty_before, qty_after, reference_type, reference_id, created_at)`,
        ledgerRows,
        8
      );
    }

    await db.run("COMMIT");
  } catch (err) {
    try {
      await db.run("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }

  await db.exec("ANALYZE");
  const counts = {
    products: (await db.get("SELECT COUNT(*) AS n FROM products"))?.n,
    units: (await db.get("SELECT COUNT(*) AS n FROM product_units"))?.n,
    barcodes: (await db.get("SELECT COUNT(*) AS n FROM product_barcodes"))?.n,
    transactions: (await db.get("SELECT COUNT(*) AS n FROM transactions"))?.n,
  };
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[seed-perf] done in ${elapsed}s`, counts);
  console.log(`[seed-perf] file ${outPath}`);

  await new Promise((resolve) => {
    try {
      db.raw.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

seed().catch((err) => {
  console.error("[seed-perf] failed:", err);
  process.exit(1);
});
