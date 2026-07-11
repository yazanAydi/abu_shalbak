/**
 * Shift stored timestamps when the server clock was wrong at install/use.
 * Affects report-critical created_at / shift times only — not user-entered business dates.
 *
 * Usage:
 *   node backend/scripts/shift-timestamps.mjs --offset-hours 3
 *   node backend/scripts/shift-timestamps.mjs --offset-hours 3 --from 2026-07-01 --until 2026-07-06
 *   node backend/scripts/shift-timestamps.mjs --offset-minutes -90 --yes
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

/** @type {{ table: string, columns: string[], filterColumn: string }[]} */
const TABLE_SPECS = [
  { table: "transactions", columns: ["created_at"], filterColumn: "created_at" },
  {
    table: "cashier_shifts",
    columns: ["start_time", "end_time", "created_at", "manager_approved_at"],
    filterColumn: "start_time",
  },
  { table: "shift_cash_movements", columns: ["created_at"], filterColumn: "created_at" },
  { table: "refunds", columns: ["created_at", "approved_at"], filterColumn: "created_at" },
  {
    table: "refund_requests",
    columns: ["created_at", "approved_at", "rejected_at"],
    filterColumn: "created_at",
  },
  { table: "sale_payments", columns: ["created_at"], filterColumn: "created_at" },
  { table: "suspended_sales", columns: ["created_at", "updated_at"], filterColumn: "created_at" },
  { table: "inventory_ledger", columns: ["created_at"], filterColumn: "created_at" },
  { table: "audit_logs", columns: ["created_at"], filterColumn: "created_at" },
];

function parseArgs(argv) {
  const args = {
    yes: false,
    offsetHours: 0,
    offsetMinutes: 0,
    from: null,
    until: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") {
      args.yes = true;
    } else if (arg === "--offset-hours" && argv[i + 1] != null) {
      args.offsetHours = Number(argv[++i]);
    } else if (arg === "--offset-minutes" && argv[i + 1] != null) {
      args.offsetMinutes = Number(argv[++i]);
    } else if (arg === "--from" && argv[i + 1] != null) {
      args.from = String(argv[++i]).trim();
    } else if (arg === "--until" && argv[i + 1] != null) {
      args.until = String(argv[++i]).trim();
    }
  }

  return args;
}

