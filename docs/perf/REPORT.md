# Performance optimization report

Generated 2026-08-30. Measurements use `backend/scripts/seed-perf-db.mjs` and
`backend/scripts/bench.mjs` against a freshly seeded 25,000-product /
60,000-transaction `backend/data/perf.db` (node-sqlite3; this machine has no
`better-sqlite3` prebuild).

```
cd backend
node scripts/seed-perf-db.mjs --products 25000 --transactions 60000
node scripts/explain-plans.mjs
node scripts/bench.mjs --label after --out ../docs/perf/after.json
```

The development catalogue is ~800 KB and cannot show store-scale bottlenecks.
The harness default is 25k products (configurable to 50k/100k).

A pre-change HTTP baseline was not recorded on the old tree (work landed in
this same session). Query-plan before/after is captured below: CAST sort vs
padded `sku` sort. Post-change timings are in
[after.json](after.json) and the table in Phase 8.

## What was slow (root causes)

1. **Add-product UI** called `GET /next-sku` (full SKU table scan) then
   `load()` which showed a skeleton, refetched page 1, discarded loaded pages,
   and ignored the POST response body.
2. **List sort** used `ORDER BY CAST(sku AS INTEGER)` so SQLite could not use
   an index.
3. **Missing indexes** on `products.name`, `products.category`, POS
   `(is_active, inventory_scope)`, purchase-item product_id, and ledger
   `(product_id, movement_type)`.
4. **`date()` / `datetime()` wrappers** on `created_at` prevented range scans
   on finance/refunds summary. Shift business-day matching still uses
   `datetime()` wrappers — ISO vs SQL timestamp string compare is required
   for correct cash attribution (`shiftEdgeCases.test.js`).
5. **Settings + user password gate** hit SQLite on every authenticated request.
6. **Units catalog** issued one query per product (N+1).
7. **Import post-pass** re-read the entire catalogue after every file.
8. **Checkout** validated credit, drawer change, and promo limits outside the
   write transaction (TOCTOU under concurrent cashiers).

## Changes by phase

### Phase 0 — Measurement

- `backend/utils/queryStats.js` — per-request SQL counter (`X-Query-Count` in
  non-production) and `PERF_LOG_SLOW_MS` slow-query log.
- `backend/scripts/seed-perf-db.mjs`, `bench.mjs`, `explain-plans.mjs`.
- `backend/tests/concurrency.perf.test.js`.
- Seed of 25k products + 60k sales completed in **2.3s** (batched inserts).

### Phase 1 — Indexes and query shape

- Startup pass zero-pads numeric SKUs to 11 digits.
- List/search use `ORDER BY sku` / `sku = ?` (indexable).
- New indexes: name (NOCASE), category, sku sort, `(is_active, inventory_scope)`,
  partial `needs_review`, `purchase_invoice_items(product_id)`,
  `inventory_ledger(product_id, movement_type)`,
  `transaction_items(product_id, created_at)`.
- Date filters on finance export and refunds summary are half-open ranges
  (`created_at >= from AND created_at < nextDay`).
- `PRAGMA optimize` at startup.

**EXPLAIN QUERY PLAN** (see [query-plans.md](query-plans.md)):

| Query | Plan |
| --- | --- |
| `ORDER BY CAST(sku AS INTEGER)` (legacy) | `SCAN products` + `USE TEMP B-TREE FOR ORDER BY` |
| `ORDER BY sku` (current) | `SCAN products USING INDEX idx_products_sku_sort` |
| `sku = '00000000042'` | `SEARCH ... COVERING INDEX idx_products_sku_sort (sku=?)` |
| `created_at >= ? AND created_at < ?` | `SEARCH ... idx_transactions_created_at` |
| `date(created_at) = ?` (legacy) | `SCAN transactions` |
| `MAX(sku)` | `SEARCH ... COVERING INDEX idx_products_sku_sort` |
| name / category / needs_review / POS active | covering indexes, no temp sort |

### Phase 2 — Product-module O(n)

- `getNextProductNumber` uses `MAX(sku)` + sequence, not a full scan.
- Create-product barcode checks collapsed to one `UNION` query.
- POST create returns `next_sku` so the form does not wait on another GET.
- Units catalog loads units with one `IN (...)` query.
- Import repairs only touched product IDs and commits in 150-row chunks.
- Bulk delete is one `IN` purge + one `DELETE`, not 4 queries per id.
- `fields=id` is capped at 5,000 rows.

### Phase 3 — Caching

- `backend/utils/cache.js` with explicit invalidation for settings, currencies,
  categories, unit names, promotions (30s TTL), and the per-request user row.
- `ETag` / `Cache-Control` on settings, currencies, categories, unit-names.
- Cache is cleared at `initDatabase()` so tests stay isolated.
- Tests that `UPDATE currencies` via raw SQL must call
  `invalidateCurrencyCache()` (the cache is process-local).

### Phase 4 — Product screen

- Mutations splice the returned row into state (`mergeProductRow`). No
  skeleton flash; search and loaded pages are kept.
- Suggested SKU is taken from `next_sku` (background fetch only as fallback).
- `useMemo` for the filtered list and columns; lazy modals; DataTable
  virtualizes after 80 rows.
