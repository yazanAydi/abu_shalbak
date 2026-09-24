import fs from "fs";
import bcrypt from "bcrypt";
import { initDatabase } from "../../database/init.js";
import { closeSqliteConnection } from "../../database/sqliteDriver.js";
import { allAccountantPermissionKeys } from "../../utils/accountantPermissions.js";
import { assertWritableDemoPath, removeSqliteSidecars } from "./guards.mjs";

const SAMPLE_NAMES = ["Coca Cola 500ml", "Water 1L", "Bread White"];

export async function createEmptyDemoDatabase(dbPath, expected) {
  const target = assertWritableDemoPath(dbPath);
  fs.mkdirSync(pathDir(target), { recursive: true });
  removeSqliteSidecars(target);
  const db = await initDatabase(target);
  await replaceSeedUsers(db, expected.accounts);
  await wipeSampleProducts(db);
  await db.run(
    `INSERT INTO app_settings (key, value) VALUES ('demo_store_simulation', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify("supermarket-demo")]
  );
  return db;
}

function pathDir(file) {
  const index = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return file.slice(0, index);
}

async function replaceSeedUsers(db, accounts) {
  const adminHash = await bcrypt.hash(accounts.admin.password, 10);
  const cashierHash = await bcrypt.hash(accounts.cashier1.password, 10);
  await db.run(
    `UPDATE users SET password = ?, must_change_password = 0, hourly_rate = 25 WHERE username = 'admin'`,
    [adminHash]
  );
  await db.run(
    `UPDATE users SET password = ?, must_change_password = 0, hourly_rate = 25 WHERE username = 'cashier1'`,
    [cashierHash]
  );
  const keys = allAccountantPermissionKeys();
  const full = Object.fromEntries(keys.map((key) => [key, true]));
  const finance = Object.fromEntries(keys.map((key) => [key, false]));
  finance.dashboard = true;
  finance.finance = true;
  const rows = [
    [accounts.accountant, full, null],
    [accounts.finance, finance, null],
    [accounts.cashier2, null, 20],
    [accounts.bakery, null, 15],
    [accounts.shelves, null, null],
  ];
  for (const [account, permissions, rate] of rows) {
    const hash = await bcrypt.hash(account.password, 10);
    await db.run(
      `INSERT INTO users (username, password, role, must_change_password, permissions_json, hourly_rate)
       VALUES (?, ?, ?, 0, ?, ?)`,
      [
        account.username,
        hash,
        account.role,
        permissions ? JSON.stringify(permissions) : null,
        rate,
      ]
    );
  }
}

async function wipeSampleProducts(db) {
  const rows = await db.all(
    `SELECT id FROM products WHERE name IN (${SAMPLE_NAMES.map(() => "?").join(",")})`,
    SAMPLE_NAMES
  );
  for (const row of rows) {
    for (const table of [
      "product_barcodes",
      "product_units",
      "inventory_ledger",
      "warehouse_stock",
      "product_batches",
    ]) {
      try {
        await db.run(`DELETE FROM ${table} WHERE product_id = ?`, [row.id]);
      } catch {
        /* table or column may not apply to bootstrap samples */
      }
    }
    await db.run("DELETE FROM products WHERE id = ?", [row.id]);
  }
}

export async function closeDemo(db) {
  if (db) await closeSqliteConnection(db);
}
