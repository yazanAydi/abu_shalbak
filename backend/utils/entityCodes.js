/** @typedef {'product' | 'customer' | 'supplier'} EntityType */

import { withTransaction } from "./dbTx.js";

/**
 * products.sku is رقم المنتج (product number), not a barcode.
 * The column name is kept for backward compatibility. See docs/PRODUCT_NUMBER_AND_BARCODE.md.
 */
export const ENTITY_TYPES = {
  product: { table: "products", column: "sku" },
  customer: { table: "customers", column: "customer_code" },
  supplier: { table: "suppliers", column: "supplier_code" },
};

/** Canonical width for a numeric رقم المنتج stored in products.sku. */
export const PRODUCT_SKU_LENGTH = 11;

/**
 * Keep a product رقم as 11-digit zero-padded text when it is numeric.
 * @param {unknown} code
 * @returns {string | null}
 */
export function formatProductSku(code) {
  if (code == null) return null;
  const s = String(code).trim();
  if (!s) return null;
  const n = parseNumericCode(s);
  return n != null ? String(n).padStart(PRODUCT_SKU_LENGTH, "0") : s;
}

/**
 * @param {EntityType} entityType
 * @param {unknown} code
 * @returns {string | null}
 */
function formatEntityCode(entityType, code) {
  const normalized = normalizeProvidedCode(code);
  if (!normalized) return null;
  return entityType === "product" ? formatProductSku(normalized) : normalized;
}

/**
 * @param {unknown} val
 * @returns {number | null}
 */
export function parseNumericCode(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * @param {unknown} val
 * @returns {string | null}
 */
export function normalizeProvidedCode(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s || null;
}

/**
 * Atomically allocate the next sequential code for an entity type.
 * @param {object} db
 * @param {EntityType} entityType
 * @returns {Promise<string>}
 */
export async function nextEntityCode(db, entityType) {
  const meta = ENTITY_TYPES[entityType];
  if (!meta) throw new Error(`Unknown entity type: ${entityType}`);

  await db.run(
    `INSERT INTO entity_code_sequences (entity_type, last_seq)
     VALUES (?, 1)
     ON CONFLICT(entity_type) DO UPDATE SET last_seq = last_seq + 1`,
    [entityType]
  );

  const row = await db.get(
    "SELECT last_seq FROM entity_code_sequences WHERE entity_type = ?",
    [entityType]
  );

  return formatEntityCode(entityType, row?.last_seq ?? 1) ?? String(row?.last_seq ?? 1);
}

/**
 * Raise the sequence high-water mark so a code handed out by the caller can never
 * be allocated a second time. Without this, codes supplied by the client (the add
 * form pre-fills the suggested رقم) leave last_seq behind, and deleting the newest
 * row would make its number available again.
 * @param {object} db
 * @param {EntityType} entityType
 * @param {unknown} code
 * @returns {Promise<void>}
 */
export async function reserveEntityCode(db, entityType, code) {
  if (!ENTITY_TYPES[entityType]) throw new Error(`Unknown entity type: ${entityType}`);
  const n = parseNumericCode(code);
  if (n == null) return;

  await db.run(
    `INSERT INTO entity_code_sequences (entity_type, last_seq)
     VALUES (?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
    [entityType, n]
  );
}

/**
 * @param {object} db
 * @param {EntityType} entityType
 * @returns {Promise<void>}
 */
async function syncSequenceFromExisting(db, entityType) {
  const meta = ENTITY_TYPES[entityType];
  const rows = await db.all(`SELECT ${meta.column} AS code FROM ${meta.table}`);
  let max = 0;
  for (const row of rows) {
    const n = parseNumericCode(row.code);
    if (n != null) max = Math.max(max, n);
  }

  const existing = await db.get(
    "SELECT last_seq FROM entity_code_sequences WHERE entity_type = ?",
    [entityType]
  );
  const lastSeq = Math.max(existing?.last_seq ?? 0, max);

  if (lastSeq > 0 || existing) {
    await db.run(
      `INSERT INTO entity_code_sequences (entity_type, last_seq)
       VALUES (?, ?)
       ON CONFLICT(entity_type) DO UPDATE SET last_seq = excluded.last_seq`,
      [entityType, lastSeq]
    );
  }
}

/**
 * Return trimmed code if provided, otherwise allocate the next sequential code.
 * @param {object} db
 * @param {EntityType} entityType
 * @param {unknown} providedCode
 * @returns {Promise<string>}
 */
export async function ensureEntityCode(db, entityType, providedCode) {
  const formatted = formatEntityCode(entityType, providedCode);
  if (formatted) {
    await reserveEntityCode(db, entityType, formatted);
    return formatted;
  }
  return nextEntityCode(db, entityType);
}

/**
 * Assign a code when the row has none; leaves existing non-empty codes untouched.
 * @param {object} db
 * @param {EntityType} entityType
 * @param {number} rowId
 * @returns {Promise<string | null>}
 */
export async function assignEntityCodeIfMissing(db, entityType, rowId) {
  const meta = ENTITY_TYPES[entityType];
  const row = await db.get(
    `SELECT ${meta.column} AS code FROM ${meta.table} WHERE id = ?`,
    [rowId]
  );
  if (!row) return null;

  const existing = formatEntityCode(entityType, row.code);
  if (existing) {
    if (existing !== normalizeProvidedCode(row.code)) {
      await db.run(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE id = ?`, [existing, rowId]);
    }
    await reserveEntityCode(db, entityType, existing);
    return existing;
  }

  const code = await nextEntityCode(db, entityType);
  await db.run(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE id = ?`, [code, rowId]);
  return code;
}

/**
 * Idempotent backfill for rows with empty codes; syncs sequence counters afterward.
 * @param {object} db
 */
export async function backfillMissingEntityCodes(db) {
  for (const entityType of /** @type {EntityType[]} */ (Object.keys(ENTITY_TYPES))) {
    const meta = ENTITY_TYPES[entityType];
    await syncSequenceFromExisting(db, entityType);

    const rows = await db.all(
      `SELECT id FROM ${meta.table}
       WHERE ${meta.column} IS NULL OR TRIM(${meta.column}) = ''
       ORDER BY id`
    );

    for (const row of rows) {
      const code = await nextEntityCode(db, entityType);
      await db.run(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE id = ?`, [code, row.id]);
    }
  }
}

