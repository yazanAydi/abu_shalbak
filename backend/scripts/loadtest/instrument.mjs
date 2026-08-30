function isBusyError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg)
  );
}

function classifySql(sql) {
  const s = String(sql || "").trim();
  if (/^BEGIN\b/i.test(s)) return "begin";
  if (/^COMMIT\b/i.test(s)) return "commit";
  if (/^ROLLBACK\b/i.test(s)) return "rollback";
  return "other";
}

/**
 * Wrap a promisified sqlite db without changing production code.
 * Retries of BEGIN IMMEDIATE appear as repeated begin attempts.
 */
export function instrument(db) {
  const stats = {
    statements: 0,
    begins: 0,
    beginAttempts: 0,
    commits: 0,
    rollbacks: 0,
    busy: 0,
    locked: 0,
    retries: 0,
    txFailures: 0,
    dbErrors: {},
    txHoldMs: [],
    queueWaitMs: [],
    lastBeginStarted: 0,
    pendingBeginAttempts: 0,
  };
  stats.snapshot = () => snapshotStats(stats);

  let txOpenAt = 0;
  let lastBeginFinished = 0;

  const wrap = (method) => {
    const orig = db[method].bind(db);
    return async (...args) => {
      const sql = args[0];
      const kind = classifySql(sql);
      stats.statements += 1;
      if (kind === "begin") {
        stats.beginAttempts += 1;
        stats.pendingBeginAttempts += 1;
        if (lastBeginFinished) stats.queueWaitMs.push(Date.now() - lastBeginFinished);
        stats.lastBeginStarted = Date.now();
      }
      try {
        const result = await orig(...args);
        if (kind === "begin") {
          stats.begins += 1;
          if (stats.pendingBeginAttempts > 1) stats.retries += stats.pendingBeginAttempts - 1;
          stats.pendingBeginAttempts = 0;
          txOpenAt = Date.now();
        }
        if (kind === "commit" || kind === "rollback") {
          if (txOpenAt) stats.txHoldMs.push(Date.now() - txOpenAt);
          txOpenAt = 0;
          lastBeginFinished = Date.now();
          if (kind === "commit") stats.commits += 1;
          else {
            stats.rollbacks += 1;
            stats.txFailures += 1;
          }
        }
        return result;
      } catch (err) {
        if (isBusyError(err)) {
          stats.busy += 1;
          if (String(err.code) === "SQLITE_LOCKED") stats.locked += 1;
        } else if (kind === "begin") {
          stats.pendingBeginAttempts = 0;
        }
        const code = String(err?.code || err?.message || "unknown");
        stats.dbErrors[code] = (stats.dbErrors[code] || 0) + 1;
        if (kind === "commit" || kind === "rollback") stats.txFailures += 1;
        throw err;
      }
    };
  };

  const wrapped = Object.create(db);
  wrapped.run = wrap("run");
  wrapped.get = wrap("get");
  wrapped.all = wrap("all");
  wrapped.exec = wrap("exec");
  wrapped.raw = db.raw;
  wrapped.driver = db.driver;
  wrapped.close = db.close?.bind(db);
  wrapped.snapshot = () => snapshotStats(stats);
  return { db: wrapped, stats };
}

export function snapshotStats(stats) {
  const hold = [...stats.txHoldMs].sort((a, b) => a - b);
  const wait = [...stats.queueWaitMs].sort((a, b) => a - b);
  const pct = (arr, p) => {
    if (!arr.length) return 0;
    return arr[Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))];
  };
  return {
    statements: stats.statements,
    begins: stats.begins,
    beginAttempts: stats.beginAttempts,
    commits: stats.commits,
    rollbacks: stats.rollbacks,
    busy: stats.busy,
    locked: stats.locked,
    retries: stats.retries,
    txFailures: stats.txFailures,
    dbErrors: { ...stats.dbErrors },
    txHoldMs: { p50: pct(hold, 50), p95: pct(hold, 95), max: hold.at(-1) || 0, n: hold.length },
    queueWaitMs: { p50: pct(wait, 50), p95: pct(wait, 95), max: wait.at(-1) || 0, n: wait.length },
  };
}
