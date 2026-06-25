import "../loadEnv.js";
import path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "../database/init.js";
import { resolveDatabasePath } from "../utils/dbPath.js";
import { seedShiniSupplierStatementPdf } from "../utils/supplierStatementService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = resolveDatabasePath(path.join(__dirname, ".."));
const db = await initDatabase(dbPath);

const supplier = await db.get(
  `SELECT id, name FROM suppliers WHERE name LIKE ? ORDER BY id LIMIT 1`,
  ["%ابناء الشني%"]
);
console.log("[db]", dbPath);
console.log("[supplier]", supplier);

const result = await seedShiniSupplierStatementPdf(db, dbPath);
console.log("[seed]", result);

db.raw.close();
