import path from "path";
import { fileURLToPath } from "url";

/** backend/ directory (parent of utils/) */
const __backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Same rules as server.js — DATABASE_PATH relative to backend/ when not absolute.
 * @param {string} [backendDir]
 */
export function resolveDatabasePath(backendDir = __backendDir) {
  const explicit =
    (process.env.DATABASE_PATH && String(process.env.DATABASE_PATH).trim()) ||
    (process.env.DB_PATH && String(process.env.DB_PATH).trim());

  if (explicit) {
    return path.isAbsolute(explicit)
      ? path.resolve(explicit)
      : path.resolve(backendDir, explicit);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_PATH is required in production");
  }

  return path.resolve(backendDir, "..", "data", "supermarket.db");
}
