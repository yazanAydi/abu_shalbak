# Security Audit Report — "أبو شلبك" POS

## Application-level security (already in place)

- **AuthN/AuthZ:** JWT auth (`middleware/auth.js`), role gates (`requireAuth`,
  `requireAdmin`, `requireRoles`, `requirePosAccess`), bcrypt password hashing,
  forced password change support.
- **Input validation:** Zod schemas (`middleware/schemas.js`) + parameterized
  SQL everywhere (no string-built SQL). Covered by `tests/sqlInjection.test.js`.
- **Transport/headers:** Helmet, CORS allow-list (`ALLOWED_ORIGINS`), rate
  limiting (`apiLimiter`), request IDs, response envelope.
- **Telegram webhook:** secret-validated; refund decisions go through a single
  status-guarded service.

## Hardening added in this fix phase (Stage 6)

### Product import (admin-only `POST /admin/products/upload`)
- multer limit reduced 50MB → **10MB**, `files: 1`, and a **fileFilter** that
  rejects anything other than `.csv` / `.xlsx` by extension and MIME.
- **Row cap** `MAX_IMPORT_ROWS = 50000` for both CSV and XLSX (DoS guard).
- **Prototype-pollution guard:** `__proto__` / `prototype` / `constructor`
  keys are stripped from parsed CSV records and the internal lookup map uses a
  null-prototype object.
- **No formula evaluation:** `XLSX.read(..., { cellFormula:false, cellHTML:false, bookVBA:false })`;
  values are read as plain data only.

### CSV export (formula injection)
- Both the frontend exporter (`frontend/src/utils/reportExport.js`) and the
  backend shift CSV (`backend/routes/shifts.js`) now prefix any cell beginning
  with `= + - @ TAB CR` with a single quote, so spreadsheets cannot execute it.

## Dependency audit (`npm audit`, backend)

Totals: **0 critical, 9 high, 20 moderate, 2 low.** Reachability per finding:

| Package(s) | Severity | Reachable at runtime? | Notes / mitigation |
|---|---|---|---|
| `xlsx` (SheetJS) | HIGH (proto pollution, ReDoS) | Yes — only via admin import | No upstream npm fix for `^0.18.5`. Mitigated: admin-only, size+row caps, proto-key stripping, `cellFormula:false`. Residual ReDoS requires an authenticated admin uploading a crafted file — low practical risk. |
| `tar`, `node-gyp`, `sqlite3`, `cacache`, `make-fetch-happen`, `@mapbox/node-pre-gyp`, `bcrypt` (chain) | HIGH | No | Build/install-time native-module toolchain. Not invoked by request input at runtime. |
| `form-data` | HIGH (CRLF) | No | Transitive of `supertest` (test-only). Not in production runtime. |
| `qs` / `body-parser` / `express` | MODERATE (qs DoS) | Unlikely | The DoS needs `qs.stringify` with `encodeValuesOnly` + null/undefined comma arrays — not how Express parses our query strings. Safe to address via a future Express minor bump. |
| `js-yaml`, `jest*`, `babel*`, `@istanbuljs/*` | MODERATE | No | Dev/test toolchain only. |
| `@tootallnate/once`, `http-proxy-agent` | LOW | No | Build-time transitive. |

### Decisions
- **No breaking major upgrades** were applied (per plan) to avoid destabilizing
  a working store system. The only runtime-reachable finding (`xlsx`) is
  mitigated by access control + input hardening above.
- Recommended future steps: bump Express to the latest 4.x minor to clear `qs`;
  re-run `npm audit` after each dependency update; consider replacing `xlsx`
  with a maintained reader if richer spreadsheet support is needed.

## Tests
`backend/tests/importHardening.test.js` covers the row cap and
prototype-pollution stripping; `tests/sqlInjection.test.js` covers SQL safety.
