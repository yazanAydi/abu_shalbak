import { round2 } from "./tax.js";

/**
 * Load currencies from the DB.
 * @param {object} db
 * @param {{ enabledOnly?: boolean }} [opts]
 */
export async function listCurrencies(db, { enabledOnly = false } = {}) {
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  const rows = await db.all(
    `SELECT id, code, name, symbol, exchange_rate_to_nis, enabled, is_base, updated_at
     FROM currencies ${where}
     ORDER BY is_base DESC, code ASC`
  );
  return rows.map(normalizeCurrencyRow);
}

export async function getCurrencyById(db, id) {
  const row = await db.get(`SELECT * FROM currencies WHERE id = ?`, [Number(id)]);
  return row ? normalizeCurrencyRow(row) : null;
}

export async function getBaseCurrency(db) {
  const row = await db.get(`SELECT * FROM currencies WHERE is_base = 1 LIMIT 1`);
  return row ? normalizeCurrencyRow(row) : null;
}

function normalizeCurrencyRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    exchange_rate_to_nis: round2Rate(row.exchange_rate_to_nis),
    enabled: !!row.enabled,
    is_base: !!row.is_base,
    updated_at: row.updated_at,
  };
}

/** Rates may have >2 decimals; keep up to 4 without lossy round2. */
export function round2Rate(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.round(v * 10000) / 10000;
}

/** Convert a foreign amount to NIS using a given rate, rounded to 2 decimals. */
export function toNis(originalAmount, rate) {
  return round2(Number(originalAmount) * Number(rate));
}
