# أبو شلبك (Abu Shalbak) — Agent Context

Arabic RTL supermarket + bakery POS/ERP. Modern replacement for Hesabati (حساباتي), deployed on the shop LAN. Currency is primarily ₪ (NIS). Shop timezone: `Asia/Hebron`.

This file is the project map for Cursor. Follow it on every change.

## What this system is

One Node/Express API + SQLite serves two React (CRA) apps:

| App | Path | Dev | Production |
|-----|------|-----|------------|
| API | `backend/` | `:5001` | Docker `:3000` |
| Office admin | `frontend/` → `/admin` | `:3001` | `http://LAN:3000/admin` |
| Cashier POS | `frontend-pos/` → `/pos` | `:3002` | `http://LAN:3000/pos` |

Production: one Docker container serves API + static builds copied to `backend/public/admin` and `backend/public/pos`. Cashiers/office use a browser only.

**Never mix environments.** Dev uses `.env.development` + `supermarket-dev.db` on port **5001**. Live shop uses `.env.store` + Docker on port **3000**. Do not put store Telegram tokens in the development env.

## Repo layout

```
backend/                 Express ESM API, SQLite, Jest
  server.js             Boot: env → DB → createApp → cron/Telegram
  app.js                Express factory, CORS, JWT, /api + /api/v1
  database/init.js      Schema authority (idempotent). Archive SQL is NOT run.
  routes/               One router per domain
  services/             Checkout, refunds, invoices, Telegram, print, attendance
  utils/                money, tax, cogs, barcode, inventoryLedger, dbTx, …
frontend/               Office UI (Craco) — products, finance, reports, approvals
frontend-pos/           Cashier UI — checkout, shifts, refunds, print
docs/                   Architecture, money, security, load tests, LAN deploy
scripts/                Dev setup, store start/stop, Edge POS/office shortcuts
```

## Start / verify

```powershell
# Dev (from repo root — never start frontend/ or backend/ alone)
npm start
npm run verify:dev

# Live shop (shop server PC only)
npm run store:up
```

Default logins (change immediately on a live shop): `admin` / `admin123`, `cashier1` / `cashier123`.

## Roles

| Role | Portal | Notes |
|------|--------|-------|
| `admin` | Office | Full access |
| `accountant` | Office | Granular keys in `users.permissions_json` / `app_settings.accountant_permissions` |
| `cashier` | POS only | Checkout + shifts |
| `shelves_employee`, `bakery_employee` | Face kiosk | Attendance/payroll; no password login (`isKioskOnlyRole`) |

POS checkout capability (`canRunCheckout`) includes admin + shop-floor roles, but **POS login is cashier only**. Office login is admin/accountant only.

## Core sale path

```
POS scan → checkoutCartReducer → POST /api/v1/checkout
  → JWT + requirePosAccess
  → withTransaction (BEGIN IMMEDIATE)
  → executeCheckoutSale (services/checkoutSaleService.js)
  → transactions + transaction_items + sale_payments
  → inventory_ledger (sale) + products.stock cache
  → shift_cash_movements
  → POS loads saved receipt HTML and prints in the cashier Edge window
```

Refunds, on-account (ذمة), and advances (سلف) are **request → manager approve** (office UI and/or Telegram). Stock/cash do not move until approval.

Office **sales invoices** (`routes/sales.js`, `/sales-invoices`) are a separate draft/post path — not POS checkout.

## Hard invariants (do not break)

