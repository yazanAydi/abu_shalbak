/**
 * Build an isolated load-test database. Refuses supermarket*.db paths.
 *
 *   node scripts/loadtest/seed-loadtest-db.mjs --size medium
 */
import fs from "fs";
import path from "path";
import { initDatabase } from "../../database/init.js";
import { closeSqliteConnection } from "../../database/sqliteDriver.js";
import { seedWorkloadFixtures } from "../../tests/load/factories.js";
import {
  assertSafeLoadtestDbPath,
  applyLoadtestEnv,
  LOADTEST_DATA_DIR,
  ensureDir,
  newRunId,
} from "./guards.mjs";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

export async function seedLoadtestDb({ size = "medium", seed = 20260830, outPath } = {}) {
  const dest =
    outPath ||
    path.join(LOADTEST_DATA_DIR, newRunId(), "loadtest.db");
  const safe = assertSafeLoadtestDbPath(dest);
  applyLoadtestEnv({ dbPath: safe, backupDir: path.join(path.dirname(safe), "backups") });
  ensureDir(path.dirname(safe));
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${safe}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const started = Date.now();
  const db = await initDatabase(safe);
  await db.run("UPDATE users SET must_change_password = 0");
  const fixtures = await seedWorkloadFixtures(db, size, { seed: Number(seed) });
  await closeSqliteConnection(db);
  const elapsed = Date.now() - started;
  return { dbPath: safe, fixtures, elapsed };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/loadtest/seed-loadtest-db.mjs");
if (isMain) {
  seedLoadtestDb({
    size: arg("size", "medium"),
    seed: arg("seed", 20260830),
    outPath: arg("out") || arg("db"),
  })
    .then((r) => {
      console.log(
        `[loadtest-seed] ${r.dbPath} size fixtures in ${(r.elapsed / 1000).toFixed(1)}s products=${r.fixtures.products.length} cashiers=${r.fixtures.cashiers.length}`
      );
    })
    .catch((err) => {
      console.error("[loadtest-seed]", err);
      process.exit(1);
    });
}