function assertIsoDate(label, value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function buildOffsetModifier(offsetHours, offsetMinutes) {
  const totalMinutes = Math.trunc(offsetHours * 60 + offsetMinutes);
  if (!Number.isFinite(totalMinutes) || totalMinutes === 0) {
    throw new Error("Provide a non-zero --offset-hours and/or --offset-minutes");
  }
  const sign = totalMinutes > 0 ? "+" : "-";
  return `${sign}${Math.abs(totalMinutes)} minutes`;
}

function buildDateFilter(filterColumn, from, until) {
  const parts = [];
  const params = [];
  if (from) {
    parts.push(`date(${filterColumn}) >= ?`);
    params.push(from);
  }
  if (until) {
    parts.push(`date(${filterColumn}) <= ?`);
    params.push(until);
  }
  return {
    sql: parts.length ? ` AND ${parts.join(" AND ")}` : "",
    params,
  };
}

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

/** @param {import('sqlite3').Database} db @param {string} sql @param {unknown[]} [params] */
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/** @param {import('sqlite3').Database} db */
function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

/** @param {import('sqlite3').Database} db @param {string} table @param {string} column */
async function columnExists(db, table, column) {
  const row = await get(
    db,
    `SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ? LIMIT 1`,
    [table, column]
  );
  return Boolean(row);
}

/** @param {import('sqlite3').Database} db @param {string} table */
async function tableExists(db, table) {
  const row = await get(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    [table]
  );
  return Boolean(row);
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
 * @param {import('sqlite3').Database} db
 * @param {{ table: string, columns: string[], filterColumn: string }} spec
 * @param {string} modifier
 * @param {string|null} from
 * @param {string|null} until
 */
async function previewTable(db, spec, modifier, from, until) {
  if (!(await tableExists(db, spec.table))) return [];

  const dateFilter = buildDateFilter(spec.filterColumn, from, until);
  const lines = [];

  for (const column of spec.columns) {
    if (!(await columnExists(db, spec.table, column))) continue;

    const where = `WHERE ${column} IS NOT NULL AND TRIM(${column}) != ''${dateFilter.sql}`;
    const countRow = await get(
      db,
      `SELECT COUNT(*) AS n FROM ${spec.table} ${where}`,
      dateFilter.params
    );
    const count = Number(countRow?.n || 0);
    if (count === 0) continue;

    lines.push({ table: spec.table, column, count });
    console.log(`  ${spec.table}.${column}: ${count} row(s)`);

    const samples = await all(
      db,
      `SELECT rowid AS _rowid, ${column} AS before_value,
              datetime(${column}, ?) AS after_value
       FROM ${spec.table}
       ${where}
       ORDER BY rowid
       LIMIT 3`,
      [modifier, ...dateFilter.params]
    );

    for (const sample of samples) {
      console.log(
        `    sample row ${sample._rowid}: ${sample.before_value} -> ${sample.after_value}`
      );
    }
  }

  return lines;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {{ table: string, columns: string[], filterColumn: string }} spec
 * @param {string} modifier
 * @param {string|null} from
 * @param {string|null} until
 */
async function applyTable(db, spec, modifier, from, until) {
  if (!(await tableExists(db, spec.table))) return 0;

  const dateFilter = buildDateFilter(spec.filterColumn, from, until);
  let updated = 0;

  for (const column of spec.columns) {
    if (!(await columnExists(db, spec.table, column))) continue;

    const where = `WHERE ${column} IS NOT NULL AND TRIM(${column}) != ''${dateFilter.sql}`;
    const result = await run(
      db,
      `UPDATE ${spec.table}
       SET ${column} = datetime(${column}, ?)
       ${where}`,
      [modifier, ...dateFilter.params]
    );
    updated += Number(result.changes || 0);
    if (result.changes > 0) {
      console.log(`  updated ${spec.table}.${column}: ${result.changes} rows`);
    }
  }

  return updated;
}

/**
 * @param {string} dbPath
 * @param {{ yes: boolean, offsetHours: number, offsetMinutes: number, from: string|null, until: string|null }} args
 */
async function processDatabase(dbPath, args) {
  const modifier = buildOffsetModifier(args.offsetHours, args.offsetMinutes);
  console.log(`\n=== ${dbPath} ===`);
  console.log(`  offset: ${modifier}`);
  if (args.from || args.until) {
    console.log(`  window: ${args.from || "..."} .. ${args.until || "..."}`);
  }

  const db = await openDb(dbPath);
  try {
    const summary = [];
    for (const spec of TABLE_SPECS) {
      const lines = await previewTable(db, spec, modifier, args.from, args.until);
      summary.push(...lines);
    }

    if (!summary.length) {
      console.log("  (no matching rows)");
      return;
    }

    if (!args.yes) return;

    const backup = await createBackup(dbPath);
    console.log(`  backup: ${backup.path}`);

    await run(db, "BEGIN IMMEDIATE");
    try {
      let total = 0;
      for (const spec of TABLE_SPECS) {
        total += await applyTable(db, spec, modifier, args.from, args.until);
      }
      await run(db, "COMMIT");
      console.log(`  done: ${total} cell update(s)`);
    } catch (e) {
      try {
        await run(db, "ROLLBACK");
      } catch (_) {}
      throw e;
    }
  } finally {
    await closeDb(db);
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.from) assertIsoDate("--from", args.from);
  if (args.until) assertIsoDate("--until", args.until);
  buildOffsetModifier(args.offsetHours, args.offsetMinutes);
} catch (e) {
  console.error(String(e.message || e));
  console.error(
    "\nUsage:\n  node backend/scripts/shift-timestamps.mjs --offset-hours 3 [--from YYYY-MM-DD] [--until YYYY-MM-DD]\n  node backend/scripts/shift-timestamps.mjs --offset-minutes -90 --yes\n"
  );
  process.exit(1);
}

const dbPaths = discoverDbPaths();
if (!dbPaths.length) {
  console.error("No database files found.");
  process.exit(1);
}

console.log("Database files found:");
for (const p of dbPaths) console.log(`  - ${p}`);

if (!args.yes) {
  console.log("\nDry run — no changes written. Re-run with --yes to backup and apply.");
}

for (const dbPath of dbPaths) {
  await processDatabase(dbPath, args);
}

if (!args.yes) {
  console.log("\nRe-run with --yes to proceed:\n  node backend/scripts/shift-timestamps.mjs --offset-hours 3 --yes\n");
}
