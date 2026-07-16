# Dev vs store — keep them separate



Two environments must not share the same config or Telegram bots.



## Store (live shop)



| Item | Value |

|------|--------|

| Config file | `.env.store` |

| Start | `npm run store:up` |

| Stop | `npm run store:down` |

| Logs | `npm run store:logs` |

| POS URL | `http://YOUR_LAN_IP:3000/pos` |

| Admin URL | `http://YOUR_LAN_IP:3000/admin` |

| API port | **3000** (Docker) |



Run **only on the shop server PC**. Cashier PCs use a browser only.



Setup: copy `.env.store.example` → `.env.store`, fill secrets, then `npm run store:up`.



Before the first sale, verify the shop server Windows clock and timezone (Ramallah / Palestine). Docker sets `TZ=Asia/Hebron`; confirm with `docker exec supermarket-pos date` and `/api/v1/health`. See `docs/LAN_DEPLOYMENT_CHECKLIST.md`.



## Development (your PC)



| Item | Value |

|------|--------|

| Config file | `.env.development` |

| Frontend config | `frontend/.env`, `frontend-pos/.env` |

| Start | `npm start` (from repo root) |

| POS URL | `http://127.0.0.1:3002/pos` |

| Admin URL | `http://127.0.0.1:3001/admin` |

| API port | **5001** (backend only; admin uses proxy) |

| Database | `backend/data/supermarket-dev.db` |



### How admin reaches the API in dev



The admin dev server (`:3001`) proxies `/api` to the backend (`:5001`) via `frontend/src/setupProxy.js`. The browser always calls the same origin — no hardcoded API IP needed in `frontend/.env`.



```

Browser → http://127.0.0.1:3001/api/... → proxy → http://127.0.0.1:5001/api/...

```



POS (`:3002`) still uses `REACT_APP_API_BASE=http://127.0.0.1:5001` in `frontend-pos/.env` (no proxy).



Setup:



1. Copy `.env.development.example` → `.env.development`

2. Copy `frontend/.env.example` → `frontend/.env`

3. Copy `frontend-pos/.env.example` → `frontend-pos/.env`

4. Run `npm start` from the **repo root** (never `npm start` inside `frontend/` alone)

5. Run `npm run verify:dev` — both health checks must pass



**Do not** put store Telegram tokens in `.env.development` — that causes `getUpdates` conflicts with Docker.



## Isolated dev checklist



Before coding, confirm dev is fully separate from the live store:



| Check | Dev value | Store value |

|-------|-----------|-------------|

| Config file | `.env.development` | `.env.store` |

| Database | `supermarket-dev.db` | `supermarket.db` (in Docker) |

| API port | **5001** | **3000** |

| Telegram tokens | **empty** | filled in `.env.store` |

| `TELEGRAM_USE_POLLING` | **0** | **1** (or webhooks in prod) |



Optional — test with real product data (one-time snapshot, not live sync):



```powershell

Copy-Item backend\data\supermarket.db backend\data\supermarket-dev.db

```



After copying, dev and store databases diverge. Changes in dev never reach the store.



## Common mistakes



| Mistake | Result |

|---------|--------|

| `npm start` in `frontend/` or `frontend-pos/` only | API not running — run `npm start` from **root** |

| `npm start` in `backend/` on shop server | Port conflict, wrong DB path |

| Same Telegram tokens in dev + store | Telegram refund buttons fail on store |

| Cashiers use `:3002` or `:5001` | Wrong URLs — use `:3000/pos` on LAN |

| Setting `REACT_APP_API_BASE` in `frontend/.env` | Breaks phone/Tailscale access — leave unset; proxy handles it |

| `tailscale serve` pointing at `:5001` in dev | Serves API only, no admin UI — point at `:3001` |



## Quick commands



```powershell

# On your PC — coding

npm start

npm run verify:dev



# On shop server — live store

npm run store:up

```



### Clean restart (if login/kiosk show connection error)



```powershell

# Stop npm start (Ctrl+C), then if ports are stuck:

netstat -ano | findstr :5001

netstat -ano | findstr :3001

# taskkill /PID <pid> /F  (only if needed)



npm start

npm run verify:dev

```



## Verification



1. `npm start` from root → terminal shows `[api]`, `[admin]`, `[pos]` all running

2. `npm run verify:dev` → both API direct and admin proxy return OK

3. Open `http://127.0.0.1:3001/admin` → login works

4. Store Telegram refund buttons still work while dev is running

5. Create a test product in dev → does not appear on store POS



## Face attendance kiosk



| Item | Dev | Store (Docker) |

|------|-----|----------------|

| Admin → الموظفون | `http://127.0.0.1:3001/admin/cashier-payroll` | `http://LAN_IP:3000/admin/cashier-payroll` |

| Kiosk (no login) | `http://127.0.0.1:3001/admin/kiosk` | `https://…/admin/kiosk` (HTTPS required for camera) |

| Backend key | `KIOSK_API_KEY` in `.env.development` | `KIOSK_API_KEY` in `.env.store` |

| Frontend key | `REACT_APP_KIOSK_API_KEY` in `frontend/.env` | Same value, baked in at Docker build |



**Security note:** `REACT_APP_KIOSK_API_KEY` is embedded in the admin frontend bundle and `/kiosk` is a public route (no login). Anyone on the LAN who opens the kiosk page can read the key from browser devtools. Treat `KIOSK_API_KEY` as a **LAN gate** that blocks casual/unconfigured access, not as a secret credential. Restrict kiosk devices to the shop network and pin the browser to the kiosk URL.



Setup (one-time per shop):



1. Set the **same** random string in `KIOSK_API_KEY` (backend) and `REACT_APP_KIOSK_API_KEY` (admin frontend build).

2. Rebuild store: `npm run store:build` (passes `KIOSK_API_KEY` into the admin build).

3. In admin → **الموظفون** → **تسجيل الوجه**: enroll each employee (2–3 face samples).

4. Set hourly rates in **أجور الساعة**.

5. Open the kiosk on a tablet; pin the browser to the kiosk URL.



### Phone access in dev (Tailscale)



For kiosk camera on a phone, use HTTPS via Tailscale Serve — **point at the admin dev server (`:3001`), not `:5001`**:



```powershell

tailscale serve --bg --https=443 http://127.0.0.1:3001

```



Then on the phone open `https://<your-pc>.tailXXXX.ts.net/admin/kiosk`. The dev proxy forwards `/api` to the backend, so login and kiosk work on the same HTTPS origin.



Add your Tailscale HTTPS URL to `ALLOWED_ORIGINS` in `.env.development` if you call the API directly (not needed when using the proxy).



**HTTPS for camera:** Browsers block the camera on plain `http://` except `localhost`. Dev on `127.0.0.1` works over HTTP; phones need Tailscale Serve or a local certificate.


