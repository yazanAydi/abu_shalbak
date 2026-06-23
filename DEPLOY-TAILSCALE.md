# Deploy Admin for Phone Access (Tailscale)

This guide exposes **only the admin panel** (`frontend/build`) over a stable, private HTTPS URL. The POS app is not served remotely.

## Architecture

```
iPhone (Safari + Tailscale app) → https://<pc-name>.tailXXXX.ts.net → localhost:5000 → Express + SQLite
```

- The backend serves the admin UI and API from the same origin (no CORS issues on the phone).
- `tailscale serve` provides HTTPS; the server stays bound to `127.0.0.1` (not exposed on the shop LAN).

---

## 1. Production build on the shop PC

### Install dependencies (first time)

```powershell
cd C:\path\to\abo_shalbak
npm run install:all
```

### Configure `.env` for production

Copy settings from `.env.example` and set at minimum:

```env
NODE_ENV=production
PORT=5000
HOST=127.0.0.1

# REQUIRED — generate a long random string (32+ chars). Never use defaults in production.
JWT_SECRET=your-long-random-secret-here

DATABASE_PATH=./data/supermarket.db

# Optional — your Tailscale HTTPS URL (belt-and-suspenders for CORS)
# ALLOWED_ORIGINS=https://shop-pc.tail1234.ts.net

# Production: use Telegram webhooks instead of polling (omit TELEGRAM_USE_POLLING or set to 0)
TELEGRAM_USE_POLLING=0
```

Generate a JWT secret (PowerShell):

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

### Build and start

```powershell
npm run start:prod
```

This runs `npm run build:admin` then starts the backend. The admin is available at:

```
http://127.0.0.1:5000
```

Leave this terminal window open. Closing it stops the server.

---

## 2. Install Tailscale on the shop PC (Windows)

1. Download from [https://tailscale.com/download/windows](https://tailscale.com/download/windows)
2. Install and sign in (create a free account if needed).
3. Note your PC name in the Tailscale app (e.g. `shop-pc`).

### Enable HTTPS proxy to the admin

In PowerShell **as Administrator** (or from Tailscale admin if prompted):

```powershell
tailscale serve --bg 5000
```

This creates a stable HTTPS URL like:

```
https://shop-pc.tail1234abcd.ts.net
```

To check status:

```powershell
tailscale serve status
```

To stop:

```powershell
tailscale serve reset
```

**Make Tailscale serve persist after reboot:** Tailscale usually re-applies `serve` config if saved. For a permanent setup, add `tailscale serve --bg 5000` to a startup script or Windows Task Scheduler that runs at logon (after the backend is running).

---

## 3. Install Tailscale on the owner's iPhone

1. Install **Tailscale** from the App Store.
2. Sign in with the **same Tailscale account** as the shop PC.
3. Ensure the VPN toggle is **on** in the Tailscale app.

---

## 4. Open admin on the phone

1. Open **Safari** on the iPhone.
2. Go to your Tailscale URL, e.g. `https://shop-pc.tail1234abcd.ts.net`
3. Log in with admin credentials.

### Add to Home Screen (optional)

Safari → Share → **Add to Home Screen**. This creates an app-like icon that opens the admin URL.

---

## 5. Daily operation checklist

| Step | Action |
|------|--------|
| Shop PC | Must stay on and connected to the internet |
| Backend | Run `npm run start:prod` (or use a Windows service / Task Scheduler) |
| Tailscale | PC and iPhone must be logged in; iPhone VPN toggle on |
| Updates | After code changes: stop server → `npm run start:prod` again |

---

## 6. Security notes

- Only devices on your Tailscale network can reach the admin (private, not public internet).
- Always use the `https://` Tailscale URL on the phone, not `http://`.
- Change default seeded passwords after first login.
- Keep `data/` and `backups/` folders off any public web path.
- Set a strong unique `JWT_SECRET` before going live.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Phone can't connect | Check Tailscale is on on both devices; same account |
| Certificate / HTTPS error | Use `tailscale serve --bg 5000`, not raw `http://` |
| "تعذّر الاتصال بالخادم" | Backend not running — start `npm run start:prod` on the PC |
| Server won't start in production | Set a strong `JWT_SECRET` in `.env` |
| Blank page after deploy | Run `npm run build:admin` and restart the backend |
| URL changed | Tailscale machine name is stable; quick Cloudflare tunnels are not used here |

---

## What is NOT exposed remotely

- **POS** (`frontend-pos`) — only runs locally in the shop for checkout.
- **SQLite database** — stays on the shop PC; not directly accessible from the phone.
