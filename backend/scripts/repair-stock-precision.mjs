// Preview by default. No env loading, database initialization, devices, or background jobs.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openSqliteConnection, closeSqliteConnection } from "../database/sqliteDriver.js";
import { previewStockPrecisionRepair, applyStockPrecisionRepair } from "../services/stockPrecisionRepair.js";

const { values } = parseArgs({ options: {
  database: { type: "string" }, apply: { type: "boolean", default: false },
  "actor-id": { type: "string" }, reason: { type: "string" },
} });
if (!values.database || !fs.existsSync(values.database)) {
  throw new Error("Provide --database PATH to an existing SQLite database. Preview is read-only.");
}
if (values.apply && (!Number.isInteger(Number(values["actor-id"])) || Number(values["actor-id"]) <= 0 || !values.reason?.trim())) {
  throw new Error("Applying requires --apply --actor-id ADMIN_ID --reason TEXT.");
}
const db = await openSqliteConnection(path.resolve(values.database), { readonly: !values.apply, isolated: true });
try {
  const result = values.apply
    ? await applyStockPrecisionRepair(db, { actorId: Number(values["actor-id"]), reason: values.reason })
    : { mode: "preview", affected: await previewStockPrecisionRepair(db) };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeSqliteConnection(db);
}
