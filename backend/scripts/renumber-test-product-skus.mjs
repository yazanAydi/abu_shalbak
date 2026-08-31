/**
 * One-time TEST-ONLY product SKU renumber.
 * Refuses any database that is not supermarket-dev.db.
 */
import path from "path";
import { fileURLToPath } from "url";
import "../loadEnv.js";
import { runProductSkuRenumber } from "./renumber-product-skus-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_BASENAME = "supermarket-dev.db";
const FORBIDDEN_BASENAMES = new Set(["supermarket.db", "supermarket-prod.db"]);

function assertTestDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  const base = path.basename(resolved);
  if (process.env.NODE_ENV === "production" || process.env.ABO_ENV === "store") {
    throw new Error(`Refusing to run in ${process.env.ABO_ENV || process.env.NODE_ENV}`);
  }
  if (FORBIDDEN_BASENAMES.has(base)) {
    throw new Error(`Refusing store/production database: ${resolved}`);
  }
  if (base !== TEST_DB_BASENAME) {
    throw new Error(`Refusing ${resolved} — this script only accepts ${TEST_DB_BASENAME}`);
  }
  return resolved;
}

function resolveTestDbPath() {
  const explicit =
    (process.env.DATABASE_PATH && String(process.env.DATABASE_PATH).trim()) ||
    (process.env.DB_PATH && String(process.env.DB_PATH).trim());
  if (explicit) {
    return path.isAbsolute(explicit)
      ? path.resolve(explicit)
      : path.resolve(__dirname, "..", explicit);
  }
  return path.resolve(__dirname, "..", "data", TEST_DB_BASENAME);
}

const dbPath = assertTestDatabase(resolveTestDbPath());
console.log(`[renumber-test] database: ${dbPath}`);
const report = await runProductSkuRenumber(dbPath, {
  label: "renumber-test",
  backupPrefix: "supermarket-dev",
});
console.log(JSON.stringify(report, null, 2));
