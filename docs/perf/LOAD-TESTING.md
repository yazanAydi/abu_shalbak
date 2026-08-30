# System-wide concurrency and load testing

Two tiers, no extra npm dependencies, no production-code changes.

Fleet authentication signs the same JWTs `POST /auth/login` would (`issuer` / `audience` / `JWT_SECRET`). It does **not** call the login endpoint once per cashier: `loginLimiter` is 10 attempts / 15 minutes / IP and is skipped only when `NODE_ENV=test`, so a medium seed (20 cashiers) would 429 before any sale. Subsequent requests still go through `requireAuth`. Use `--rate-limit on` to exercise `apiLimiter` on those requests.

## Isolation

Load tests **refuse** any path named `supermarket*.db` and must live under `backend/data/loadtest/` or the OS temp directory. Cron, Telegram polling, and auto-backup are disabled. Jest concurrency tests use `createTestContext()` temp files (same as the rest of the suite).

## Commands

```bash
cd backend

# Tier A — deterministic invariant tests (also included in npm test)
npm run test:concurrency

# Tier B — realistic mixed HTTP load (defaults: 5 VUs, 20s + 5s warmup)
npm run loadtest:seed -- --size small
npm run loadtest -- --vus 5 --duration 20 --profile mixed --keep
npm run loadtest -- --sweep 5,10 --duration 15 --size small

# Multi-process SQLITE_BUSY (same DB file, N Node processes)
npm run loadtest:multiproc -- --vus 10 --duration 15 --keep

# Rate limiter as production would see it (300/min unless NODE_ENV=development)
npm run loadtest -- --vus 10 --rate-limit on --duration 15
```

Flags: `--vus`, `--sweep`, `--duration`, `--warmup`, `--profile mixed|pos|office|admin`, `--mode inproc|multiproc|restart`, `--processes`, `--db`, `--out`, `--keep`, `--rate-limit on|off`, `--think-time`, `--seed`, `--size small|medium|large`, `--break-auth` (harness check: tokens will not verify; process must exit 1).

The runner applies load-test `JWT_SECRET` before `auth.js` loads. A run with `successful=0`, `INVALID_TOKEN`, or zero receipts on a POS/mixed profile is a failed run.

## Threshold rationale (initial gates)

Anchored on `docs/perf/after.json` single-user latencies and the global `withTransaction` write queue:

| Class | Gate | Why |
|---|---|---|
| POS reads | p95 ≤ 250ms, p99 ≤ 500ms | Single-user 2–28ms; must stay instant at a register |
| Checkout | p95 ≤ 800ms, p99 ≤ 1500ms | ~9ms service time; queue amplification under ~10 writers |
| Office | p95 ≤ 1500ms | Back-office tolerance |
| Heavy reports | p95 ≤ 3000ms | Day-loop aggregations |
| Checkout during import | p99 ≤ 2000ms | 150-row import chunks hold the write queue |
| Event loop | p99 ≤ 200ms | Process still responsive |
| 5xx | 0 | Never acceptable |

Recalibrate after the first store-PC run (Node 20 + better-sqlite3). This machine is Node 24 + sqlite3.

## First local baseline (2026-08-30, sqlite3, Node 24)

Think-time enabled, mixed POS/office/admin, background CSV import mid-run. Sample counts are modest at 12s.

| VUs | requests | checkout p95 | refund p95 | 5xx | invariants |
|---:|---:|---:|---:|---:|---|
| 5 | low | 26ms | — | 0 | all OK |
| 10 | 49 | 341ms (import stall) | 407ms | 0 | all OK |
| 20 | higher | 271ms | 269ms | 0 | **FAIL** `stock_equals_baseline_plus_ledger` (product 27: stock 236 vs ledger 235) |

The 20-VU stock mismatch is a **real last-write-wins race**: office `PUT /products/:id` rewrites `stock` from a stale form snapshot while cashiers decrement via `UPDATE stock = stock + ?`. The ledger stays correct; the cache does not. Same root cause as C5. Do not weaken the invariant.

Practical limit on this box, with think-time: **interactive POS stays well under the 800ms checkout gate through 20 VUs**, but **data integrity already breaks** once office product edits overlap sales. That integrity limit is more important than latency.

## Known production bugs the suite is allowed to surface

These use `test.failing` so the assertion stays strict and `npm test` stays green until the bug is fixed (Jest then fails with “this test is marked as failing but it passed”).

1. **C5 / C15d last-write-wins** — product/customer PUT reads the row outside `withTransaction` and writes every column.
2. **C15a shift double-start** — open-shift check is outside the insert transaction; no unique partial index.
3. **C3b credit limit** — any POS `onAccountTotal > 0` returns 202; approvals do not call `validateCustomerCredit`.

## Plan vs codebase (C3)

The approved plan assumed mixed on-account checkouts run `validateCustomerCredit` inside the sale transaction. The live handler in `backend/routes/checkout.js` returns **202** and creates an `on_account_request` for **any** positive on-account amount, so that check is unreachable on the POS path. Tests follow the live code.

## Reports

Each Tier B run writes `docs/perf/load/<runId>/`:

- `run.json` — environment, metrics, invariants
- `samples.ndjson.gz` — per-request samples
- `REPORT.md` — human summary
- `sweep.md` — VU sweep table when `--sweep` is used
