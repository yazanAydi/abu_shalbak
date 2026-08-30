# Deploying better-sqlite3 on the store PC

The backend prefers `better-sqlite3` when the native module is present and
falls back to `node-sqlite3` otherwise. The SQLite file format does not change.

## Environment

```
SQLITE_DRIVER=better-sqlite3   # force native driver (fails if not installed)
SQLITE_DRIVER=sqlite3          # keep the previous async driver
```

If `SQLITE_DRIVER` is unset, the process tries `better-sqlite3` and silently
uses `sqlite3` when the native addon is missing.

## Install on the store Windows PC

1. Stop the API (`npm run dev` / the store start script).
2. Install Visual Studio Build Tools with the **Desktop development with C++**
   workload, or use a Node version that has a prebuilt binary (Node 20 LTS
   is recommended; Node 24 currently has no prebuild).
3. From `backend/`:

   ```
   npm install better-sqlite3@11.10.0
   npm rebuild better-sqlite3
   ```

4. Restart the API. Logs / `db.driver` on the wrapped connection will show
   `better-sqlite3`.

## Docker

The production image already installs `python3`, `make`, and `g++` so
`npm install` can compile the addon during `store:build`.

## Rollback

Set `SQLITE_DRIVER=sqlite3` and restart. No database migration is required.
