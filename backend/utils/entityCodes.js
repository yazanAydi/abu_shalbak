/** @typedef {'product' | 'customer' | 'supplier'} EntityType */

export const ENTITY_TYPES = {
  product: { table: "products", column: "sku" },
  customer: { table: "customers", column: "customer_code" },
  supplier: { table: "suppliers", column: "supplier_code" },
};

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

  return String(row?.last_seq ?? 1);
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
  const normalized = normalizeProvidedCode(providedCode);
  if (normalized) return normalized;
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

  const existing = normalizeProvidedCode(row.code);
  if (existing) return existing;

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

  await db.run("BEGIN IMMEDIATE");
  try {
    let seq = 0;
    for (const row of rows) {
      seq += 1;
      await db.run(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE id = ?`, [
        String(seq),
        row.id,
      ]);
    }
    await db.run(
      `INSERT INTO entity_code_sequences (entity_type, last_seq)
       VALUES (?, ?)
       ON CONFLICT(entity_type) DO UPDATE SET last_seq = excluded.last_seq`,
      [entityType, seq]
    );
    await db.run("COMMIT");
    return seq;
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
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
