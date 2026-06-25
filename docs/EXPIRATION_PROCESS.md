# Expiration Process — How It Works

## Summary

In this codebase, **expiration is a monitoring and alerting system**, not an automatic disposal pipeline. The system:

- Stores `expiry_date` on products (and optionally on `product_batches`)
- Computes **days until expiry** with SQLite `julianday()`
- Shows **expiry reports** in the office and POS UIs
- Sends **daily Telegram alerts** for items nearing expiry (plus manual send from store settings)
- Allows **manual stock write-off** via inventory adjustment type `damage` → ledger type `expiry_writeoff`

It does **not** automatically remove expired stock, block checkout for expired products, or deduct `product_batches` on sale.

---

## 1. Data Model

Two places hold expiry information:

| Layer | Table / field | Purpose |
|-------|---------------|---------|
| Product-level | `products.expiry_date` | Single expiry date per SKU (YYYY-MM-DD) |
| Batch-level | `product_batches` | Optional lots with their own `expiry_date`, `quantity`, `batch_no` |

```mermaid
flowchart TB
  subgraph storage [Data Storage]
    Products["products\nexpiry_date, stock"]
    Batches["product_batches\nexpiry_date, quantity, batch_no"]
    Settings["app_settings\nexpiry_alert_days default 7"]
  end

  AlertService["expiryAlertService.js"]

  Products -->|"1:N optional"| Batches
  Settings -->|"threshold for alerts"| AlertService
```

**Key files:**

- Schema: `backend/database/init.js` — `expiry_date` column on `products`, `product_batches` table
- Product CRUD: `backend/routes/products.js` — set/update `expiry_date` on create/edit
- Batch CRUD: `backend/routes/inventory.js` — `GET/POST/DELETE /api/inventory/batches`

---

## 2. Expiry Query Logic (shared everywhere)

All expiry queries use the same SQLite pattern:

```sql
CAST(julianday(expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
```

**Inclusion rule for alerts** (`fetchNearExpiryItems` in `backend/services/expiryAlertService.js`):

- `expiry_date` is set and non-empty
- `stock > 0` (products) or `quantity > 0` (batches)
- Expires within **N days** (including already expired: `days_until_expiry` can be negative)

**Reports** (`GET /api/inventory/expiry` in `backend/routes/inventory.js`) use the same date window but only query `products` (not batches). Default window: 30 days (UI-configurable).

**Label formatting** (`formatDaysLabel` in `backend/utils/telegram.js`):

- Negative days → `منتهي (X يوم)` (already expired)
- Zero → `ينتهي اليوم`
- Positive → `X يوم`

---

## 3. Telegram Alert Flow (main “expiration process”)

This is the only **automated** expiration workflow.

```mermaid
flowchart TD
  subgraph triggers [Triggers]
    Cron["node-cron daily\nTELEGRAM_EXPIRY_ALERT_HOUR default 8"]
    Manual["Admin button or\nPOST /api/telegram/send-expiry-alert"]
  end

  subgraph server [Backend]
    ServerStart["server.js startup"]
    SendAlert["sendExpiryAlert()"]
    ConfigCheck{"Telegram configured?\nTELEGRAM_EXPIRY_BOT_TOKEN\n+ TELEGRAM_EXPIRY_CHAT_ID"}
    LoadDays["Read threshold:\nstore expiry_alert_days\n→ fallback TELEGRAM_EXPIRY_DAYS\n→ default 7"]
    Fetch["fetchNearExpiryItems(db, days)\nproducts + product_batches"]
    EmptyCheck{"Any items?"}
    BuildMsg["buildExpiryAlertMessages()\nArabic summary, chunk to 4096 chars"]
    SendTG["sendExpiryAlertMessages()\nTelegram sendMessage API"]
  end

  subgraph output [Output]
    ExpiryGroup["Telegram expiry group"]
    Log["Console log if sent"]
    NoOp["Silent skip:\nno_items / not_configured"]
  end

  ServerStart --> Cron
  Cron --> SendAlert
  Manual --> SendAlert
  SendAlert --> ConfigCheck
  ConfigCheck -->|no| NoOp
  ConfigCheck -->|yes| LoadDays
  LoadDays --> Fetch
  Fetch --> EmptyCheck
  EmptyCheck -->|no| NoOp
  EmptyCheck -->|yes| BuildMsg
  BuildMsg --> SendTG
  SendTG --> ExpiryGroup
  SendTG --> Log
```

