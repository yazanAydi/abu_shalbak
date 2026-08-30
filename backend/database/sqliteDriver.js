import sqlite3 from "sqlite3";
import { incrementQueryCount, maybeLogSlowQuery, readPreferenceAls } from "../utils/queryStats.js";

let betterAvailable = null;

export async function useBetterSqlite() {
  if (process.env.SQLITE_DRIVER === "sqlite3") return false;
  if (betterAvailable != null) return betterAvailable;
  try {
    await import("better-sqlite3");
    betterAvailable = true;
  } catch {
    betterAvailable = false;
    if (process.env.SQLITE_DRIVER === "better-sqlite3") {
      throw new Error(
        "SQLITE_DRIVER=better-sqlite3 but the native module is not installed. On the store PC run: npm rebuild better-sqlite3"
      );
    }
  }
  return betterAvailable;
}

export function preferReadonlyReads() {
  return Boolean(readPreferenceAls.getStore()?.readonly);
}

function txKeyword(sql) {
  const s = String(sql || "").trim();
  if (/^BEGIN\b/i.test(s)) return "begin";
  if (/^(COMMIT|ROLLBACK)\b/i.test(s)) return "end";
  return null;
}

function applyPragmasBetter(raw, { readonly = false } = {}) {
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 10000");
  if (!readonly) {
    raw.pragma("synchronous = NORMAL");
    raw.pragma("cache_size = -64000");
    raw.pragma("temp_store = MEMORY");
    raw.pragma("mmap_size = 268435456");
  }
}

function applyPragmasSqlite3(db) {
  return db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA temp_store = MEMORY;
  `);
}

function wrapShared(runRaw, getRaw, allRaw, execRaw, extras = {}) {
  let tail = Promise.resolve();
  let releaseHold = null;

  function acquireBegin() {
    return new Promise((resolve) => {
      const start = () => {
        const hold = new Promise((r) => {
          releaseHold = r;
        });
        tail = hold.catch(() => {});
        resolve();
      };
      tail.then(start, start);
    });
  }

  function releaseEnd() {
    if (releaseHold) {
      const r = releaseHold;
      releaseHold = null;
      r();
    }
  }

  return {
    ...extras,
    run(sql, params = []) {
      incrementQueryCount();
      const started = Date.now();
      const kind = txKeyword(sql);
      const done = (p) => p.finally(() => maybeLogSlowQuery(sql, started));
      if (kind === "begin") {
        return acquireBegin().then(() =>
          done(runRaw(sql, params)).catch((err) => {
            releaseEnd();
            throw err;
          })
        );
      }
      if (kind === "end") {
        return done(runRaw(sql, params)).finally(releaseEnd);
      }
      return done(runRaw(sql, params));
    },
    get(sql, params = []) {
      incrementQueryCount();
      const started = Date.now();
      return getRaw(sql, params).finally(() => maybeLogSlowQuery(sql, started));
    },
    all(sql, params = []) {
      incrementQueryCount();
      const started = Date.now();
      return allRaw(sql, params).finally(() => maybeLogSlowQuery(sql, started));
    },
    exec(sql) {
      incrementQueryCount();
      const started = Date.now();
      const kind = txKeyword(sql);
      const done = (p) => p.finally(() => maybeLogSlowQuery(sql, started));
      if (kind === "begin") {
        return acquireBegin().then(() =>
          done(execRaw(sql)).catch((err) => {
            releaseEnd();
            throw err;
          })
        );
      }
      if (kind === "end") {
        return done(execRaw(sql)).finally(releaseEnd);
      }
      return done(execRaw(sql));
    },
    close() {
      return extras.close?.() ?? Promise.resolve();
    },
  };
}

function wrapBetterSqlite(writeRaw, readRaw) {
  const stmtCache = new Map();
  const MAX_STMTS = 256;

  function prepare(raw, sql) {
    const key = sql;
    let stmt = stmtCache.get(key);
    if (!stmt) {
      stmt = raw.prepare(sql);
      if (stmtCache.size >= MAX_STMTS) {
        const first = stmtCache.keys().next().value;
        stmtCache.delete(first);
      }
      stmtCache.set(key, stmt);
    }
    return stmt;
  }

  function target(sql) {
    if (
      readRaw &&
      preferReadonlyReads() &&
      /^\s*SELECT\b/i.test(String(sql || ""))
    ) {
      return readRaw;
    }
    return writeRaw;
  }

  return wrapShared(
    (sql, params) =>
      Promise.resolve().then(() => {
        const info = prepare(target(sql), sql).run(params);
        return { lastID: Number(info.lastInsertRowid), changes: info.changes };
      }),
    (sql, params) => Promise.resolve().then(() => prepare(target(sql), sql).get(params)),
    (sql, params) => Promise.resolve().then(() => prepare(target(sql), sql).all(params)),
    (sql) =>
      Promise.resolve().then(() => {
        target(sql).exec(sql);
      }),
    {
      raw: writeRaw,
      driver: "better-sqlite3",
      close() {
        return Promise.resolve().then(() => {
          try {
            readRaw?.close();
          } catch {
            /* ignore */
          }
          writeRaw.close();
        });
      },
    }
  );
}

function wrapNodeSqlite(raw) {
  function runRaw(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
  function getRaw(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
  function allRaw(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
  function execRaw(sql) {
    return new Promise((resolve, reject) => {
      raw.exec(sql, (err) => (err ? reject(err) : resolve()));
    });
  }
  return wrapShared(runRaw, getRaw, allRaw, execRaw, {
    raw,
    driver: "sqlite3",
    close() {
      return new Promise((resolve) => {
        try {
          raw.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  });
}

/**
 * Open a wrapped SQLite connection with the configured driver.
 * @param {string} dbPath
 * @param {{ readonly?: boolean, isolated?: boolean }} [opts]
 */
export async function openSqliteConnection(dbPath, opts = {}) {
  const readonly = Boolean(opts.readonly);
  if (await useBetterSqlite()) {
    const Database = (await import("better-sqlite3")).default;
    const write = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
    applyPragmasBetter(write, { readonly });
    let read = null;
    if (!readonly && !opts.isolated) {
      try {
        read = new Database(dbPath, { readonly: true, fileMustExist: true });
        applyPragmasBetter(read, { readonly: true });
      } catch {
        read = null;
      }
    }
    return wrapBetterSqlite(write, read);
  }

  const raw = await new Promise((resolve, reject) => {
    const mode = readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    const d = new sqlite3.Database(dbPath, mode, (err) => (err ? reject(err) : resolve(d)));
  });
  const db = wrapNodeSqlite(raw);
  await applyPragmasSqlite3(db);
  return db;
}

export async function closeSqliteConnection(db) {
  if (!db) return;
  if (typeof db.close === "function") {
    await db.close();
    return;
  }
  if (db.raw?.close) {
    await new Promise((resolve) => {
      try {
        db.raw.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
