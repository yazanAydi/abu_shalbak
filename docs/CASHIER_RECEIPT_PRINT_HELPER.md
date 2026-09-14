# Cashier-PC receipt print helper

POS checkout prints on the **cashier PC**, not on the Docker server. The USB RONGTA is attached to the till. `npm run store:up` on the server does **not** start this helper.

After a saved sale, the Edge POS app loads receipt HTML from the API (`POST /api/print-receipt`) and sends it to `http://127.0.0.1:17892/print` on that till. A helper accept is not proof that paper came out. An offline printer may still queue a job.

## Easiest install (cashier PC)

On a build PC with this repo: `npm run package:cashier-print`

Copy `dist/cashier-print/AboShalbak-ReceiptPrint` (or the `.zip`) to the till. Double-click **Install.bat**.

1. Choose the RONGTA from the Windows printer list.
2. Enter the POS URL, e.g. `http://192.168.1.10:3000/pos` (origin is derived).
3. Finish starts the helper and shows health. That is **not** proof that paper printed.

On a development PC with no receipt printer, leave the printer list empty and check **اختبار بدون طابعة — حفظ PDF**. That writes `RECEIPT_PRINT_TEST_MODE=save`, starts the helper without a Windows printer, and saves the real receipt PDF under `tmp/receipt-test/` (shown on the success screen). Uncheck the option and pick a real printer to leave test-save.

Updates: run Install.bat from a new package. Printer/URL are kept unless you change them. The installer replaces only this helper and checks `health.version`.

Do not copy `.env.store` or Telegram/JWT secrets onto the till. Microsoft Edge must be installed (PDF render).

## What the package contains

Bundled Node, `dotenv`, `pdf-to-printer`, and the helper JS only. No database, Docker, API, or store secrets. Test-save stays off unless the installer checkbox is checked.

## Configuration

File: **`.env.cashier-print`** in the repo root on the cashier PC (copy from `.env.cashier-print.example`).

| Variable | Meaning |
|---|---|
| `RECEIPT_PRINTER` | Exact Windows printer name, e.g. `RONGTA 80mm Series Printer` |
| `RECEIPT_PRINT_ALLOWED_ORIGINS` | POS origin only: `http://STORE_LAN_IP:3000` (no `/pos` path). Edge `--app=http://STORE_LAN_IP:3000/pos` sends that Origin. |
| `RECEIPT_WIDTH_MM` | Thermal HTML width (default 80). |
| `RECEIPT_PRINT_TEST_MODE` | Leave **unset** for paper. The installer checkbox writes `save`, which generates the real receipt PDF under `tmp/receipt-test/` and does not submit a Windows print job. Re-run Install with the box unchecked to strip it. |

Health (no Origin needed): `Invoke-RestMethod http://127.0.0.1:17892/health`

The helper binds **127.0.0.1 only**. Other websites cannot reach it from the LAN. `POST /print` also requires an Origin on the allow-list.

Manual/dev install (repo + system Node) is still documented below if you are not using the USB package.

```powershell
Copy-Item .env.cashier-print.example .env.cashier-print
# Edit RECEIPT_PRINTER and RECEIPT_PRINT_ALLOWED_ORIGINS
npm install --prefix backend
.\scripts\install-receipt-print-dialog-helper-startup.ps1
.\scripts\start-receipt-print-dialog-helper.ps1
Invoke-RestMethod http://127.0.0.1:17892/health
```

The USB installer registers Scheduled Task `AboShalbakReceiptPrintDialogHelper` at sign-in. Stop: `Stop-Helper.ps1` in the install folder (`%LOCALAPPDATA%\AboShalbak\ReceiptPrint`).

## Server vs till

| Machine | What to run |
|---|---|
| Store Windows server | Docker API `:3000` via `npm run store:up`. Serves `/admin` and `/pos`. Does not print on the RONGTA. |
| Cashier PC | Helper on `:17892` as above. Edge `--app` shortcut to `http://STORE_LAN_IP:3000/pos`. |

## POS frontend rebuild

Changing [`frontend-pos/src/utils/windowsReceiptPrint.js`](../frontend-pos/src/utils/windowsReceiptPrint.js), [`printReceipt.js`](../frontend-pos/src/utils/printReceipt.js), or Checkout print warnings requires a **server** POS rebuild so cashiers receive the new JS:

```powershell
# on the store server
npm run store:down
npm run store:build
```

Then on each till: Ctrl+F5 in the POS Edge app.

Helper-only changes (`.env.cashier-print`, `receipt-print-dialog-helper.mjs`) do **not** need a Docker rebuild. Restart the helper on the till.

## Hardware check

Physical printing is unverified until a slip comes out.

1. Reprint an existing saved sale (**طباعة الإيصال**) — one slip, no new sale.
2. F9 on a ready cart opens الدفع; ترحيل / F9 in the modal saves once, then prints via the helper.
3. If print fails: leave the sale; read the yellow warning; do not re-key the cart.
