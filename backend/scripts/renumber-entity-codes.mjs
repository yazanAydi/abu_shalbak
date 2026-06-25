import "../loadEnv.js";
import { initDatabase } from "../database/init.js";
import { renumberAllEntityCodesBatch } from "../utils/entityCodes.js";
import { resolveDatabasePath } from "../utils/dbPath.js";

const rawTypes = process.argv.slice(2);
const types = rawTypes.length ? rawTypes : ["product", "customer", "supplier"];

const dbPath = resolveDatabasePath();
console.log(`[db] ${dbPath}`);

const db = await initDatabase(dbPath);
const counts = await renumberAllEntityCodesBatch(db, types);
console.log("Renumbered:", counts);
db.raw.close();
