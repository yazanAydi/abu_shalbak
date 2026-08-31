/**
 * One-time STORE product SKU renumber. Manual only — never called from init.js.
 *
 * Refuses to run unless ALL of these are true:
 *   1. argv includes --confirm-store-db
 *   2. the target file exists
 *   3. the basename is exactly supermarket.db (not supermarket-dev.db)
 *
 * Does not delete/recreate products. Updates products.sku only.
 *
 * On the shop PC, after backing up and preferably stopping the API:
 *   node backend/scripts/renumber-store-product-skus.mjs --confirm-store-db
 *   node backend/scripts/renumber-store-product-skus.mjs --confirm-store-db --db C:\abo_shalbak\data\supermarket.db
 *
 * Docker:
 *   docker exec supermarket-pos node /app/backend/scripts/renumber-store-product-skus.mjs --confirm-store-db
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../loadEnv.js";
import { runProductSkuRenumber } from "./renumber-product-skus-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DB_BASENAME = "supermarket.db";
const FORBIDDEN_BASENAMES = new Set(["supermarket-dev.db", "supermarket-prod.db", "perf.db"]);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function resolveStoreDbPath() {
  const fromFlag = argValue("--db");
  if (fromFlag) {
    return path.isAbsolute(fromFlag) ? path.resolve(fromFlag) : path.resolve(process.cwd(), fromFlag);
  }
  const explicit =
    (process.env.DATABASE_PATH && String(process.env.DATABASE_PATH).trim()) ||
    (process.env.DB_PATH && String(process.env.DB_PATH).trim());
  if (explicit) {
    return path.isAbsolute(explicit)
      ? path.resolve(explicit)
      : path.resolve(__dirname, "..", explicit);
  }
  return path.resolve(__dirname, "..", "data", STORE_DB_BASENAME);
}

function assertStoreDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  const base = path.basename(resolved);
  if (!process.argv.includes("--confirm-store-db")) {
    throw new Error(
      "Refusing: pass --confirm-store-db after you have a backup and are on the shop PC. This is not the test script."
    );
  }
  if (FORBIDDEN_BASENAMES.has(base) || /dev|test|perf|loadtest/i.test(base)) {
    throw new Error(`Refusing test/dev database: ${resolved}`);
  }
  if (base !== STORE_DB_BASENAME) {
    throw new Error(`Refusing ${resolved} — store script only accepts ${STORE_DB_BASENAME}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Store database not found: ${resolved}`);
  }
  return resolved;
}

const dbPath = assertStoreDatabase(resolveStoreDbPath());
console.log(`[renumber-store] database: ${dbPath}`);
console.log("[renumber-store] This will rewrite products.sku to 1..N by id. Other fields stay unchanged.");

const report = await runProductSkuRenumber(dbPath, {
  label: "renumber-store",
  backupPrefix: "supermarket",
  reportLimit: 25,
});

const reportPath = path.join(
  path.dirname(report.backup),
  `sku-renumber-store-report_${path.basename(report.backup, ".db")}.json`
);
await fs.promises.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`[renumber-store] report: ${reportPath}`);
console.log(JSON.stringify(report, null, 2));
