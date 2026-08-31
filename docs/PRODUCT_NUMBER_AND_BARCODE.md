# Product Number vs Barcode

`products.sku` and `products.barcode` are separate fields. Do not store one in the other.

| Concept | Column | UI label | Format | Purpose |
|---|---|---|---|---|
| Product number | `products.sku` | الرقم / رقم المنتج | Stored as the plain integer text (`1`, `2`, `10`) with no leading zeros | Internal catalogue order, search by number, display |
| Barcode | `products.barcode` | الباركود | Digits only, 4–14 characters | Scanner lookup, POS, units, checkout |

The column is named `sku` for backward compatibility only. In this system it means **رقم المنتج**, never a scannable barcode.

Related barcode storage (also never a product number):

- `product_barcodes.barcode` — extra / primary aliases
- `product_units.barcode` — per-unit package codes
- `product_unit_barcodes.barcode` — extra codes on a unit

## Rules

1. Creating a product requires a real barcode. The suggested الرقم must not be copied into الباركود.
2. A barcode may coincidentally look like a product number. That is allowed; do not hide or rewrite it.
3. `GET /api/products/next-sku` returns only the next رقم. It never returns a barcode.
4. Every write path stores numeric `sku` values via `formatProductSku` (no leading zeros).
5. Every write path stores barcodes via `digitsOnly(normalizeBarcodeInput(...))`.

## Numbering policy

A رقم is a stable human identifier. Once issued it belongs to that product forever.

1. A new product gets the next number above the highest ever issued.
2. Deleting a product does not free its رقم. The number is retired.
3. Gaps are expected. A list reading `1, 2, 5, 7` is correct — do not renumber rows, insert placeholders, or warn about the gap.
4. Existing numbers never change on their own. Nothing renumbers after a delete.
5. Allocation never searches for the lowest free number.

`entity_code_sequences.last_seq` is the high-water mark. `ensureEntityCode` calls
`reserveEntityCode` for codes supplied by the caller, so a رقم that the client sent
(the add form pre-fills the suggestion) still advances the sequence. Without that
reservation, deleting the newest product would make its number available again.

`renumberAllEntityCodes` rewrites every code as 1..N. It is a maintenance-only
operation: reachable through `POST /api/admin/renumber-entity-codes` behind
`requireAuth, requireAdmin`, or the `backend/scripts/renumber-entity-codes.mjs`
script. It is deliberately absent from the product management UI and must never be
called automatically, because it invalidates printed labels and any historical
reference to a رقم.

## One-time sequential SKU rewrite (manual)

This is **not** an auto-migration. `init.js` does not renumber on startup.

On the **dev PC** (test DB only):

```
node backend/scripts/renumber-test-product-skus.mjs
```

That script refuses `supermarket.db` and refuses `NODE_ENV=production`.

On the **shop PC**, after a backup and preferably with the API stopped:

```
node backend/scripts/renumber-store-product-skus.mjs --confirm-store-db
```

Optional explicit path:

```
node backend/scripts/renumber-store-product-skus.mjs --confirm-store-db --db C:\abo_shalbak\data\supermarket.db
```

Docker (container name `supermarket-pos`):

```
docker exec supermarket-pos node /app/backend/scripts/renumber-store-product-skus.mjs --confirm-store-db
```

The store script refuses to run without `--confirm-store-db`, refuses
`supermarket-dev.db`, and refuses a missing file. It backs up first, then
updates only `products.sku` to `1`…`N` by `id ASC` (no leading zeros), and
sets `entity_code_sequences.last_seq` to N so the next generated رقم is N+1.
