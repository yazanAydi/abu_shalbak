/**
 * Wipe business/transactional data for a fresh Hesabati re-import.
 * Keeps: users, app_settings, customer_balance_groups (system), stores, bank_accounts.
 *
 * Usage:
 *   node backend/scripts/clear-business-data.mjs          # preview
 *   node backend/scripts/clear-business-data.mjs --yes    # backup + delete
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

const TABLES_IN_DELETE_ORDER = [
  "voucher_lines",
  "vouchers",
  "supplier_payments",
  "purchase_return_lines",
  "purchase_returns",
  "purchase_invoice_lines",
  "purchase_invoices",
  "purchase_order_lines",
  "purchase_orders",
  "supplier_invoices",
  "refund_request_lines",
  "refund_requests",
  "refunds",
  "transaction_items",
  "transactions",
  "inventory_ledger",
  "inventory_movements",
  "product_price_history",
  "product_barcodes",
  "product_batches",
  "stock_count_lines",
  "stock_count_sessions",
  "stock_adjustment_lines",
  "stock_adjustments",
  "warehouse_transfer_lines",
  "warehouse_transfers",
  "sales_deliveries",
  "purchase_receivings",
  "promotion_products",
  "promotions",
  "campaigns",
  "cash_reconciliations",
  "cashier_shift_reconciliation",
  "cashier_shifts",
  "operating_expenses",
  "audit_logs",
  "daily_reports",
  "products",
  "customers",
  "suppliers",
  "entity_code_sequences",
  "receipt_sequences",
];

const confirm = process.argv.includes("--yes");

/** @returns {Promise<import('sqlite3').Database>} */
function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}

/** @param {import('sqlite3').Database} db @param {string} sql @param {unknown[]} [params] */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/** @param {import('sqlite3').Database} db @param {string} sql @param {unknown[]} [params] */
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

/** @param {import('sqlite3').Database} db */
function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function discoverDbPaths() {
  const paths = new Set();
  try {
    paths.add(path.resolve(resolveDatabasePath()));
  } catch (_) {}
  paths.add(path.resolve(repoRoot, "data", "supermarket.db"));
  paths.add(path.resolve(repoRoot, "backend", "data", "supermarket.db"));
  return [...paths].filter((p) => fs.existsSync(p));
}

/**
 * @param {string} dbPath
 */
async function clearDatabase(dbPath) {
  console.log(`\n=== ${dbPath} ===`);
  const backup = await createBackup(dbPath);
  console.log(`  backup: ${backup.path}`);

  const db = await openDb(dbPath);
  await run(db, "PRAGMA foreign_keys = OFF");
  await run(db, "BEGIN IMMEDIATE");
  try {
    for (const table of TABLES_IN_DELETE_ORDER) {
      const exists = await get(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        [table]
      );
      if (!exists) continue;
      const before = await get(db, `SELECT COUNT(*) AS n FROM ${table}`);
      await run(db, `DELETE FROM ${table}`);
      if (Number(before?.n) > 0) {
        console.log(`  cleared ${table}: ${before.n} rows`);
      }
    }
    await run(db, "COMMIT");
    await run(db, "PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    try {
      await run(db, "ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    await run(db, "PRAGMA foreign_keys = ON");
    await closeDb(db);
  }
}

const dbPaths = discoverDbPaths();
if (!dbPaths.length) {
  console.error("No database files found.");
  process.exit(1);
}

console.log("Database files found:");
for (const p of dbPaths) console.log(`  - ${p}`);

if (!confirm) {
  console.log("\nThis will DELETE all business data (suppliers, customers, products, sales, purchases, etc.).");
  console.log("A backup is created automatically before each wipe. Users and settings are kept.");
  console.log("\nRe-run with --yes to proceed:\n  node backend/scripts/clear-business-data.mjs --yes\n");
  process.exit(0);
}

for (const dbPath of dbPaths) {
  await clearDatabase(dbPath);
}

console.log("\nDone. Restart the backend if it is running, then re-import your Hesabati files.");