/**
 * Replace every entity code with sequential 1..N ordered by id.
 * @param {object} db
 * @param {EntityType} entityType
 * @returns {Promise<number>} total rows renumbered
 */
export async function renumberAllEntityCodes(db, entityType) {
  const meta = ENTITY_TYPES[entityType];
  if (!meta) throw new Error(`Unknown entity type: ${entityType}`);

  const rows = await db.all(`SELECT id FROM ${meta.table} ORDER BY id`);

  return withTransaction(db, async () => {
    let seq = 0;
    for (const row of rows) {
      seq += 1;
      await db.run(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE id = ?`, [
        formatEntityCode(entityType, seq) ?? String(seq),
        row.id,
      ]);
    }
    await db.run(
      `INSERT INTO entity_code_sequences (entity_type, last_seq)
       VALUES (?, ?)
       ON CONFLICT(entity_type) DO UPDATE SET last_seq = excluded.last_seq`,
      [entityType, seq]
    );
    return seq;
  });
}

/**
 * @param {object} db
 * @param {EntityType[]} [entityTypes]
 * @returns {Promise<Record<string, number>>}
 */
export async function renumberAllEntityCodesBatch(db, entityTypes) {
  const types =
    entityTypes?.length > 0
      ? entityTypes.filter((t) => ENTITY_TYPES[t])
      : /** @type {EntityType[]} */ (Object.keys(ENTITY_TYPES));

  /** @type {Record<string, number>} */
  const counts = {};
  for (const entityType of types) {
    counts[entityType] = await renumberAllEntityCodes(db, entityType);
  }
  return counts;
}
