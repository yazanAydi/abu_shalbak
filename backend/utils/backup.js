import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getBackupDir() {
  const configured = process.env.BACKUP_DIR && String(process.env.BACKUP_DIR).trim();
  const dir = configured
    ? path.resolve(configured)
    : path.resolve(__dirname, "..", "..", "backups");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function timestampName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function openSqlite(dbPath, mode = sqlite3.OPEN_READONLY) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, mode, (err) => {
      if (err) reject(err);
      else resolve(d);
    });
  });
}

function closeSqlite(db) {
  return new Promise((resolve) => {
    try {
      db.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function vacuumInto(source, destPath) {
  const escaped = String(destPath).replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    source.exec(`VACUUM INTO '${escaped}'`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function verifyBackup(destPath) {
  const verify = await openSqlite(destPath, sqlite3.OPEN_READONLY);
  try {
    const row = await new Promise((resolve, reject) => {
      verify.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'", (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });
    if (!row || Number(row.n) < 1) {
      throw new Error("Backup verification failed: no tables in snapshot");
    }
  } finally {
    await closeSqlite(verify);
  }
}

/**
 * Create a consistent standalone SQLite snapshot (includes WAL contents).
 * Uses VACUUM INTO so restore is a single file, not a raw .db copy that
 * silently drops the WAL.
 * @param {string} dbPath Absolute path to live DB
 * @returns {{ filename: string, path: string, size: number, created_at: string }}
 */
export async function createBackup(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error("Database file not found");
  }

  const backupDir = getBackupDir();
  const filename = `supermarket_${timestampName()}.db`;
  const dest = path.join(backupDir, filename);

  const source = await openSqlite(resolved, sqlite3.OPEN_READONLY);
  try {
    await vacuumInto(source, dest);
  } finally {
    await closeSqlite(source);
  }

  await verifyBackup(dest);

  const stat = await fs.promises.stat(dest);
  return {
    filename,
    path: dest,
    size: stat.size,
    created_at: new Date().toISOString(),
  };
}

/** Keep only the most recent N backup files. */
export async function pruneBackups(maxKeep = 30) {
  const backupDir = getBackupDir();
  const files = (await fs.promises.readdir(backupDir))
    .filter((f) => f.startsWith("supermarket_") && f.endsWith(".db"))
    .map((f) => ({ name: f, path: path.join(backupDir, f) }));

  const withStats = await Promise.all(
    files.map(async (f) => ({
      ...f,
      mtime: (await fs.promises.stat(f.path)).mtimeMs,
    }))
  );

  withStats.sort((a, b) => b.mtime - a.mtime);
  const toDelete = withStats.slice(maxKeep);
  for (const f of toDelete) {
    await fs.promises.unlink(f.path).catch(() => {});
  }
  return toDelete.length;
}
