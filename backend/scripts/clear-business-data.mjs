/**
 * Wipe business/transactional data for a fresh Hesabati re-import.
 * Keeps: users, app_settings, customer_balance_groups, stores, bank_accounts,
 * warehouses, currencies, expense_categories, unit_names, schema_migrations.
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

const KEEP_TABLES = new Set([
  "users",
  "app_settings",
  "customer_balance_groups",
  "stores",
  "bank_accounts",
  "warehouses",
  "currencies",
  "schema_migrations",
  "expense_categories",
  "unit_names",
]);

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
  paths.add(path.resolve(repoRoot, "backend", "data", "supermarket-dev.db"));
  return [...paths].filter((p) => fs.existsSync(p));
}

/** @param {import('sqlite3').Database} db */
async function listUserTables(db) {
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      (err, result) => (err ? reject(err) : resolve(result || []))
    );
  });
  return rows.map((r) => r.name);
}

/**
 * @param {string} dbPath
 */
async function clearDatabase(dbPath) {
  console.log(`\n=== ${dbPath} ===`);
  const backup = await createBackup(dbPath);
  console.log(`  backup: ${backup.path}`);

  const db = await openDb(dbPath);
  await run(db, "PRAGMA busy_timeout = 15000");
  await run(db, "PRAGMA foreign_keys = OFF");
  await run(db, "BEGIN IMMEDIATE");
  try {
    const tables = await listUserTables(db);
    for (const table of tables) {
      if (KEEP_TABLES.has(table)) continue;
      const before = await get(db, `SELECT COUNT(*) AS n FROM "${table}"`);
      await run(db, `DELETE FROM "${table}"`);
      if (Number(before?.n) > 0) {
        console.log(`  cleared ${table}: ${before.n} rows`);
      }
    }
    if (tables.includes("bank_accounts")) {
      await run(db, "UPDATE bank_accounts SET balance = 0 WHERE balance != 0");
    }
    const seq = await get(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'");
    if (seq) {
      const keepList = [...KEEP_TABLES].map((t) => `'${t}'`).join(", ");
      await run(db, `DELETE FROM sqlite_sequence WHERE name NOT IN (${keepList})`);
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
