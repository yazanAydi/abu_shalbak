# SQLite Backup Restore Instructions

**Manual restore only.** There is no public restore API by design.

Application backups (`POST /api/v1/admin/backup` and the 02:00 cron) use SQLite **`VACUUM INTO`**, not a raw copy of `supermarket.db`. That writes a standalone snapshot that includes WAL contents. `createBackup` then opens the new file read-only and checks that `sqlite_master` has at least one table.

## Verify a backup file

1. Confirm `backups/supermarket_YYYY-MM-DD_HHMMSS.db` exists and `size` matches the API/cron log.
2. Optional integrity check (any machine with `sqlite3`, **on the backup file only**):
   ```powershell
   sqlite3 backups\supermarket_YYYY-MM-DD_HHMMSS.db "PRAGMA integrity_check;"
   ```
   Expect a single line: `ok`.
3. Do **not** verify by copying the live `data/supermarket.db` while the store is running.

## Before you restore

1. **Stop the API server** completely (close the terminal or stop the Docker container).
2. Confirm no process holds a lock on `data/supermarket.db`.

## Restore steps

1. Locate your backup file in the `backups/` directory (e.g. `supermarket_2026-06-03_020000.db`).
2. Copy the current database aside as a safety copy:
   ```powershell
   copy data\supermarket.db data\supermarket.db.before-restore
   ```
3. Replace the live database with the backup:
   ```powershell
   copy backups\supermarket_YYYY-MM-DD_HHmmss.db data\supermarket.db
   ```
4. Start the API server again:
   ```powershell
   npm run start:api
   ```
5. Log in and verify recent transactions, stock levels, and shift data.

## Notes

- Backups are created manually via `POST /api/v1/admin/backup` (admin only) or automatically daily at 02:00 (`VACUUM INTO`).
- The `backups/` folder is outside any public static directory.
- WAL files (`supermarket.db-wal`, `supermarket.db-shm`) may exist on the **live** path; delete them after restore if the server was stopped cleanly.