- `ProductUnitsSection` no longer closes the edit modal / reloads the catalogue.
- Frontend GET cache invalidation is targeted (settings/currencies/catalogs)
  instead of wiping every write. `AbortController` helper is exported.

### Phase 5 — Concurrency

- Credit limit and drawer-change checks run inside `BEGIN IMMEDIATE`.
- Promo consumption is `UPDATE ... WHERE used_qty + ? <= limit_qty`.
- Checkout no longer writes `product_units` prices during validation.
- Sales invoice numbers use `invoice_sequences`; receipt numbers are allocated
  inside the post transaction.
- `withTransaction` retries `SQLITE_BUSY` with backoff.
- Refund approval adds the in-flight approved refund back when checking
  drawer shekels (the row is inserted as `approved` before stock/cash effects).

### Phase 6 — SQLite driver

- `backend/database/sqliteDriver.js` wraps either `better-sqlite3` (prepared
  statement cache, WAL read connection for GET) or `node-sqlite3`.
- Tuned PRAGMAs: `WAL`, `synchronous=NORMAL`, `busy_timeout=10000`,
  `cache_size=-64000`, `temp_store=MEMORY`.
- `better-sqlite3` is an **optional** dependency. This machine (Node 24, no
  VS Build Tools) has no prebuild; the process falls back to `sqlite3`.
  See [DEPLOY-BETTER-SQLITE3.md](DEPLOY-BETTER-SQLITE3.md).
- Set `SQLITE_DRIVER=sqlite3` to force the previous driver.

### Phase 7 — Network

- Compression was already enabled; SSE sets `x-no-compression`.
- Office side rail reuses `/office/nav-badges` (includes `low_stock_preview`)
  instead of a second low-stock poll.
- POS unread refunds stream over `GET /api/v1/pos/events` (SSE). Polling is
  the fallback at 8s if the stream is down.

## Phase 8 — Measured results (25k products, 60k sales)

Driver: **node-sqlite3** (`SQLITE_DRIVER=sqlite3`). 7 iterations + 2 warmup.
Source: [after.json](after.json).

| Scenario | p50 (ms) | p95 (ms) | p99 (ms) | SQL queries (avg) | HTTP |
| --- | ---: | ---: | ---: | ---: | ---: |
| product_list_page1 | 6.4 | 7.0 | 7.0 | 2 | 200 |
| product_search_name | 20.9 | 21.7 | 21.7 | 1 | 200 |
| product_search_barcode | 17.3 | 17.9 | 17.9 | 4 | 200 |
| next_sku | 1.7 | 2.3 | 2.3 | 2 | 200 |
| product_create | 6.5 | 10.3 | 10.3 | 35 | 201 |
| product_update | 3.0 | 3.7 | 3.7 | 8 | 200 |
| pos_barcode_lookup | 2.4 | 2.9 | 2.9 | 3 | 200 |
| pos_search | 28.4 | 30.2 | 30.2 | 1 | 200 |
| checkout_3_items | 9.2 | 10.3 | 10.3 | 38 | 201 |
| daily_report | 91.2 | 102.5 | 102.5 | 14 | 200 |
| import_200_rows | 549 | 561.5 | 561.5 | 6208 | 200 |

Directional reading vs the old shapes (not a same-machine HTTP baseline):

- **product_list_page1** — 2 queries, indexed `ORDER BY sku` (legacy CAST
  required a full scan + temp sort of 25k rows).
- **next_sku** — 2 queries / 1.7 ms p50 (legacy scanned every SKU in JS).
- **product_create** — 6.5 ms p50; the UI no longer waits on next-sku + full
  list reload after save.
- **checkout_3_items** — 9.2 ms p50 with credit/drawer checks inside the
  write transaction.
- **import_200_rows** — ~0.55 s for 200 new rows. Query count is still high
  (~31 statements/row: unit/barcode writes + scoped repair). Chunked
  transactions keep the write lock from spanning the whole file.

With `better-sqlite3` on Node 20, expect a further drop in per-query
overhead (prepared statements) and GET reads that no longer wait on writers.

## Concurrency tests

`backend/tests/concurrency.perf.test.js` plus the existing
`concurrentStock.test.js` assert:

- N parallel cash sales persist every stock delta and unique receipt numbers
- Parallel product edits do not clobber rows
- Oversell remains allowed (atomic `stock = stock + ?`)

Full backend suite after these phases: **51 files, 374 tests, all passing**
(`SQLITE_DRIVER=sqlite3 npm test -- --forceExit`, ~44 s).

## Deployment runbook

1. Backup the live DB (`createBackup`) before deploying.
2. Deploy the backend. Schema is unchanged (indexes are created at startup).
3. Default driver is `sqlite3` unless `better-sqlite3` compiles. On the store
   PC follow [DEPLOY-BETTER-SQLITE3.md](DEPLOY-BETTER-SQLITE3.md)
   (Node 20 LTS + VS Build Tools, then `npm rebuild better-sqlite3`).
4. Rollback: `SQLITE_DRIVER=sqlite3` and restart. No file-format change.
5. Re-benchmark after deploy:

   ```
   cd backend
   node scripts/seed-perf-db.mjs --products 25000 --transactions 60000
   node scripts/bench.mjs --label store --out ../docs/perf/store.json
   ```
