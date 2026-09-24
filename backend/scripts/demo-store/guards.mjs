import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..", "..", "..");
export const backendDir = path.join(repoRoot, "backend");
export const demoDbPath = path.join(backendDir, "data", "supermarket-demo.db");
export const faultDbPath = path.join(backendDir, "data", "supermarket-demo-fault.db");
export const devDbPath = path.join(backendDir, "data", "supermarket-dev.db");
export const reportDir = path.join(backendDir, "data", "demo-reports");
export const backupDir = path.join(backendDir, "backups", "dev-before-demo");
export const switchFile = path.join(reportDir, "dev-db-switch.json");
export const envDevelopmentFile = path.join(repoRoot, ".env.development");

const ALLOWED = new Set([path.resolve(demoDbPath), path.resolve(faultDbPath)]);

export function assertWritableDemoPath(dbPath) {
  const resolved = path.resolve(dbPath);
  const base = path.basename(resolved);
  if (!ALLOWED.has(resolved)) {
    throw new Error(
      `Refusing to write ${resolved}. Demo scripts may only write supermarket-demo.db or supermarket-demo-fault.db under backend/data.`
    );
  }
  if (/^supermarket(-dev|-prod)?\.db$/i.test(base) || base === "supermarket.db") {
    throw new Error(`Refusing protected database name: ${base}`);
  }
  const rootData = path.resolve(repoRoot, "data");
  if (resolved.startsWith(rootData + path.sep)) {
    throw new Error(`Refusing Docker/store data directory: ${resolved}`);
  }
  return resolved;
}

export function assertDevBackupSource(dbPath) {
  const resolved = path.resolve(dbPath);
  if (resolved !== path.resolve(devDbPath)) {
    throw new Error(
      `Backup-before-switch only allows the development file ${devDbPath}. Refusing ${resolved}.`
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Development database is not at ${resolved}`);
  }
  return resolved;
}

export function removeSqliteSidecars(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = suffix ? dbPath + suffix : dbPath;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}
