import fs from "fs";
import os from "os";
import path from "path";
import {
  closeSqliteConnection,
  openSqliteConnection,
  useBetterSqlite,
  wrapBetterSqlite,
} from "../database/sqliteDriver.js";
import { withTransaction } from "../utils/dbTx.js";
import { readPreferenceAls } from "../utils/queryStats.js";

const SELECT_SQL = "SELECT value FROM kv WHERE id = 1";

async function openScratchDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-sqlite-"));
  const dbPath = path.join(tmpDir, "stmt-cache.db");
  const db = await openSqliteConnection(dbPath);
  await db.exec(`CREATE TABLE kv (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);
  await db.run(`INSERT INTO kv (id, value) VALUES (1, 10)`);
  return { db, dbPath, tmpDir };
}

async function destroyScratch({ db, tmpDir }) {
  try {
    await closeSqliteConnection(db);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const betterSqlite = await useBetterSqlite();
const describeBetter = betterSqlite ? describe : describe.skip;

describe("sqlite driver statement cache", () => {
  test("commit and rollback remain correct on the public db API", async () => {
    const scratch = await openScratchDb();
    try {
      await withTransaction(scratch.db, async () => {
        await scratch.db.run("UPDATE kv SET value = 42 WHERE id = 1");
        const mid = await scratch.db.get(SELECT_SQL);
        expect(mid.value).toBe(42);
      });
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(42);

      await scratch.db.run("BEGIN IMMEDIATE");
      await scratch.db.run("UPDATE kv SET value = 7 WHERE id = 1");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(7);
      await scratch.db.run("ROLLBACK");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(42);
    } finally {
      await destroyScratch(scratch);
    }
  });
});

describeBetter("readonly vs writer statement isolation", () => {
  test("readonly-primed SELECT does not hide uncommitted writer changes", async () => {
    const scratch = await openScratchDb();
    try {
      await readPreferenceAls.run({ readonly: true }, async () => {
        const primed = await scratch.db.get(SELECT_SQL);
        expect(primed.value).toBe(10);
      });

      await scratch.db.run("BEGIN IMMEDIATE");
      await scratch.db.run("UPDATE kv SET value = 99 WHERE id = 1");
      const insideTx = await scratch.db.get(SELECT_SQL);
      expect(insideTx.value).toBe(99);

      await scratch.db.run("ROLLBACK");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(10);
    } finally {
      await destroyScratch(scratch);
    }
  });

  test("WAL snapshot reads stay on the readonly connection during a writer tx", async () => {
    const scratch = await openScratchDb();
    try {
      await readPreferenceAls.run({ readonly: true }, () => scratch.db.get(SELECT_SQL));

      await scratch.db.run("BEGIN IMMEDIATE");
      await scratch.db.run("UPDATE kv SET value = 77 WHERE id = 1");

      const started = Date.now();
      const snapshot = await readPreferenceAls.run({ readonly: true }, () =>
        scratch.db.get(SELECT_SQL)
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(snapshot.value).toBe(10);
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(77);

      await scratch.db.run("COMMIT");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(77);

      const afterCommit = await readPreferenceAls.run({ readonly: true }, () =>
        scratch.db.get(SELECT_SQL)
      );
      expect(afterCommit.value).toBe(77);
    } finally {
      await destroyScratch(scratch);
    }
  });

  test("writes after a readonly cache prime still use the writer connection", async () => {
    const scratch = await openScratchDb();
    try {
      await readPreferenceAls.run({ readonly: true }, () => scratch.db.get(SELECT_SQL));
      await scratch.db.run("UPDATE kv SET value = 3 WHERE id = 1");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(3);

      const snapshot = await readPreferenceAls.run({ readonly: true }, () =>
        scratch.db.get(SELECT_SQL)
      );
      expect(snapshot.value).toBe(3);
    } finally {
      await destroyScratch(scratch);
    }
  });

  test("closing the connection drops cached statements so a replacement handle works", async () => {
    const scratch = await openScratchDb();
    try {
      await readPreferenceAls.run({ readonly: true }, () => scratch.db.get(SELECT_SQL));
      await scratch.db.run("UPDATE kv SET value = 5 WHERE id = 1");
      await closeSqliteConnection(scratch.db);

      scratch.db = await openSqliteConnection(scratch.dbPath);
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(5);
      await scratch.db.run("BEGIN IMMEDIATE");
      await scratch.db.run("UPDATE kv SET value = 6 WHERE id = 1");
      expect((await scratch.db.get(SELECT_SQL)).value).toBe(6);
      await scratch.db.run("COMMIT");
    } finally {
      await destroyScratch(scratch);
    }
  });
});

function createMockPair() {
  let committed = 10;
  let writerUncommitted = null;
  let txOpen = false;

  function makeDb(role) {
    const db = {
      role,
      closed: false,
      prepared: [],
      executed: [],
      prepare(sql) {
        db.prepared.push(sql);
        return {
          database: db,
          sql,
          run(params = []) {
            db.executed.push({ op: "run", sql });
            const head = String(sql).trim().split(/\s+/)[0].toUpperCase();
            if (head === "BEGIN") {
              txOpen = true;
              writerUncommitted = committed;
            } else if (head === "COMMIT") {
              if (writerUncommitted != null) committed = writerUncommitted;
              writerUncommitted = null;
              txOpen = false;
            } else if (head === "ROLLBACK") {
              writerUncommitted = null;
              txOpen = false;
            } else if (/^UPDATE\b/i.test(sql)) {
              const next = Number(params[0]);
              if (txOpen) writerUncommitted = next;
              else committed = next;
            }
            return { lastInsertRowid: 1, changes: 1 };
          },
          get() {
            db.executed.push({ op: "get", sql });
            if (role === "write") {
              return {
                value: txOpen && writerUncommitted != null ? writerUncommitted : committed,
              };
            }
            return { value: committed };
          },
          all() {
            return [];
          },
        };
      },
      exec(sql) {
        db.executed.push({ op: "exec", sql });
      },
      close() {
        db.closed = true;
      },
    };
    return db;
  }

  return { writeRaw: makeDb("write"), readRaw: makeDb("read") };
}

describe("per-connection statement cache (mock connections)", () => {
  test("readonly-primed SELECT is not reused for an uncommitted writer read", async () => {
    const { writeRaw, readRaw } = createMockPair();
    const db = wrapBetterSqlite(writeRaw, readRaw);

    await readPreferenceAls.run({ readonly: true }, () => db.get(SELECT_SQL));
    expect(readRaw.prepared).toContain(SELECT_SQL);
    expect(writeRaw.prepared).not.toContain(SELECT_SQL);

    await db.run("BEGIN IMMEDIATE");
    await db.run("UPDATE kv SET value = ? WHERE id = 1", [99]);
    const insideTx = await db.get(SELECT_SQL);
    expect(insideTx.value).toBe(99);
    expect(writeRaw.prepared).toContain(SELECT_SQL);

    const snapshot = await readPreferenceAls.run({ readonly: true }, () => db.get(SELECT_SQL));
    expect(snapshot.value).toBe(10);

    await db.run("ROLLBACK");
    expect((await db.get(SELECT_SQL)).value).toBe(10);
  });

  test("commit publishes writer changes; rollback does not", async () => {
    const { writeRaw, readRaw } = createMockPair();
    const db = wrapBetterSqlite(writeRaw, readRaw);

    await withTransaction(db, async () => {
      await db.run("UPDATE kv SET value = ? WHERE id = 1", [42]);
      expect((await db.get(SELECT_SQL)).value).toBe(42);
    });
    expect((await db.get(SELECT_SQL)).value).toBe(42);
    expect(
      (await readPreferenceAls.run({ readonly: true }, () => db.get(SELECT_SQL))).value
    ).toBe(42);

    await db.run("BEGIN IMMEDIATE");
    await db.run("UPDATE kv SET value = ? WHERE id = 1", [7]);
    expect((await db.get(SELECT_SQL)).value).toBe(7);
    await db.run("ROLLBACK");
    expect((await db.get(SELECT_SQL)).value).toBe(42);
  });

  test("close finalizes by dropping caches and closing both connections", async () => {
    const { writeRaw, readRaw } = createMockPair();
    const db = wrapBetterSqlite(writeRaw, readRaw);
    await readPreferenceAls.run({ readonly: true }, () => db.get(SELECT_SQL));
    await db.run("UPDATE kv SET value = ? WHERE id = 1", [5]);
    await db.close();
    expect(writeRaw.closed).toBe(true);
    expect(readRaw.closed).toBe(true);
  });
});
