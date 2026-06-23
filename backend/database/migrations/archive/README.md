# Archived legacy SQL migrations

These `.sql` files are **historical only and are NOT executed** by the
application. They predate the current schema-management approach.

## Authoritative schema source

`backend/database/init.js` is the **single source of truth** for the database
schema. It runs on every startup and applies all table creation and column
migrations idempotently (guarded by `tableHasColumn`, `CREATE TABLE IF NOT
EXISTS`, `CREATE ... INDEX IF NOT EXISTS`, etc.). Nothing in this folder is
read or applied at runtime.

These files are kept only so the original migration intent stays visible in
version history. **Do not add new `.sql` files here and do not rely on them.**
To change the schema, add an idempotent migration step inside `init.js`.

The applied schema version is recorded in the `schema_migrations` table by
`init.js` so operators can confirm which baseline the live database is on.
