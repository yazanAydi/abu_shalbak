/**
 * Remove all suppliers and linked purchase/payment rows (keeps products, customers, sales).
 * Usage: node backend/scripts/clear-suppliers.mjs --yes
 */
import "../loadEnv.js";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import { createBackup } from "../utils/backup.js";
import { resolveDatabasePath } from "../utils/dbPath.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const confirm = process.argv.includes("--yes");

const STEPS = [
  ["voucher_lines (supplier)", "DELETE FROM voucher_lines WHERE supplier_id IS NOT NULL"],
  ["supplier_payments", "DELETE FROM supplier_payments"],
  ["purchase_return_lines", "DELETE FROM purchase_return_lines"],
  ["purchase_returns", "DELETE FROM purchase_returns"],
  ["purchase_invoice_lines", "DELETE FROM purchase_invoice_lines"],
  ["purchase_invoices", "DELETE FROM purchase_invoices"],
  ["purchase_order_lines", "DELETE FROM purchase_order_lines"],
  ["purchase_orders", "DELETE FROM purchase_orders"],
  ["supplier_invoices", "DELETE FROM supplier_invoices"],
  ["suppliers", "DELETE FROM suppliers"],
  ["entity_code_sequences (supplier)", "DELETE FROM entity_code_sequences WHERE entity_type = 'supplier'"],
];

function discoverDbPaths() {
  const paths = new Set();
  try {
    paths.add(path.resolve(resolveDatabasePath()));
  } catch (_) {}
  paths.add(path.resolve(repoRoot, "data", "supermarket.db"));
  paths.add(path.resolve(repoRoot, "backend", "data", "supermarket.db"));
  return [...paths].filter((p) => fs.existsSync(p));
}

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function clearSuppliers(dbPath) {
  console.log(`\n=== ${dbPath} ===`);
  const db = await openDb(dbPath);
  const beforeRow = await get(db, "SELECT COUNT(*) AS n FROM suppliers");
  const before = Number(beforeRow?.n) || 0;
  if (!before) {
    console.log("  (no suppliers)");
    await closeDb(db);
    return;
  }
  await closeDb(db);

  const backup = await createBackup(dbPath);
  console.log(`  backup: ${backup.path}`);
  console.log(`  suppliers before: ${before}`);

  const db2 = await openDb(dbPath);
  await run(db2, "PRAGMA foreign_keys = OFF");
  await run(db2, "BEGIN IMMEDIATE");
  try {
    for (const [label, sql] of STEPS) {
      const table = sql.match(/FROM (\w+)/)?.[1];
      if (table) {
        const exists = await get(
          db2,
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
          [table]
        );
        if (!exists) continue;
      }
      const n = await run(db2, sql);
      if (n > 0) console.log(`  cleared ${label}: ${n}`);
    }
    await run(db2, "COMMIT");
    await run(db2, "PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    try {
      await run(db2, "ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    await run(db2, "PRAGMA foreign_keys = ON");
    await closeDb(db2);
  }
}

const dbPaths = discoverDbPaths();
console.log("Database files:");
dbPaths.forEach((p) => console.log(`  - ${p}`));

if (!confirm) {
  console.log("\nThis removes ALL suppliers and their purchase/payment records.");
  console.log("Products, customers, and sales are kept.");
  console.log("\nRun: node backend/scripts/clear-suppliers.mjs --yes\n");
  process.exit(0);
}

for (const p of dbPaths) {
  await clearSuppliers(p);
}

console.log("\nDone. Re-import your supplier Excel file when ready.");
