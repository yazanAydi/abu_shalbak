# LAN Deployment Checklist — "أبو شلبك" POS

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
