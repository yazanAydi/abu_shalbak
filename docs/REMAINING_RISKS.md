# Remaining Risks — "أبو شلبك" POS

## Accepted / deferred

| Risk | Severity | Mitigation today | Future path |
|---|---|---|---|
| Money as SQLite `REAL` | Medium | Centralized `round2`; per-line rounding | Integer minor-units migration (`MONEY_PRECISION_REPORT.md`) |
| `xlsx` (SheetJS) vulnerabilities | Medium | Admin-only import; row/size caps; no formula eval | Replace library when maintained alternative available |
| Report day boundaries use server local `date()` | Low | `shopTime.js` (Asia/Hebron / Ramallah) | — |
| Telegram chat-level auth only | Low (accepted) | Manager chat ID gate | Per-user approver list (explicitly dropped) |

## Manual verification still required

- Physical barcode scanner behavior (keyboard wedge)
- Receipt printer drivers / browser print dialog
- Multi-cashier concurrent load on real LAN (unit tests use single process)
- Backup restore drill on production DB copy
- Shift close with real cash count and variance workflow

## Not in scope of automated tests

- Email/SMS notifications (not implemented)
- PostgreSQL migration (`MIGRATE_TO_POSTGRES.md` is planning doc only)
- Office UI visual regression across all 30+ pages

## Operational recommendations

1. Set `DATABASE_PATH` to absolute path; never run two server instances on different DB files.
2. Run `npm audit` quarterly; bump Express minor for `qs` advisory when convenient.
3. Keep Telegram bot token and JWT secret out of git (`.env` only).
4. Review negative-stock report weekly if overselling is common.
