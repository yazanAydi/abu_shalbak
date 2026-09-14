# LAN Deployment Checklist — "أبو شلبك" POS

## Before first sale (clock check)

Sales, shifts, and daily reports use the **server clock**. If the clock is wrong at install, timestamps in the database will be wrong until corrected manually.

- [ ] **Windows date & time** — Settings → Time & language → Date & time:
  - Turn on **Set time automatically**
  - Set timezone to **(UTC+02:00) Ramallah / Palestine** (Windows: same region as `(UTC+02:00) Jerusalem` if Ramallah is not listed)
  - Click **Sync now** under Additional settings
- [ ] Confirm in PowerShell: `Get-Date` and `tzutil /g` show the correct local time
- [ ] **Docker store** (`npm run store:up`): container uses `TZ=Asia/Hebron` (Ramallah) — verify with `docker exec supermarket-pos date`
- [ ] **API health**: open `http://SERVER_IP:3000/api/v1/health` — `serverTime` should match your wall clock (within a few seconds)
- [ ] Sync cashier PC clocks too (POS header clock uses the browser PC time for display only)
- [ ] Only after the above: start the first cashier shift

If sales were already recorded with a wrong clock, stop the store (`npm run store:down`), measure the offset from a known sale, then run `node backend/scripts/shift-timestamps.mjs` (dry run first, then `--yes`). See script header for usage.

## Server PC

- [ ] Install Node.js 18+ LTS
- [ ] Clone/copy project to e.g. `C:\abo_shalbak`
- [ ] Copy `.env.example` → `.env`; set:
  - `DATABASE_PATH=C:\abo_shalbak\data\supermarket.db` (absolute path)
  - `JWT_SECRET=` (long random string)
  - `HOST=0.0.0.0` (listen on LAN)
  - `PORT=5000`
  - `NODE_ENV=production`
  - `ALLOWED_ORIGINS=http://SERVER_IP:5000` (or Tailscale hostname)
- [ ] Optional Telegram: `TELEGRAM_REFUND_BOT_TOKEN`, `TELEGRAM_REFUND_CHAT_ID`, `TELEGRAM_USE_POLLING=1`. Leave `TELEGRAM_MANAGER_USER_IDS` empty to allow any click in the manager chat; set it to a comma-separated list of Telegram user IDs to restrict approvers.
- [ ] Build frontends: `npm run build` in `frontend/` and `frontend-pos/`
- [ ] Start backend: `cd backend && npm start`
- [ ] Confirm log line: `[db] Using database file: C:\...\supermarket.db`
- [ ] Open `http://SERVER_IP:5000/admin` and `http://SERVER_IP:5000/pos`
- [ ] Change default admin password on first login

## Client PCs (cashier / office)

- [ ] Browser bookmark: `http://SERVER_IP:5000/pos` (cashier) or `/admin` (office)
- [ ] No separate API URL needed in production (same origin)
- [ ] For dev builds: set `REACT_APP_API_BASE=http://SERVER_IP:5000` in frontend `.env`
- [ ] After a POS rebuild: hard-reload (`Ctrl+F5`) so cashiers pick up the new F9 complete-sale shortcut (F12 is Edge DevTools — do not bind it)
- [ ] Recreate Edge `--app` shortcuts if cashiers still use a Chrome/PWA/.url shortcut (`.\scripts\open-pos-app.ps1 -Inspect`)
- [ ] One-time if DevTools is already open: close the console, then fully quit Edge (not just the tab) so it does not restore the docked tools on the next launch

## Receipt printer (cashier-PC helper)

After ترحيل / F9 the sale is saved first. POS loads `POST /api/v1/print-receipt` then sends HTML to **`http://127.0.0.1:17892`** on that cashier PC. A print problem never rolls back the sale. Reprint with **طباعة الإيصال**. Helper `ok` is not proof that paper printed.

Full steps: `docs/CASHIER_RECEIPT_PRINT_HELPER.md`. `store:up` on the server does **not** start the till helper.

- [ ] Each cashier PC: copy `dist/cashier-print/AboShalbak-ReceiptPrint` and double-click **Install.bat** (see `docs/CASHIER_RECEIPT_PRINT_HELPER.md`)
- [ ] Installer: pick the RONGTA, enter `http://STORE_LAN_IP:3000/pos`
- [ ] Health: `Invoke-RestMethod http://127.0.0.1:17892/health`
- [ ] Desktop shortcut is Edge `--app` to `http://STORE_LAN_IP:3000/pos`
- [ ] Thermal USB printer installed on **that** PC under the name in `.env.cashier-print`
- [ ] If printing fails, reprint with **طباعة الإيصال** — do not create a second sale

`RECEIPT_WIDTH_MM` (default 80, or 58) still controls receipt HTML width. It is not a per-printer setting.

## Barcode scanners (office)

If scanning on admin/accountant pages opens DevTools, the scanner suffix is likely F12 (or Ctrl+Shift+I). JavaScript cannot reliably block that. Configure the scanner terminator to Enter — `docs/BARCODE_SCANNER.md`. Use `AboShalbak-Admin.lnk` (Edge `--app`) for both roles.

## Network

- [ ] Windows Firewall: allow inbound TCP on port 5000 from LAN subnet
- [ ] Optional: Tailscale — see `DEPLOY-TAILSCALE.md`
- [ ] Server PC should have static LAN IP or DHCP reservation

## Operations

- [ ] Nightly backup cron enabled (default 02:00 unless `DISABLE_AUTO_BACKUP=1`) — uses `VACUUM INTO`, not a live-file copy
- [ ] Manual backup: admin `POST /api/v1/admin/backup`; verify as in `RESTORE.md`
- [ ] Test restore from backup (`RESTORE.md`)
- [ ] Document official DB path for all staff — only one file is authoritative
- [ ] Do not `cp` / `Copy-Item` the live `supermarket.db` while the store is running

## Post-deploy smoke test

1. Admin login → product list loads
2. Cashier login → start shift → scan barcode → complete sale → receipt prints from the cashier Edge shortcut (Windows default thermal printer; a brief preview flash can still occur)
3. Admin → reports today matches sale total
4. Refund request → approve in admin → cashier sees notification
