# Integration Audit Report — "أبو شلبك" POS

## Executive summary

End-to-end integration audit completed across 18 modules. Fix phase implemented in 5 batches. **Negative stock is an approved business rule** — overselling is allowed; concurrency correctness is still required.

## Confirmed critical issues (fixed)

| ID | Issue | Fix | Tests |
|---|---|---|---|
| C-profit | Historical profit used live `products.cost` | COGS/profit from `transaction_items` snapshots | `profitSnapshot.test.js` |
| C-idem | Duplicate checkout submissions | `idempotency_key` + server dedupe + POS UUID | `checkoutIdempotency.test.js` |
| C-concur | Concurrent stock updates on shared SQLite connection | `withTransaction` serialized queue + atomic `UPDATE stock = stock + ?` | `concurrentStock.test.js` |

## High issues (fixed)

| Issue | Fix |
|---|---|
| `daily_reports` write-only dead table | Writes removed; reports compute from source tables |
| Duplicate inventory logs unclear | `inventory_ledger` designated source of truth; documented |
| Unused SQL migrations | Archived under `migrations/archive/`; `init.js` authoritative |
| Ambiguous DB path | `DATABASE_PATH` required in production; absolute path logged |
| Refund admin ↔ Telegram desync | `decision_source`, polling, history tabs, cashier notifications |
| xlsx import attack surface | Row caps, proto guard, multer limits, no formula eval |
| No product deactivation | `products.is_active` + admin toggle + POS hide + checkout 409 |

## Business rules (explicit)

1. **Negative stock allowed** — no blocking at checkout, no `CHECK(stock>=0)`, POS shows non-blocking warning only.
2. **Telegram authorization unchanged** — chat-level approval only (Stage 11 dropped per owner request).
3. **Inactive products** — hidden from POS, rejected at checkout with `PRODUCT_INACTIVE` (409), never hard-deleted.
4. **Historical profit immutable** — cost changes do not rewrite old sale profit.

## Modules verified

Auth, products, checkout, refunds, shifts, inventory, reports, finance, purchases, suppliers, customers, vouchers, marketing, deliveries, warehouses, Telegram, print, settings — data flows traced UI → API → service → DB → reports.

## Not changed (by design)

- Money stored as SQLite `REAL` (assessment in `MONEY_PRECISION_REPORT.md`; integer migration deferred).
- Telegram per-user approver list (dropped).
- Physical hardware (scanner/printer) — manual acceptance required.
