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

function sliceFn(src, name, nextName) {
  const start = src.indexOf(`async function ${name}`);
  const end = src.indexOf(`async function ${nextName}`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

async function downgradeCashierShiftsToPrePendingCount(db) {
  await db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS cashier_shifts__old;
    CREATE TABLE cashier_shifts__old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      start_time TEXT NOT NULL DEFAULT (datetime('now')),
      end_time TEXT,
      opening_cash REAL NOT NULL,
      closing_cash REAL,
      expected_cash REAL,
      variance REAL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actual_cash REAL,
      card_total REAL,
      refund_total REAL,
      closing_notes TEXT,
      manager_approved_by INTEGER REFERENCES users(id),
      manager_approved_at TEXT,
      variance_threshold REAL,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      store_id INTEGER NOT NULL DEFAULT 1,
      hourly_rate_snapshot REAL,
      counted_cash_json TEXT
    );
    INSERT INTO cashier_shifts__old (
      id, cashier_id, start_time, end_time, opening_cash, closing_cash, expected_cash,
      variance, notes, status, created_at, actual_cash, card_total, refund_total,
      closing_notes, manager_approved_by, manager_approved_at, variance_threshold,
      requires_approval, store_id, hourly_rate_snapshot, counted_cash_json
    )
    SELECT
      id, cashier_id, start_time, end_time, opening_cash, closing_cash, expected_cash,
      variance, notes, status, created_at, actual_cash, card_total, refund_total,
      closing_notes, manager_approved_by, manager_approved_at, variance_threshold,
      requires_approval, store_id, hourly_rate_snapshot, counted_cash_json
    FROM cashier_shifts
    WHERE status IN ('open', 'closed');
    DROP TABLE cashier_shifts;
    ALTER TABLE cashier_shifts__old RENAME TO cashier_shifts;
    PRAGMA foreign_keys = ON;
  `);
}

describe("cashier_shifts hourly_rate_snapshot migration", () => {
  test("pending_count rebuild SQL copies hourly_rate_snapshot", () => {
    const src = sliceFn(
      INIT_SRC,
      "migrateCashierShiftsPendingStatus",
      "migrateOneOpenShiftPerCashier"
    );
    expect(src).toMatch(/hourly_rate_snapshot REAL/);
    expect(src).toMatch(/hourly_rate_snapshot, counted_cash_json/);
  });

  test("pending_count rebuild keeps existing hourly_rate_snapshot values", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-shift-snap-"));
    const dbPath = path.join(tmpDir, "legacy-shifts.db");
    let db;
    try {
      db = await initDatabase(dbPath);
      const cashier = await db.get("SELECT id FROM users WHERE username = 'cashier1'");
      expect(cashier).toBeTruthy();
      const ins = await db.run(
        `INSERT INTO cashier_shifts
           (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot, counted_cash_json)
         VALUES (?, '2026-07-02 08:00:00', '2026-07-02 16:00:00', 100, 'closed', 22.5, '{"nis":100}')`,
        [cashier.id]
      );
      const shiftId = ins.lastID;

      await downgradeCashierShiftsToPrePendingCount(db);
      const sql = await db.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cashier_shifts'"
      );
      expect(String(sql?.sql || "")).not.toMatch(/pending_count/);
      expect(
        Number(
          (await db.get("SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?", [shiftId]))
            .hourly_rate_snapshot
        )
      ).toBe(22.5);

      await closeSqliteConnection(db);
      db = null;
      db = await initDatabase(dbPath);

      const migratedSql = await db.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cashier_shifts'"
      );
      expect(String(migratedSql?.sql || "")).toMatch(/pending_count/);
      const kept = await db.get(
        "SELECT hourly_rate_snapshot, counted_cash_json FROM cashier_shifts WHERE id = ?",
        [shiftId]
      );
      expect(Number(kept.hourly_rate_snapshot)).toBe(22.5);
      expect(kept.counted_cash_json).toBe('{"nis":100}');

      await closeSqliteConnection(db);
      db = await initDatabase(dbPath);
      expect(
        Number(
          (await db.get("SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?", [shiftId]))
            .hourly_rate_snapshot
        )
      ).toBe(22.5);
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
