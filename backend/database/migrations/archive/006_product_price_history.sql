-- Product selling-price change history (Product 360 Dashboard).
-- Applied programmatically in database/init.js (migrateProductPriceHistoryTable).
-- Historical reports never read this table for amounts; it only documents WHEN/WHO/WHY
-- the current products.price changed. Sale amounts come from transaction_items snapshots.

CREATE TABLE IF NOT EXISTS product_price_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  old_price          REAL,
  new_price          REAL NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id),
  reason             TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_price_history_created ON product_price_history(created_at);

-- Optional product columns added via ALTER TABLE if missing (migrateProductsExtendedColumns):
--   sku        TEXT  optional stock-keeping unit (header falls back to barcode)
--   image_url  TEXT  optional product image (header falls back to initials avatar)
