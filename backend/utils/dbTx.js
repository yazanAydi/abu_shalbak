/**
 * Serialized write-transaction helper.
 *
 * node-sqlite3 uses a single shared connection, so two overlapping
 * `BEGIN IMMEDIATE ... COMMIT` blocks on the same connection fail with
 * "cannot start a transaction within a transaction". To make concurrent
 * writers (e.g. two cashiers checking out at the same time) safe, every
 * write transaction is funneled through a per-connection async queue.
 *
 * Each transaction still runs as a real `BEGIN IMMEDIATE ... COMMIT` so
 * SQLite's atomicity and durability guarantees are preserved; the queue
 * only guarantees they never overlap on the shared connection. The atomic
 * `UPDATE ... SET stock = stock + ?` inside the transaction means no stock
 * delta is ever lost — including when stock legitimately goes negative.
 */

const chains = new WeakMap();

/**
 * Run `fn` inside a serialized BEGIN IMMEDIATE / COMMIT transaction.
 * Rolls back automatically if `fn` throws. Returns whatever `fn` returns.
 *
 * @template T
 * @param {{ run: Function }} db wrapped sqlite db (see database/init.js)
 * @param {() => Promise<T>} fn work to perform inside the transaction
 * @returns {Promise<T>}
 */
export function withTransaction(db, fn) {
  const prev = chains.get(db) || Promise.resolve();
  // Gate never rejects, so a failed transaction does not poison the queue.
  const gate = prev.then(
    () => {},
    () => {}
  );

  const result = gate.then(async () => {
    await db.run("BEGIN IMMEDIATE");
    try {
      const value = await fn();
      await db.run("COMMIT");
      return value;
    } catch (err) {
      try {
        await db.run("ROLLBACK");
      } catch (_) {
        /* rollback best-effort */
      }
      throw err;
    }
  });

  // Next queued transaction waits for this one to fully settle.
  chains.set(
    db,
    result.then(
      () => {},
      () => {}
    )
  );

  return result;
}
