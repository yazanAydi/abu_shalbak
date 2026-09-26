import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCT, USERS } from "./fixtures.mjs";

// Set before any backend module loads. Do not import server.js or loadEnv.js:
// those resolve the shop database and start backups, cron, and Telegram.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "e2e-return-smoke-jwt-not-for-production-use";
process.env.HOST = "127.0.0.1";
process.env.DISABLE_AUTO_BACKUP = "1";
delete process.env.DATABASE_PATH;
delete process.env.DB_PATH;
delete process.env.ABO_ENV;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("TELEGRAM_")) process.env[key] = "";
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const bcrypt = require("bcrypt");

function assertDisposable(dbPath) {
  const resolved = path.resolve(dbPath);
  const tmp = path.resolve(os.tmpdir());
  const lower = resolved.toLowerCase();
  const tmpLower = tmp.toLowerCase();
  if (lower !== tmpLower && !lower.startsWith(`${tmpLower}${path.sep}`)) {
    throw new Error(`test database must live under the OS temp directory, got ${resolved}`);
  }
  if (lower.includes("supermarket.db")) {
    throw new Error(`refusing shop database path ${resolved}`);
  }
}

const posIndex = path.join(process.env.POS_DIST || "", "index.html");
const adminIndex = path.join(process.env.ADMIN_DIST || "", "index.html");
if (!fs.existsSync(posIndex) || !fs.existsSync(adminIndex)) {
  console.error(`Missing production UI build.\nPOS: ${posIndex}\nAdmin: ${adminIndex}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-return-e2e-"));
const dbPath = path.join(tmpDir, "return-smoke.db");
assertDisposable(dbPath);

const { initDatabase } = await import(pathToFileURL(path.join(root, "backend", "database", "init.js")).href);
const { createApp } = await import(pathToFileURL(path.join(root, "backend", "app.js")).href);
const { closeSqliteConnection } = await import(
  pathToFileURL(path.join(root, "backend", "database", "sqliteDriver.js")).href
);

const db = await initDatabase(dbPath);
const adminHash = await bcrypt.hash(USERS.admin.password, 4);
const cashierAHash = await bcrypt.hash(USERS.cashierA.password, 4);
const cashierBHash = await bcrypt.hash(USERS.cashierB.password, 4);

await db.run("DELETE FROM users");
for (const [hash, user] of [
  [adminHash, USERS.admin],
  [cashierAHash, USERS.cashierA],
  [cashierBHash, USERS.cashierB],
]) {
  await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
    [user.username, hash, user.role]
  );
}

const productIns = await db.run(
  `INSERT INTO products (barcode, name, price, cost, category, stock)
   VALUES (?, ?, ?, ?, ?, ?)`,
  [PRODUCT.barcode, PRODUCT.name, PRODUCT.price, PRODUCT.cost, PRODUCT.category, PRODUCT.stock]
);
await db.run("INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)", [
  productIns.lastID,
  PRODUCT.barcode,
]);
await db.run(
  `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
   VALUES (?, ?, ?, ?, ?, 1, 1)`,
  [productIns.lastID, PRODUCT.unit, PRODUCT.barcode, PRODUCT.price, PRODUCT.cost]
);
await db.run("UPDATE app_settings SET value = ? WHERE key = ?", ["100", "default_opening_cash"]);
const opening = await db.get("SELECT value FROM app_settings WHERE key = ?", ["default_opening_cash"]);
if (String(opening?.value) !== "100") {
  throw new Error(`failed to seed default_opening_cash (got ${opening?.value ?? "missing"})`);
}

const app = createApp(db, dbPath, { enableStatic: true });
const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const url = `http://127.0.0.1:${address.port}`;
console.log(
  `E2E_READY ${JSON.stringify({
    url,
    dbPath,
    tmpDir,
    productId: productIns.lastID,
  })}`
);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise((resolve) => server.close(() => resolve()));
  try {
    await closeSqliteConnection(db);
  } catch (err) {
    console.error(err);
  }
  process.exit(code);
}

process.on("SIGTERM", () => {
  shutdown(0);
});
process.on("SIGINT", () => {
  shutdown(0);
});
