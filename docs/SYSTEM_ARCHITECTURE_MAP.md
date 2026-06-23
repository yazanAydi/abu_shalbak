# System Architecture Map — "أبو شلبك" POS

## Overview

Monorepo supermarket management system for LAN deployment. One Node.js/Express backend serves JSON API and (in production) static builds of two React frontends.

| Layer | Technology | Path |
|---|---|---|
| Backend API | Node.js 18+, Express 4, SQLite (WAL) | `backend/` |
| Office admin UI | React (CRA) | `frontend/` → `/admin` |
| Cashier POS UI | React (CRA) | `frontend-pos/` → `/pos` |
| Database | SQLite file, schema via `init.js` | `DATABASE_PATH` / `data/supermarket.db` |

## Request flow

```
[POS browser] ──POST /api/v1/checkout──► [Express]
[Office browser] ──GET /api/v1/reports──►     │
                                              ▼
                                    [auth.js JWT + roles]
                                              ▼
                                    [route handler]
                                              ▼
                              [BEGIN IMMEDIATE transaction when needed]
                                              ▼
                                    [SQLite via node-sqlite3]
```

## Module map

| Module | Backend routes | Frontends | Key tables |
|---|---|---|---|
| Auth | `routes/auth.js` | Login (both) | `users` |
| Products | `routes/products.js` | ProductManagement, POS barcode | `products`, `product_price_history` |
| Checkout / sales | `routes/checkout.js` | Checkout (POS) | `transactions`, `transaction_items`, `inventory_ledger` |
| Refunds | `routes/refundRequests.js`, `services/refundRequestService.js` | RefundApprovals, PosRefundModal | `refund_requests`, `refunds` |
| Shifts / cash | `routes/shifts.js` | ShiftStart/End | `cashier_shifts`, `shift_cash_movements` |
| Inventory | `routes/inventory.js` | Inventory, InventoryCount | `inventory_ledger`, `inventory_movements` |
| Reports | `routes/reports.js`, `routes/finance.js` | DailyReport, dashboards | source: `transactions`, `transaction_items` |
| Telegram | `routes/telegram.js`, `services/telegramUpdateService.js` | — | `refund_requests` |
| Settings | `routes/settings.js` | StoreSettings | `app_settings` |

## Stock & money authority

- **Stock source of truth:** `inventory_ledger` (+ live cache `products.stock`). Negative stock is allowed.
- **Historical profit:** `transaction_items.unit_cost_at_sale` / `gross_profit` snapshots — not live `products.cost`.
- **Checkout idempotency:** `transactions.idempotency_key` unique partial index.
- **Schema migrations:** `backend/database/init.js` only (SQL files in `migrations/archive/` are historical).

## Deployment topology (LAN)

```
┌─────────────────┐     HTTP :5000      ┌──────────────────────────┐
│  Cashier PC(s)  │ ◄──────────────────►│  Server PC               │
│  /pos           │                     │  Node backend + SQLite   │
└─────────────────┘                     │  serves /admin + /pos    │
┌─────────────────┐                     └──────────────────────────┘
│  Office PC(s)   │ ◄──────────────────────────┘
│  /admin         │
└─────────────────┘
```

See `LAN_DEPLOYMENT_CHECKLIST.md` for setup steps.
