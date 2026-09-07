import { round2 } from "./money.js";
import {
  TX_BUSINESS_DAY_JOIN,
  REFUND_BUSINESS_DAY_JOIN,
  toSqlUtc,
  rowMatchesShopDateRange,
  shopBusinessDayYmd,
} from "./businessDay.js";
import { shopYmdRangeToUtcBounds } from "./shopTime.js";

/**
 * Live (current-cost) COGS. ONLY valid for future estimates / unsold-inventory
 * valuation and as a legacy fallback for sales that predate sale-item snapshots.
 * NEVER use this for historical profit of completed sales — use the snapshot
 * helpers below so that changing products.cost cannot rewrite old profit.
 */
export async function cogsForItemsArray(db, items) {
  if (!Array.isArray(items)) return 0;
  let t = 0;
  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity) || 0;
    if (!pid || qty <= 0) continue;
    const p = await db.get("SELECT cost FROM products WHERE id = ?", [pid]);
    const c = p ? Number(p.cost) || 0 : 0;
    t += c * qty;
  }
  return round2(t);
}

export function parseItemsJson(itemsJson) {
  if (typeof itemsJson === "string") {
    try {
      return JSON.parse(itemsJson);
    } catch {
      return null;
    }
  }
  return itemsJson;
}

export async function cogsForItemsJsonString(db, itemsJson) {
  const arr = parseItemsJson(itemsJson);
  if (!Array.isArray(arr)) return 0;
  return cogsForItemsArray(db, arr);
}

function rangeUtcParams(from, to) {
  const { startIso, endIso } = shopYmdRangeToUtcBounds(from, to);
  const startSql = toSqlUtc(startIso);
  const endSql = toSqlUtc(endIso);
  return [startSql, endSql, startSql, endSql];
}

/**
 * Historical COGS of COMPLETED sales in a date range, computed from the
 * cost snapshot stored on each sale item (`transaction_items.unit_cost_at_sale`).
 */
async function loadCogsByTransactionIds(db, transactionIds) {
  const map = new Map();
  if (!transactionIds.length) return map;
  const CHUNK = 400;
  for (let i = 0; i < transactionIds.length; i += CHUNK) {
    const chunk = transactionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT transaction_id, COALESCE(SUM(unit_cost_at_sale * quantity), 0) AS cogs
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})
       GROUP BY transaction_id`,
      chunk
    );
    for (const row of rows) {
      map.set(Number(row.transaction_id), Number(row.cogs) || 0);
    }
  }
  return map;
}

/** Per-shop-day historical sale COGS for a date range. */
export async function snapshotSalesCogsByDay(db, from, to) {
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.created_at, cs.start_time AS start_time
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND (
         (datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
    rangeUtcParams(from, to)
  );
  const matched = rows.filter((r) => rowMatchesShopDateRange(r, from, to));
  const cogsByTx = await loadCogsByTransactionIds(
    db,
    matched.map((row) => row.id)
  );
  const byDay = new Map();
  for (const row of matched) {
    let cogs = cogsByTx.get(Number(row.id)) || 0;
    if (cogs <= 0) {
      cogs = await cogsForItemsJsonString(db, row.items_json);
    }
    const ymd = shopBusinessDayYmd(row);
    if (!ymd) continue;
    byDay.set(ymd, round2((byDay.get(ymd) || 0) + cogs));
  }
  return byDay;
}

export async function snapshotSalesCogsForRange(db, from, to) {
  const byDay = await snapshotSalesCogsByDay(db, from, to);
  let cogs = 0;
  for (const value of byDay.values()) cogs += value;
  return round2(cogs);
}

/**
 * Historical COGS to REVERSE for approved refunds in a date range.
 */
async function refundUnitCostLookup(db, refunds) {
  const origIds = [
    ...new Set(
      refunds.map((r) => Number(r.original_transaction_id)).filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const costByKey = new Map();
  const CHUNK = 400;
  for (let i = 0; i < origIds.length; i += CHUNK) {
    const chunk = origIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT transaction_id, product_id, unit_price, unit_cost_at_sale
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      const key = `${row.transaction_id}:${row.product_id}:${round2(Number(row.unit_price) || 0)}`;
      if (!costByKey.has(key)) {
        costByKey.set(key, Number(row.unit_cost_at_sale) || 0);
      }
    }
  }
  return costByKey;
}

/** Per-shop-day historical refund COGS reversal for a date range. */
export async function snapshotRefundCogsByDay(db, from, to) {
  const refunds = await db.all(
    `SELECT r.items_json, r.original_transaction_id, r.created_at, cs.start_time AS start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE r.status = 'approved'
       AND (
         (datetime(r.created_at) >= datetime(?) AND datetime(r.created_at) <= datetime(?))
         OR (cs.start_time IS NOT NULL
             AND datetime(cs.start_time) >= datetime(?)
             AND datetime(cs.start_time) <= datetime(?))
       )`,
    rangeUtcParams(from, to)
  );
  const matched = refunds.filter((row) => rowMatchesShopDateRange(row, from, to));
  const costByKey = await refundUnitCostLookup(db, matched);
  const productIds = new Set();
  for (const r of matched) {
    const items = parseItemsJson(r.items_json);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const pid = Number(it.product_id);
      if (pid) productIds.add(pid);
    }
  }
  const liveCost = new Map();
  const ids = [...productIds];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(`SELECT id, cost FROM products WHERE id IN (${placeholders})`, chunk);
    for (const row of rows) liveCost.set(Number(row.id), Number(row.cost) || 0);
  }

  const byDay = new Map();
  for (const r of matched) {
    const items = parseItemsJson(r.items_json);
    if (!Array.isArray(items)) continue;
    let dayCogs = 0;
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.quantity) || 0;
      const price = round2(Number(it.price) || 0);
      if (!pid || qty <= 0) continue;
      const key = `${r.original_transaction_id}:${pid}:${price}`;
      const unitCost = costByKey.has(key) ? costByKey.get(key) : liveCost.get(pid) || 0;
      dayCogs += unitCost * qty;
    }
    const ymd = shopBusinessDayYmd(r);
    if (!ymd) continue;
    byDay.set(ymd, round2((byDay.get(ymd) || 0) + dayCogs));
  }
  return byDay;
}

export async function snapshotRefundCogsForRange(db, from, to) {
  const byDay = await snapshotRefundCogsByDay(db, from, to);
  let total = 0;
  for (const value of byDay.values()) total += value;
  return round2(total);
}
