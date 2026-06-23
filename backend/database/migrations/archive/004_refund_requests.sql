-- Refund approval queue (Telegram + admin fallback)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS refund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  manager_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES cashier_shifts(id),
  items_json TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  total_amount REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'visa')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  telegram_message_id TEXT,
  refund_id INTEGER REFERENCES refunds(id),
  review_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_status_created ON refund_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_refund_requests_cashier ON refund_requests(cashier_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_tx ON refund_requests(transaction_id);
