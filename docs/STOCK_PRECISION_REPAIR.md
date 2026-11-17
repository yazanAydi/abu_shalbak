# Stock precision at zero

Inventory arithmetic can leave binary residues such as `-2.7755575615628914e-17`.
The zero-all operation cancels the exact stored quantity. Normal stock movements
cancel a remainder smaller than `1e-9` when depleting an existing balance. Stock
alerts treat that noise as zero; real fractional stock and negative balances such
as `-0.000001` remain visible. Zero stock still belongs in low-stock alerts.

## Existing quantities

Deployment does not automatically repair existing rows. Do not run zero-all again
just to fix precision after staff have started counting or receiving stock.

Preview an existing database without initialization or background services:

```sh
node backend/scripts/repair-stock-precision.mjs --database /absolute/path/to/backup.db
```

The default opens the database read-only and reports affected IDs and old values
in products, batches, source lots, and warehouse quantity caches. Only nonzero
quantities whose absolute value is below `1e-9` qualify.

Review and test on a backup first. For an explicitly approved correction, use an
existing admin user ID and a reason:

```sh
node backend/scripts/repair-stock-precision.mjs --database /absolute/path/to/database.db --apply --actor-id ADMIN_ID --reason "Correct binary stock residues"
```

Apply rechecks the rows in one transaction, appends product ledger corrections,
and audits every affected table, row ID and old quantity. If the audit fails,
the corrections roll back. Repeating it without new residues makes no changes.
It does not reset genuine counted quantities, rewrite previous ledger entries,
reprice historical sales, or alter expiry-report verification.
