import fs from "fs";
import path from "path";
import { closeSqliteConnection, openSqliteConnection } from "../../database/sqliteDriver.js";
import { assertDevBackupSource, backupDir } from "./guards.mjs";

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function backupDevDatabase(sourcePath) {
  const source = assertDevBackupSource(sourcePath);
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `supermarket-dev-BEFORE-DEMO-${stamp()}.db`);
  const sqlPath = dest.replace(/\\/g, "/").replace(/'/g, "''");
  const db = await openSqliteConnection(source, { readonly: true, isolated: true });
  try {
    await db.exec(`VACUUM INTO '${sqlPath}'`);
  } finally {
    await closeSqliteConnection(db);
  }
  const check = await openSqliteConnection(dest, { readonly: true, isolated: true });
  try {
    const integrity = await check.get("PRAGMA integrity_check");
    const value = integrity?.integrity_check;
    if (value !== "ok") throw new Error(`Backup integrity_check failed: ${value}`);
    const users = await check.get("SELECT COUNT(*) AS n FROM users");
    const products = await check.get("SELECT COUNT(*) AS n FROM products");
    return { path: dest, users: users.n, products: products.n, integrity: value };
  } finally {
    await closeSqliteConnection(check);
  }
}

export async function describeDevDatabase(sourcePath) {
  const source = assertDevBackupSource(sourcePath);
  const db = await openSqliteConnection(source, { readonly: true, isolated: true });
  try {
    const pragma = await db.get("PRAGMA integrity_check");
    const counts = {};
    for (const table of ["users", "products", "customers", "suppliers", "transactions"]) {
      const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = row.n;
    }
    const names = await db.all("SELECT name FROM products ORDER BY id LIMIT 8");
    const users = await db.all("SELECT username, role FROM users ORDER BY id");
    return {
      path: source,
      integrity: pragma?.integrity_check,
      counts,
      sampleProducts: names.map((row) => row.name),
      users,
    };
  } finally {
    await closeSqliteConnection(db);
  }
}
