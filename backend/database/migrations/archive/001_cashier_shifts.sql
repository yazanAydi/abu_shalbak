-- Cashier shifts + cash movement audit (SQLite)
-- Apply to an existing DB if not using init.js auto-migration.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cashier_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  start_time TEXT NOT NULL DEFAULT (datetime('now')),
  end_time TEXT,
  opening_cash REAL NOT NULL,
  closing_cash REAL,
  expected_cash REAL,
  variance REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_count', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES cashier_shifts(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('opening', 'payment', 'refund', 'adjustment', 'closing')),
  amount REAL NOT NULL,
  description TEXT,
  transaction_id INTEGER REFERENCES transactions(id),
  refund_id INTEGER REFERENCES refunds(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cashier_shifts_cashier_status ON cashier_shifts(cashier_id, status);
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_start ON cashier_shifts(start_time);
CREATE INDEX IF NOT EXISTS idx_shift_movements_shift_time ON shift_cash_movements(shift_id, created_at);

-- Add columns only if missing (run manually or use init.js migrations)
-- ALTER TABLE transactions ADD COLUMN shift_id INTEGER REFERENCES cashier_shifts(id);
-- ALTER TABLE refunds ADD COLUMN shift_id INTEGER REFERENCES cashier_shifts(id);
