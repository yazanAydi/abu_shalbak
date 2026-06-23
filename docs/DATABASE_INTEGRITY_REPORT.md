# Database Integrity Report — "أبو شلبك" POS

## Engine

SQLite 3, WAL mode, `PRAGMA foreign_keys = ON`. Single-file database; official path set via `DATABASE_PATH` (required in production).

## Schema authority

- **Only** `backend/database/init.js` applies migrations at startup.
- Legacy `.sql` files archived in `backend/database/migrations/archive/` (not executed).
- Applied version tracked in `schema_migrations` table (`2026.06-init-authoritative`).

## Key integrity rules

| Domain | Rule | Enforcement |
|---|---|---|
| Stock | Atomic delta via ledger | `UPDATE products SET stock = stock + ?` inside transaction |
| Negative stock | Allowed | No CHECK constraint; warning only in UI |
| Sale profit | Immutable snapshot | `transaction_items.unit_cost_at_sale`, `gross_profit` |
| Checkout dedupe | One sale per idempotency key | Unique index on `transactions.idempotency_key` |
| Refund decision | Single terminal state | `BEGIN IMMEDIATE` + status guard on `refund_requests` |
| daily_reports | Non-authoritative | No writes; reports from transactions/refunds |

## Inventory tables

| Table | Role |
|---|---|
| `inventory_ledger` | **Source of truth** — append-only, qty_before/after, reference_id |
| `inventory_movements` | Secondary analytics log; does not mutate stock alone |
| `products.stock` | Live cache updated only through ledger |

## Test DB isolation

`backend/tests/helpers.js` creates temp DB per suite — no pollution of production file.

## Migrations added in fix phase

- `transactions.idempotency_key` + unique partial index
- `products.is_active INTEGER NOT NULL DEFAULT 1`
- `refund_requests.decision_source`, `cashier_notified_at`, `cashier_acknowledged_at`
- `schema_migrations` tracking table

## Remaining integrity notes

- Money as `REAL` — see `MONEY_PRECISION_REPORT.md`
- Palestine timezone day boundaries in reports use `date(created_at)` (server local time) — verify server TZ for your store