**Configuration chain:**

1. **Disable entirely:** `DISABLE_EXPIRY_TELEGRAM_ALERT=1` in `.env.example`
2. **Alert hour:** `TELEGRAM_EXPIRY_ALERT_HOUR` (0–23, default 8) — scheduled in `backend/server.js`
3. **Days threshold:** `expiry_alert_days` in store settings (`frontend/src/pages/StoreSettings.jsx`) → persisted via `backend/utils/settings.js` → env fallback `TELEGRAM_EXPIRY_DAYS=7`
4. **Telegram bot:** separate expiry bot (`TELEGRAM_EXPIRY_BOT_TOKEN`, `TELEGRAM_EXPIRY_CHAT_ID`) — send-only, no approve/reject buttons

**Core service:** `backend/services/expiryAlertService.js`  
**Message builder/sender:** `backend/utils/telegram.js`  
**Manual API:** `backend/routes/telegram.js` — admin-only `POST /api/telegram/send-expiry-alert`

For Telegram setup steps, see also `REFUNDS_GUIDE.md` (expiry bot section).

---

## 4. Reporting Flow (UI)

```mermaid
sequenceDiagram
  participant User as Office_or_POS_User
  participant UI as ExpiryReports.jsx
  participant API as GET_api_inventory_expiry
  participant DB as SQLite

  User->>UI: Open expiry report, set days window
  UI->>API: GET /api/inventory/expiry?days=N
  API->>DB: Query products with julianday filter
  DB-->>API: rows + days_until_expiry
  API-->>UI: JSON array
  UI->>User: Table with styling\nexpired red, expiring-soon highlight
```

**UI locations:**

- Office: `frontend/src/pages/ExpiryReports.jsx`
- POS: `frontend-pos/src/pages/ExpiryReports.jsx`

**Product dashboard** also shows expiry on a single product: `GET /api/products/:id/overview` in `backend/routes/products.js` returns `expiry.expiry_date` and `days_until_expiry`.

---

## 5. Manual Expired Stock Handling

When staff physically disposes of expired goods, they use **inventory adjustment type `damage`**:

```mermaid
flowchart LR
  Admin["Admin posts\nstock adjustment type damage"]
  Move["recordMovement()\nmovement_type damage"]
  Ledger["inventory_ledger\nexpiry_writeoff"]
  Stock["products.stock reduced"]

  Admin --> Move --> Ledger --> Stock
```

Mapping in `backend/utils/inventory.js`: `damage` → ledger type `expiry_writeoff`.  
There is **no cron or automatic job** that creates these write-offs when `expiry_date` passes.

---

## 6. What Is NOT Part of Expiration

| Expected behavior | Status in codebase |
|-------------------|-------------------|
| Auto write-off at midnight when expired | Not implemented |
| Block POS sale of expired product | Not implemented |
| Deduct `product_batches` on checkout (FEFO) | Not implemented — batches are alert/report only |
| Expiry bot interactive commands | Not implemented — alerts are outbound only |

---

## 7. End-to-End Lifecycle (conceptual)

```mermaid
stateDiagram-v2
  [*] --> DataEntry: Set expiry_date on product or batch
  DataEntry --> InStock: stock greater than 0
  InStock --> NearExpiry: days_until_expiry less than threshold
  NearExpiry --> AlertSent: Daily cron or manual Telegram send
  NearExpiry --> VisibleInReport: ExpiryReports page
  InStock --> Expired: expiry_date before today
  Expired --> VisibleInReport: Shown as منتهي
  Expired --> ManualWriteOff: Admin damage adjustment
  ManualWriteOff --> OutOfStock: stock zero
  AlertSent --> InStock: Alert only, no stock change
```

---

## Key Takeaway

The **expiration process** = **track dates → query with `julianday` → report in UI → notify via Telegram → optionally manual write-off**. Alerts inform staff; they do not change inventory. Operational response (discount, remove from shelf, write off) is manual outside the automated alert loop.
