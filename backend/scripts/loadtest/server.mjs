/**
 * Isolated HTTP server for load tests. Never imported by production server.js.
 *
 *   node scripts/loadtest/server.mjs --db <safe-path>
 *
 * apply-env-first MUST be the first import so JWT_SECRET is set before
 * createApp → auth.js evaluates (including multiproc child processes).
 */
import "./apply-env-first.mjs";
import http from "http";
import { initDatabase } from "../../database/init.js";
import { createApp } from "../../app.js";
import { closeSqliteConnection, useBetterSqlite } from "../../database/sqliteDriver.js";
import { sendExpiryAlert } from "../../services/expiryAlertService.js";
import { assertSafeLoadtestDbPath, applyLoadtestEnv } from "./guards.mjs";
import { instrument } from "./instrument.mjs";
import { startResourceSampler } from "./metrics.mjs";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

export async function startLoadtestServer({ dbPath, port = 0, rateLimitOn = false, backupDir } = {}) {
  const safe = assertSafeLoadtestDbPath(dbPath);
  applyLoadtestEnv({ dbPath: safe, backupDir, rateLimitOn });
  const raw = await initDatabase(safe);
  const { db, stats } = instrument(raw);
  const app = createApp(db, safe);
  app.get("/__loadtest/stats", (_req, res) => {
    res.json(stats.snapshot ? stats.snapshot() : stats);
  });
  app.post("/__loadtest/expiry-alert", async (_req, res) => {
    try {
      const result = await sendExpiryAlert(db);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  const sampler = startResourceSampler({ dbPath: safe });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" ? addr.port : port;

  async function close() {
    const resources = sampler.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    await closeSqliteConnection(db);
    return { stats: stats.snapshot ? stats.snapshot() : stats, resources };
  }

  return {
    app,
    db,
    stats,
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    driver: (await useBetterSqlite()) ? "better-sqlite3" : "sqlite3",
    close,
  };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/loadtest/server.mjs");
if (isMain) {
  const dbPath = arg("db", process.env.DATABASE_PATH);
  const port = Number(arg("port", 0));
  const rateLimitOn = process.argv.includes("--rate-limit-on");
  startLoadtestServer({ dbPath, port, rateLimitOn })
    .then((s) => {
      const payload = { type: "ready", port: s.port, driver: s.driver };
      if (process.send) process.send(payload);
      else console.log(`LOADTEST_PORT=${s.port}`);
    })
    .catch((err) => {
      console.error("[loadtest-server]", err);
      process.exit(1);
    });
}
