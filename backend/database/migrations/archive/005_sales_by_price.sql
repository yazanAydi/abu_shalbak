-- Price snapshot columns on transaction_items for Sales-by-Price reporting
-- Applied programmatically in database/init.js (migrateTransactionItemsPriceSnapshots)

-- New columns (added via ALTER TABLE if missing):
--   unit_cost_at_sale  REAL  cost at sale time
--   gross_profit       REAL  line_net - (unit_cost_at_sale * quantity)
--   discount_at_sale   REAL  per-line discount (default 0)

-- Existing columns reused as snapshots:
--   unit_price  -> unit_price_at_sale (selling price at checkout)
--   line_net    -> net_price_at_sale
--   line_tax    -> tax_at_sale

CREATE INDEX IF NOT EXISTS idx_tx_items_prod_price
  ON transaction_items(product_id, unit_price);
