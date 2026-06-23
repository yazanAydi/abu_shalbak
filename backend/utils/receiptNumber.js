/**
 * Atomic sequential receipt number generation.
 * Format: INV-YYYY-000001 (branch-ready via storeId)
 */

export function formatReceiptNumber(year, seq) {
  const y = Number(year);
  const s = Number(seq);
  return `INV-${y}-${String(s).padStart(6, "0")}`;
}

/**
 * Generate next receipt number atomically inside a transaction.
 * @param {object} db
 * @param {number} [storeId]
 * @returns {Promise<string>}
 */
export async function nextReceiptNumber(db, storeId = 1) {
  const sid = Number(storeId) || 1;
  const year = new Date().getFullYear();

  await db.run(
    `INSERT INTO receipt_sequences (store_id, year, last_seq)
     VALUES (?, ?, 1)
     ON CONFLICT(store_id, year) DO UPDATE SET last_seq = last_seq + 1`,
    [sid, year]
  );

  const row = await db.get(
    "SELECT last_seq FROM receipt_sequences WHERE store_id = ? AND year = ?",
    [sid, year]
  );

  return formatReceiptNumber(year, row?.last_seq || 1);
}
