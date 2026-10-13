import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-abo-shalbak-tests-only";
process.env.DISABLE_AUTO_BACKUP = "1";

const INIT_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../database/init.js"),
  "utf8"
);

function migrateSource() {
  const start = INIT_SRC.indexOf("async function migrateStockCountTables");
  const end = INIT_SRC.indexOf("async function migrateTransactionsDiscount");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return INIT_SRC.slice(start, end);
}

async function restorePreUniquenessCountLines(db) {
  await db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_sc_line_source;
    DROP TRIGGER IF EXISTS stock_count_lines_reject_legacy_insert;
    DROP TRIGGER IF EXISTS stock_count_lines_lock_line_origin;
    DROP TABLE IF EXISTS stock_count_lines;
    CREATE TABLE stock_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      system_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      variance REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      batch_source TEXT,
      expiry_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sc_lines_session ON stock_count_lines(session_id);
    CREATE INDEX IF NOT EXISTS idx_sc_lines_product ON stock_count_lines(product_id);
    PRAGMA foreign_keys = ON;
  `);
}

async function insertLine(db, row) {
  const ins = await db.run(
    `INSERT INTO stock_count_lines
       (session_id, product_id, system_qty, counted_qty, variance, created_at, batch_source, expiry_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.sessionId,
      row.productId,
      row.systemQty,
      row.countedQty,
      row.variance,
      row.createdAt,
      row.batchSource,
      row.expiryDate,
    ]
  );
  return ins.lastID;
}

