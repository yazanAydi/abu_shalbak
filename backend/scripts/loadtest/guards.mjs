import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(backendDir, "..");

export const LOADTEST_DATA_DIR = path.join(backendDir, "data", "loadtest");
export const LOADTEST_REPORT_DIR = path.join(repoRoot, "docs", "perf", "load");

const DENIED_BASENAME = /^(supermarket|supermarket-dev|supermarket-prod)(\.db)?$/i;

export function applyLoadtestEnv({ dbPath, backupDir, rateLimitOn = false } = {}) {
  process.env.NODE_ENV = rateLimitOn ? "test" : process.env.NODE_ENV || "development";
  if (!rateLimitOn && process.env.NODE_ENV === "test") {
    process.env.NODE_ENV = "development";
  }
  process.env.JWT_SECRET = process.env.JWT_SECRET || "loadtest-jwt-secret-not-for-production";
  process.env.DISABLE_AUTO_BACKUP = "1";
  process.env.DISABLE_EXPIRY_TELEGRAM_ALERT = "1";
  process.env.TELEGRAM_USE_POLLING = "0";
  for (const key of Object.keys(process.env)) {
    if (/^TELEGRAM_.*_BOT_TOKEN$/.test(key) || key === "TELEGRAM_BOT_TOKEN") {
      process.env[key] = "";
    }
  }
  process.env.PERF_QUERY_COUNT = "1";
  if (dbPath) process.env.DATABASE_PATH = dbPath;
  if (backupDir) process.env.BACKUP_DIR = backupDir;
}

export function assertSafeLoadtestDbPath(dbPath) {
  if (!dbPath) throw new Error("loadtest: DATABASE_PATH is required");
  const resolved = path.resolve(dbPath);
  const base = path.basename(resolved).replace(/-wal$|-shm$/, "");
  if (DENIED_BASENAME.test(base.replace(/\.db$/i, ""))) {
    throw new Error(`loadtest refuses to use store database: ${resolved}`);
  }
  if (/supermarket/i.test(base)) {
    throw new Error(`loadtest refuses supermarket*.db path: ${resolved}`);
  }

  const allowedRoots = [
    path.resolve(LOADTEST_DATA_DIR),
    path.resolve(os.tmpdir()),
  ];
  const ok = allowedRoots.some((root) => isInside(resolved, root));
  if (!ok) {
    throw new Error(
      `loadtest DB must live under backend/data/loadtest/ or os.tmpdir(). Got: ${resolved}`
    );
  }
  return resolved;
}

function isInside(file, root) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function newRunId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
