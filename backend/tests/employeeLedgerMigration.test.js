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

async function downgradeLedgerToPreCorrectionSchema(db) {
  await db.exec("DROP INDEX IF EXISTS idx_employee_ledger_intended");
  await db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE employee_ledger_entries_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('salary_payment')),
      purpose TEXT NOT NULL DEFAULT 'salary_advance'
        CHECK (purpose IN ('salary_advance', 'salary_payment')),
      occurred_on TEXT NOT NULL,
      amount REAL NOT NULL,
      operating_expense_id INTEGER UNIQUE REFERENCES operating_expenses(id),
      advance_request_id INTEGER UNIQUE REFERENCES advance_requests(id),
      shift_cash_movement_id INTEGER UNIQUE,
      idempotency_key TEXT UNIQUE,
      event_seq INTEGER NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO employee_ledger_entries_old (
      id, employee_id, entry_type, purpose, occurred_on, amount,
      operating_expense_id, advance_request_id, shift_cash_movement_id,
      idempotency_key, event_seq, created_by, created_at
    )
    SELECT
      id, employee_id, entry_type, purpose, occurred_on, amount,
      operating_expense_id, advance_request_id, shift_cash_movement_id,
      idempotency_key, event_seq, created_by, created_at
    FROM employee_ledger_entries
    WHERE entry_type = 'salary_payment';
    DROP TABLE employee_ledger_entries;
    ALTER TABLE employee_ledger_entries_old RENAME TO employee_ledger_entries;
    CREATE INDEX IF NOT EXISTS idx_employee_ledger_emp_date
      ON employee_ledger_entries(employee_id, occurred_on, event_seq);
    PRAGMA foreign_keys = ON;
  `);
}

async function assertCorrectionSchema(db) {
  const col = await db.get(
    "SELECT 1 AS x FROM pragma_table_info('employee_ledger_entries') WHERE name = 'intended_employee_id' LIMIT 1"
  );
  expect(col).toBeTruthy();
  const sql = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='employee_ledger_entries'"
  );
  expect(String(sql?.sql || "")).toMatch(/intended_employee_id/);
  expect(String(sql?.sql || "")).toMatch(/salary_payment_reversal/);
  const idx = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_employee_ledger_intended'"
  );
  expect(idx?.sql || "").toMatch(/intended_employee_id/);
}

describe("employee_ledger_entries correction migration", () => {
  test("HrTables does not index intended_employee_id; correction migration adds the column before the index", () => {
    const hr = sliceFn(INIT_SRC, "migrateEmployeeHrTables", "migrateEmployeeSalaryEntitlements");
    expect(hr).not.toMatch(/idx_employee_ledger_intended/);

    const corr = sliceFn(INIT_SRC, "migrateEmployeePaymentCorrections", "migrateAttendanceTables");
    const columnAt = corr.indexOf("intended_employee_id INTEGER");
    const indexAt = corr.indexOf("idx_employee_ledger_intended");
    expect(columnAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(columnAt);
  });

  test("old ledger schema gains intended_employee_id before its index; second init succeeds", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-ledger-mig-"));
    const dbPath = path.join(tmpDir, "legacy-ledger.db");
    let db;
    try {
      db = await initDatabase(dbPath);
      const emp = await db.run("INSERT INTO employees (name, active) VALUES ('موظف ترحيل دفتر', 1)");
      const led = await db.run(
        `INSERT INTO employee_ledger_entries
           (employee_id, entry_type, purpose, occurred_on, amount, event_seq)
         VALUES (?, 'salary_payment', 'salary_payment', '2026-08-01', 25, 1)`,
        [emp.lastID]
      );
      const originalId = led.lastID;

      await downgradeLedgerToPreCorrectionSchema(db);
      expect(
        await db.get(
          "SELECT 1 AS x FROM pragma_table_info('employee_ledger_entries') WHERE name = 'intended_employee_id'"
        )
      ).toBeFalsy();
      expect(
        await db.get(
          "SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_employee_ledger_intended'"
        )
      ).toBeFalsy();
      expect(
        await db.get("SELECT amount FROM employee_ledger_entries WHERE id = ?", [originalId])
      ).toEqual({ amount: 25 });

      await closeSqliteConnection(db);
      db = null;

      db = await initDatabase(dbPath);
      await assertCorrectionSchema(db);
      const kept = await db.get("SELECT id, amount, status FROM employee_ledger_entries WHERE id = ?", [
        originalId,
      ]);
      expect(kept.id).toBe(originalId);
      expect(Number(kept.amount)).toBe(25);
      expect(kept.status).toBe("active");

      await closeSqliteConnection(db);
      db = await initDatabase(dbPath);
      await assertCorrectionSchema(db);
      expect(
        Number(
          (await db.get("SELECT amount FROM employee_ledger_entries WHERE id = ?", [originalId])).amount
        )
      ).toBe(25);
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
