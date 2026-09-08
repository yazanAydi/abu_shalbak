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
- [ ] After a POS rebuild: hard-reload (`Ctrl+F5`) so cashiers pick up the new F9 complete-sale shortcut (F12 is Edge DevTools)
- [ ] One-time if DevTools is already open: close the console, then fully quit Edge (not just the tab) so it does not restore the docked tools on the next launch
- [ ] Recommended on cashier machines only — block DevTools in Edge so F12 cannot open the console. In an elevated PowerShell:

```powershell
$policyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
if (-not (Test-Path $policyPath)) { New-Item -Path $policyPath -Force | Out-Null }
# 2 = Developer tools are not allowed. Do NOT set this on the development PC.
Set-ItemProperty -Path $policyPath -Name "DeveloperToolsAvailability" -Type DWord -Value 2
```

  Restart Edge after setting the policy. Development machines stay unchanged so you can still open DevTools manually while coding.

## Receipt printer (silent print)

After ترحيل the POS calls `POST /api/v1/print-receipt/silent`. There is **no** Edge print preview.

On **Docker store** (`npm run store:up` / `scripts/start-store.ps1`), a Windows print agent on the shop PC (`http://127.0.0.1:17891`) receives the receipt from the Linux container and sends it to the thermal printer. On **native Windows API** (`npm start` / `production:start`) the API prints directly.

If the agent is not running, the sale still saves and the POS shows an Arabic alert (no browser dialog). Reprint with **طباعة الإيصال**. Do not use `scripts/open-pos-silent-print.ps1`.

- [ ] Install **Node.js LTS** on the shop Windows PC (needed for the print agent next to Docker)
- [ ] Install the thermal / receipt printer driver on that same PC
- [ ] Settings → Bluetooth & devices → Printers & scanners → set that printer as **Default**
- [ ] Confirm it is not Print to PDF, XPS, OneNote, or Fax
- [ ] Optional: set `RECEIPT_PRINTER=Exact Printer Name` in `.env.store`
- [ ] Start with `npm run store:up` so Docker **and** the print agent run
- [ ] Confirm `http://127.0.0.1:17891/health` returns `ok`
- [ ] Complete a test sale — paper should come out with **no** print preview
- [ ] If printing fails, reprint with **طباعة الإيصال** — do not create a second sale

If the default printer is still Print to PDF, the sale succeeds and an Arabic alert explains the printer problem. Edge preview does not appear.

To test the **same HTML→PDF** path without a thermal printer, set `RECEIPT_PRINT_TEST_MODE=save` in `.env.development` (native `npm run dev`) or `.env.store` (Docker + print agent), then restart. ترحيل writes `tmp/receipt-test/*.pdf` and returns `widthMm` / `heightMm` from that file. The page height is the rendered content plus `RECEIPT_BOTTOM_MARGIN_MM` (default 5). Leave test mode unset in production.

## Network

- [ ] Windows Firewall: allow inbound TCP on port 5000 from LAN subnet
- [ ] Optional: Tailscale — see `DEPLOY-TAILSCALE.md`
- [ ] Server PC should have static LAN IP or DHCP reservation

## Operations

- [ ] Nightly backup cron enabled (default 02:00 unless `DISABLE_AUTO_BACKUP=1`)
- [ ] Test restore from backup (`RESTORE.md`)
- [ ] Document official DB path for all staff — only one file is authoritative
- [ ] Do not copy stray `.db` files without understanding which is live

## Post-deploy smoke test

1. Admin login → product list loads
2. Cashier login → start shift → scan barcode → complete sale → receipt prints with no preview (Windows API + default receipt printer)
3. Admin → reports today matches sale total
4. Refund request → approve in admin → cashier sees notification