describe("stock count source uniqueness migration", () => {
  test("the count migration does not delete lines", () => {
    expect(migrateSource()).not.toMatch(/DELETE\s+FROM\s+stock_count_lines/i);
  });

  test("upgrade keeps duplicate legacy lines and rejects new duplicate sources", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-count-mig-"));
    const dbPath = path.join(tmpDir, "legacy-counts.db");
    let db;
    try {
      db = await initDatabase(dbPath);
      const product = await db.get("SELECT id FROM products ORDER BY id LIMIT 1");
      const posted = await db.run(
        "INSERT INTO stock_count_sessions (status, notes) VALUES ('posted', 'identical-legacy')"
      );
      const open = await db.run(
        "INSERT INTO stock_count_sessions (status, notes) VALUES ('open', 'different-legacy')"
      );
      const mixed = await db.run(
        "INSERT INTO stock_count_sessions (status, notes) VALUES ('posted', 'dated-undated')"
      );
      await restorePreUniquenessCountLines(db);

      const identical = [];
      for (let i = 0; i < 2; i += 1) {
        identical.push(await insertLine(db, {
          sessionId: posted.lastID,
          productId: product.id,
          systemQty: 10,
          countedQty: 10,
          variance: 0,
          createdAt: "2026-01-01 08:00:00",
          batchSource: null,
          expiryDate: null,
        }));
      }
      const different = [
        await insertLine(db, {
          sessionId: open.lastID,
          productId: product.id,
          systemQty: 8,
          countedQty: 4,
          variance: -4,
          createdAt: "2026-01-02 08:00:00",
          batchSource: null,
          expiryDate: null,
        }),
        await insertLine(db, {
          sessionId: open.lastID,
          productId: product.id,
          systemQty: 8,
          countedQty: 9,
          variance: 1,
          createdAt: "2026-01-02 09:00:00",
          batchSource: null,
          expiryDate: null,
        }),
      ];
      const datedId = await insertLine(db, {
        sessionId: mixed.lastID,
        productId: product.id,
        systemQty: 6,
        countedQty: 5,
        variance: -1,
        createdAt: "2026-01-03 08:00:00",
        batchSource: "dated",
        expiryDate: "2026-10-15",
      });
      const undatedId = await insertLine(db, {
        sessionId: mixed.lastID,
        productId: product.id,
        systemQty: 2,
        countedQty: 2,
        variance: 0,
        createdAt: "2026-01-03 08:05:00",
        batchSource: "undated",
        expiryDate: null,
      });

      await closeSqliteConnection(db);
      db = null;
      db = await initDatabase(dbPath);

      const afterFirst = await db.all(
        `SELECT id, session_id, counted_qty, variance, batch_source, expiry_date, line_origin, created_at
           FROM stock_count_lines ORDER BY id`
      );
      expect(afterFirst.map((row) => row.id)).toEqual([...identical, ...different, datedId, undatedId]);
      expect(afterFirst.filter((row) => identical.includes(row.id)).map((row) => row.counted_qty)).toEqual([10, 10]);
      expect(afterFirst.filter((row) => different.includes(row.id)).map((row) => row.counted_qty)).toEqual([4, 9]);
      expect(afterFirst.filter((row) => identical.concat(different).includes(row.id)).every((row) => row.line_origin === "legacy")).toBe(true);
      const dated = afterFirst.find((row) => row.id === datedId);
      const undated = afterFirst.find((row) => row.id === undatedId);
      expect(dated).toMatchObject({ counted_qty: 5, batch_source: "dated", expiry_date: "2026-10-15", line_origin: "current" });
      expect(undated).toMatchObject({ counted_qty: 2, batch_source: "undated", expiry_date: null, line_origin: "current" });
      const sessions = await db.all(
        "SELECT id, status, notes FROM stock_count_sessions WHERE id IN (?, ?, ?) ORDER BY id",
        [posted.lastID, open.lastID, mixed.lastID]
      );
      expect(sessions.map((row) => row.status)).toEqual(["posted", "open", "posted"]);

      const indexSql = await db.get(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sc_line_source'"
      );
      expect(String(indexSql.sql)).toMatch(/WHERE line_origin = 'current'/);

      await expect(db.run(
        `INSERT INTO stock_count_lines
           (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date, line_origin)
         VALUES (?, ?, 1, 1, 0, 'dated', '2026-10-15', 'current')`,
        [mixed.lastID, product.id]
      )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      await expect(db.run(
        `INSERT INTO stock_count_lines
           (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
         VALUES (?, ?, 1, 0, -1, 'undated', NULL)`,
        [mixed.lastID, product.id]
      )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      await expect(db.run(
        `INSERT INTO stock_count_lines
           (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date, line_origin)
         VALUES (?, ?, 1, 1, 0, NULL, NULL, 'legacy')`,
        [posted.lastID, product.id]
      )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      const currentProductOnly = await db.run(
        `INSERT INTO stock_count_lines
           (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
         VALUES (?, ?, 3, 3, 0, NULL, NULL)`,
        [posted.lastID, product.id]
      );
      await expect(db.run(
        `INSERT INTO stock_count_lines
           (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date)
         VALUES (?, ?, 7, 1, -6, NULL, NULL)`,
        [posted.lastID, product.id]
      )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      await expect(db.run(
        "UPDATE stock_count_lines SET line_origin = 'current' WHERE id = ?",
        [identical[0]]
      )).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      expect((await db.get("SELECT line_origin FROM stock_count_lines WHERE id = ?", [identical[0]])).line_origin).toBe("legacy");

      await closeSqliteConnection(db);
      db = null;
      db = await initDatabase(dbPath);

      const afterSecond = await db.all(
        `SELECT id, counted_qty, variance, batch_source, expiry_date, line_origin, created_at
           FROM stock_count_lines ORDER BY id`
      );
      expect(afterSecond).toEqual([
        ...afterFirst.map((row) => ({
          id: row.id,
          counted_qty: row.counted_qty,
          variance: row.variance,
          batch_source: row.batch_source,
          expiry_date: row.expiry_date,
          line_origin: row.line_origin,
          created_at: row.created_at,
        })),
        expect.objectContaining({
          id: currentProductOnly.lastID,
          counted_qty: 3,
          line_origin: "current",
          batch_source: null,
        }),
      ]);
    } finally {
      try {
        if (db) await closeSqliteConnection(db);
      } catch {
        /* ignore */
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