1. **Money:** use `round2` / `sumMoney` from `backend/utils/money.js`. Weighed KG lines use `roundScaleSaleTotal`. Never accumulate raw floats.
2. **POS tax is 0.** Shelf price is gross (`computeSaleTotals` in `utils/tax.js`). VAT exists on **purchase** invoices only.
3. **`inventory_ledger` is stock source of truth.** `products.stock` is a cache updated atomically. Negative stock is allowed.
4. **Historical profit** uses `transaction_items.unit_cost_at_sale` / `gross_profit` snapshots — never live `products.cost`.
5. **Completed sales are immutable.** No PUT/DELETE on transactions; refunds only. Checkout uses `idempotency_key`.
6. **SKU ≠ barcode.** `products.sku` is internal; scannable codes live on `products.barcode` / `product_barcodes`.
7. **Schema changes go in `database/init.js` only.** Files under `migrations/archive/` are historical and never executed.
8. **Writes that touch money/stock** use `withTransaction` from `utils/dbTx.js`.
9. **Operational store is id `1`.** `stores` + `store_id` exist; checkout hardcodes store 1. Multi-store is not a product feature yet.
10. **API:** prefer `/api/v1` envelope `{ success, data, meta.requestId }`. Frontends rewrite `/api` → `/api/v1`.

## Domain glossary

| Term | Meaning |
|------|---------|
| ذمة / zimma | Customer on-account (credit) sale |
| سلف / sulaf | Employee cash advance from the drawer |
| Hesabati | Legacy Excel system; imports in `utils/importDetect.js` + `hesabatiUploadHandlers.js` |
| Weight barcode | EAN-13 prefix `21`: product code + grams (`utils/barcode.js`) |
| Business day | Configurable cutoff, not always midnight (`utils/shopTime.js`, `businessDay.js`) |
| Bakery supplies | Separate catalog scope from front-store SKUs (`/bakery-supplies`) |

## Where to edit (by task)

| Task | Start here |
|------|------------|
| POS cart / scan / pay | `frontend-pos/src/pages/Checkout.jsx`, `utils/checkoutCartReducer.js`, `routes/checkout.js`, `services/checkoutSaleService.js` |
| Receipt / browser print | `utils/receipt.js`, `routes/print.js`, `frontend-pos/src/utils/printReceipt.js`, `docs/RECEIPT_BROWSER_PRINT.md` |
| Products / barcodes / units | `routes/products.js`, `utils/productUnits.js`, `utils/barcode.js`, `frontend/src/pages/ProductDashboard.jsx` |
| Refunds / Telegram approve | `services/refundRequestService.js`, `routes/refundRequests.js`, `services/telegramUpdateService.js` |
| Shifts / cash drawer | `routes/shifts.js`, `utils/salePayments.js` |
| Inventory docs | `services/inventoryDocumentService.js`, `utils/inventoryLedger.js` |
| Office nav / ACL | `frontend/src/components/layout/officeNavConfig.js`, `utils/accountantPermissions.js` |
| Settings / branding | `routes/settings.js`, `utils/settings.js`, both `storeBranding.js` files |
| Face kiosk | `frontend/src/pages/AttendanceKiosk.jsx`, `routes/attendance.js` |
| Schema | `backend/database/init.js` only |

## Frontend conventions

- Arabic RTL (`dir="rtl" lang="ar"`), Cairo font, **Western digits** (`forceLatinDigits.js`).
- Admin uses Craco + same-origin proxy (`setupProxy.js` → `:5001`). Do not set `REACT_APP_API_BASE` in `frontend/.env`.
- POS talks to `REACT_APP_API_BASE=http://127.0.0.1:5001` in dev (no proxy).
- Shared `components/ui/*` is **duplicated** across the two apps, not a package.
- Auth: `localStorage` `token` + `user`; login body includes `app: "office" | "pos"`.
- UI copy is Arabic. User-facing `HttpError` messages are Arabic.

## Testing

```powershell
cd backend
npm test                 # Jest, runInBand, ESM
npm run test:concurrency # tests/load invariants
```

Invariants live in `backend/tests/load/invariants.js`. Touching checkout, refunds, inventory, money, or shifts requires updating or adding tests.

## Docs to read first (deeper than this file)

- `README.md` — install, Docker, roles, Hesabati import
- `docs/DEV_VS_STORE.md` — env isolation (critical)
- `docs/SYSTEM_ARCHITECTURE_MAP.md` — module → tables map
- `docs/MONEY_PRECISION_REPORT.md` — why REAL + `round2`
- `REFUNDS_GUIDE.md`, `docs/EXPIRATION_PROCESS.md`, `docs/LAN_DEPLOYMENT_CHECKLIST.md`
