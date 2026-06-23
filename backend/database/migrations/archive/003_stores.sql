-- Stores table and store_id columns for multi-branch readiness
-- Applied programmatically in database/init.js (migrateStoresTable, migrateStoreIdColumns)

CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  name_ar     TEXT,
  branch_code TEXT UNIQUE,
  address     TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO stores (id, name, name_ar, branch_code)
VALUES (1, 'Main Branch', 'الفرع الرئيسي', 'MAIN');
