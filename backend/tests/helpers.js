import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcrypt";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { createApp } from "../app.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-for-abo-shalbak-tests-only";
process.env.DISABLE_AUTO_BACKUP = "1";

export async function createTestContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = await initDatabase(dbPath);

  const adminHash = await bcrypt.hash("adminpass123", 4);
  const cashierHash = await bcrypt.hash("cashpass123", 4);

  await db.run("DELETE FROM users");
  await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
    ["testadmin", adminHash, "admin"]
  );
  await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
    ["testcashier", cashierHash, "cashier"]
  );

  const productIns = await db.run(
    `INSERT INTO products (barcode, name, price, cost, category, stock)
     VALUES ('9990001', 'Test Product', 10, 5, 'Test', 100)`
  );

  await db.run(
    `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, '9990001', 1)`,
    [productIns.lastID]
  );
  await db.run(
    `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
     VALUES (?, 'حبة', '9990001', 10, 5, 1, 1)`,
    [productIns.lastID]
  );

  const app = createApp(db, dbPath);
  return { app, db, dbPath, tmpDir, productId: productIns.lastID };
}

export async function login(app, username, password, appPortal = "office") {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ username, password, app: appPortal });
  if (res.body?.data?.token) {
    res.body.token = res.body.data.token;
    res.body.user = res.body.data.user;
  }
  return res;
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

let checkoutKeySeq = 0;

/** Unique checkout idempotency key for first-party tests. */
export function withCheckoutKey(body = {}, key) {
  if (body && body.idempotency_key) return body;
  checkoutKeySeq += 1;
  return {
    ...body,
    idempotency_key: key || `chk-key-${checkoutKeySeq.toString().padStart(8, "0")}-${Date.now()}`,
  };
}

/**
 * Office accountant used by permission tests. Pass `permissions` to store a
 * custom users.permissions_json map; omit it to follow the global template.
 */
export async function configureTelegramApprover(db, username = "testadmin") {
  const { updateAppSettings, SETTING_KEYS } = await import("../utils/settings.js");
  const user = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  if (!user?.id) throw new Error(`missing telegram approver ${username}`);
  await updateAppSettings(db, { [SETTING_KEYS.refund_telegram_manager_user_id]: user.id });
  return user.id;
}

export async function createAccountantUser(
  db,
  { username = "testaccountant", password = "acctpass123", permissions = null } = {}
) {
  const hash = await bcrypt.hash(password, 4);
  const permissionsJson = permissions == null ? null : JSON.stringify(permissions);
  const ins = await db.run(
    "INSERT INTO users (username, password, role, must_change_password, permissions_json) VALUES (?, ?, 'accountant', 0, ?)",
    [username, hash, permissionsJson]
  );
  return { id: ins.lastID, username, password };
}

export async function createTestEmployee(db, { name = "موظف اختبار", active = 1 } = {}) {
  const ins = await db.run("INSERT INTO employees (name, active) VALUES (?, ?)", [
    name,
    active ? 1 : 0,
  ]);
  return { id: ins.lastID, name };
}

export async function destroyTestContext(ctx) {
  if (!ctx) return;
  try {
    if (ctx.db) await closeSqliteConnection(ctx.db);
  } catch (_) {}
  ctx.db = null;
  try {
    if (ctx.tmpDir) fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch (_) {}
}
