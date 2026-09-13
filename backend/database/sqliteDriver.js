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
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 10000");
  // journal_mode=WAL rewrites the file header. A readonly handle on a
  // DELETE-mode snapshot (VACUUM INTO) fails with SQLITE_READONLY.
  if (!readonly) {
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("cache_size = -64000");
    raw.pragma("temp_store = MEMORY");
    raw.pragma("mmap_size = 268435456");
  }
}

function applyPragmasSqlite3(db, { readonly = false } = {}) {
  if (readonly) {
    return db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 10000;
    `);
  }
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

export function wrapBetterSqlite(writeRaw, readRaw) {
  // Statements are bound to the Database they were prepared on. Cache per
  // connection so a GET that primed the readonly handle cannot later satisfy
  // a writer/transaction read of the same SQL (or vice versa).
  const stmtCaches = new Map();
  const MAX_STMTS = 256;
  let writerTxDepth = 0;

  function cacheFor(raw) {
    let cache = stmtCaches.get(raw);
    if (!cache) {
      cache = new Map();
      stmtCaches.set(raw, cache);
    }
    return cache;
  }

  function prepare(raw, sql) {
    const cache = cacheFor(raw);
    let stmt = cache.get(sql);
    if (!stmt || (stmt.database && stmt.database !== raw)) {
      stmt = raw.prepare(sql);
      if (cache.size >= MAX_STMTS) {
        const first = cache.keys().next().value;
        cache.delete(first);
      }
      cache.set(sql, stmt);
    }
    return stmt;
  }

  function isSelect(sql) {
    return /^\s*SELECT\b/i.test(String(sql || ""));
  }

  function target(sql) {
    // Concurrent GET/HEAD reads keep using the readonly WAL snapshot even
    // while a writer transaction is open. Only the writer-side async work
    // (no readonly preference) must stay on writeRaw so it sees its own
    // uncommitted changes and never a cached readonly statement.
    if (writerTxDepth > 0 && !preferReadonlyReads()) {
      return writeRaw;
    }
    if (readRaw && preferReadonlyReads() && isSelect(sql)) {
      return readRaw;
    }
    return writeRaw;
  }

  function withWriterTxTracking(sql, fn) {
    const kind = txKeyword(sql);
    if (kind === "begin") writerTxDepth += 1;
    try {
      const result = fn();
      if (kind === "end") writerTxDepth = Math.max(0, writerTxDepth - 1);
      return result;
    } catch (err) {
      if (kind === "begin") writerTxDepth = Math.max(0, writerTxDepth - 1);
      throw err;
    }
  }

  function clearStmtCaches() {
    stmtCaches.clear();
  }

  return wrapShared(
    (sql, params) =>
      Promise.resolve().then(() =>
        withWriterTxTracking(sql, () => {
          const info = prepare(target(sql), sql).run(params);
          return { lastID: Number(info.lastInsertRowid), changes: info.changes };
        })
      ),
    (sql, params) => Promise.resolve().then(() => prepare(target(sql), sql).get(params)),
    (sql, params) => Promise.resolve().then(() => prepare(target(sql), sql).all(params)),
    (sql) =>
      Promise.resolve().then(() =>
        withWriterTxTracking(sql, () => {
          target(sql).exec(sql);
        })
      ),
    {
      raw: writeRaw,
      driver: "better-sqlite3",
      close() {
        return Promise.resolve().then(() => {
          clearStmtCaches();
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
    let read = null;
    try {
      applyPragmasBetter(write, { readonly });
      if (!readonly && !opts.isolated) {
        try {
          read = new Database(dbPath, { readonly: true, fileMustExist: true });
          applyPragmasBetter(read, { readonly: true });
        } catch {
          read = null;
        }
      }
      return wrapBetterSqlite(write, read);
    } catch (err) {
      try {
        read?.close();
      } catch {
        /* ignore */
      }
      try {
        write.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  const raw = await new Promise((resolve, reject) => {
    const mode = readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    const d = new sqlite3.Database(dbPath, mode, (err) => (err ? reject(err) : resolve(d)));
  });
  const db = wrapNodeSqlite(raw);
  try {
    await applyPragmasSqlite3(db, { readonly });
    return db;
  } catch (err) {
    await closeSqliteConnection(db);
    throw err;
  }
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
