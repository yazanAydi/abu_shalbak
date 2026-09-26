import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const sqlite3 = require("sqlite3");

function assertSafe(dbPath) {
  const text = String(dbPath || "");
  if (!text || /supermarket\.db/i.test(text)) {
    throw new Error(`refusing database: ${text || "(empty)"}`);
  }
}

function open(dbPath) {
  assertSafe(dbPath);
  const db = new sqlite3.Database(dbPath);
  db.configure("busyTimeout", 8000);
  return db;
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function get(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

async function withDb(dbPath, fn) {
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const db = open(dbPath);
    try {
      return await fn(db);
    } catch (err) {
      last = err;
      if (!/SQLITE_BUSY|database is locked/i.test(String(err?.message || err)) || attempt === 5) throw err;
      await delay(80 * (attempt + 1));
    } finally {
      await close(db);
    }
  }
  throw last;
}

export function tempDb(dbPath) {
  return {
    get: (sql, params = []) => withDb(dbPath, (db) => get(db, sql, params)),
    all: (sql, params = []) => withDb(dbPath, (db) => all(db, sql, params)),
    run: (sql, params = []) => withDb(dbPath, (db) => run(db, sql, params)),
  };
}
