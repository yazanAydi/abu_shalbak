# PostgreSQL Migration Notes (Future)

This document outlines how to migrate Abo Shalbak from SQLite to PostgreSQL when scaling to multi-branch production.

## Schema readiness (already in SQLite)

- `stores` table with default branch `MAIN` (id=1)
- `store_id` on `transactions`, `cashier_shifts`, `inventory_ledger`, `receipt_sequences`
- `receipt_sequences` per `(store_id, year)` for branch-specific invoice numbers
- Immutable `inventory_ledger` and `audit_logs` append-only tables

## Type mapping

| SQLite | PostgreSQL |
|--------|------------|
| INTEGER PRIMARY KEY AUTOINCREMENT | SERIAL / BIGSERIAL or GENERATED ALWAYS AS IDENTITY |
| REAL | NUMERIC(12,2) for money |
| TEXT datetime | TIMESTAMPTZ |
| INTEGER booleans (0/1) | BOOLEAN |

## Sequences vs receipt numbers

Replace SQLite `ON CONFLICT DO UPDATE` receipt counter with:

```sql
INSERT INTO receipt_sequences (store_id, year, last_seq)
VALUES ($1, $2, 1)
ON CONFLICT (store_id, year)
DO UPDATE SET last_seq = receipt_sequences.last_seq + 1
RETURNING last_seq;
```

Use a single transaction with `SELECT ... FOR UPDATE` on the sequence row for strict serialisation under high concurrency.

## Date functions

| SQLite | PostgreSQL |
|--------|------------|
| `datetime('now')` | `NOW()` |
| `date(created_at)` | `created_at::date` |
| `julianday(...)` | `EXTRACT(EPOCH FROM ...)` or date arithmetic |

## Migration approach

1. Export SQLite schema + data with a tool (e.g. `pgloader`, custom ETL script).
2. Run PostgreSQL DDL with CHECK constraints and foreign keys enabled.
3. Backfill `store_id = 1` where NULL on legacy rows.
4. Verify `inventory_ledger` sums match `products.stock` per product.
5. Point `DATABASE_URL` to PostgreSQL; replace `sqlite3` driver with `pg` pool.
6. Enable connection pooling (PgBouncer) for multi-branch POS load.

## Multi-branch inventory

- Scope `inventory_ledger`, `receipt_sequences`, and `cashier_shifts` by `store_id`.
- Add `store_id` to `products` or use per-store stock table when branches diverge.
- POS login selects active store; JWT payload includes `store_id`.
