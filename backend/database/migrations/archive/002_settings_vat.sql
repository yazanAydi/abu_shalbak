-- App settings + product extended fields (SQLite)
-- Applied automatically via init.js migrations.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Defaults seeded in init.js seedDefaultSettings():
--   default_tax_rate         = 0.16
--   tax_inclusive            = 1      (shelf price includes VAT — Hesabate default)
--   business_day_cutoff_hour = 0      (change to e.g. 3 for late-night shifts)
--   receipt_show_tax         = 1
--   receipt_show_cashier     = 1
--   receipt_logo_url         = ''

-- Extended product columns added via migrateProductsExtendedColumns():
--   tax_rate    REAL     per-item override; NULL = use default_tax_rate
--   name_en     TEXT     English name for shelf labels / export
--   unit        TEXT     حبة / كرتون / كيلو
--   expiry_date TEXT     YYYY-MM-DD; used for صلاحية reports
--   min_price   REAL     optional POS guardrail
--   max_price   REAL     optional POS guardrail
