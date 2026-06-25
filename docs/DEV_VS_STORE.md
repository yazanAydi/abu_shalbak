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

## Development (your PC)

| Item | Value |
|------|--------|
| Config file | `.env.development` |
| Start | `npm start` (from repo root) |
| POS URL | `http://127.0.0.1:3002/pos` |
| Admin URL | `http://127.0.0.1:3001/admin` |
| API port | **5000** |

Setup: copy `.env.development.example` → `.env.development`.

**Do not** put store Telegram tokens in `.env.development` — that causes `getUpdates` conflicts with Docker.

## Common mistakes

| Mistake | Result |
|---------|--------|
| `npm start` in `frontend-pos` only | Error: server on port 5000 — run `npm start` from **root** |
| `npm start` in `backend/` on shop server | Port conflict, wrong DB path |
| Same Telegram tokens in dev + store | Telegram refund buttons fail |
| Cashiers use `:3002` or `:5000` | Wrong URLs — use `:3000/pos` on LAN |

## Quick commands

```powershell
# On your PC — coding
npm start

# On shop server — live store
npm run store:up
```
