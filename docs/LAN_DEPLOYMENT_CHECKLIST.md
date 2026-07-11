# LAN Deployment Checklist — "أبو شلبك" POS

## Before first sale (clock check)

Sales, shifts, and daily reports use the **server clock**. If the clock is wrong at install, timestamps in the database will be wrong until corrected manually.

- [ ] **Windows date & time** — Settings → Time & language → Date & time:
  - Turn on **Set time automatically**
  - Set timezone to **(UTC+02:00) Jerusalem** (or your Palestine region)
  - Click **Sync now** under Additional settings
- [ ] Confirm in PowerShell: `Get-Date` and `tzutil /g` show the correct local time
- [ ] **Docker store** (`npm run store:up`): container uses `TZ=Asia/Jerusalem` — verify with `docker exec supermarket-pos date`
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
- [ ] Optional Telegram: `TELEGRAM_REFUND_BOT_TOKEN`, `TELEGRAM_REFUND_CHAT_ID`, `TELEGRAM_USE_POLLING=1`
- [ ] Build frontends: `npm run build` in `frontend/` and `frontend-pos/`
- [ ] Start backend: `cd backend && npm start`
- [ ] Confirm log line: `[db] Using database file: C:\...\supermarket.db`
- [ ] Open `http://SERVER_IP:5000/admin` and `http://SERVER_IP:5000/pos`
- [ ] Change default admin password on first login

## Client PCs (cashier / office)

- [ ] Browser bookmark: `http://SERVER_IP:5000/pos` (cashier) or `/admin` (office)
- [ ] No separate API URL needed in production (same origin)
- [ ] For dev builds: set `REACT_APP_API_BASE=http://SERVER_IP:5000` in frontend `.env`

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
2. Cashier login → start shift → scan barcode → complete sale → receipt prints
3. Admin → reports today matches sale total
4. Refund request → approve in admin → cashier sees notification
