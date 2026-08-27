import { round2 } from "./money.js";
import {
  TX_BUSINESS_DAY_JOIN,
  REFUND_BUSINESS_DAY_JOIN,
  toSqlUtc,
  rowMatchesShopDateRange,
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
export async function snapshotSalesCogsForRange(db, from, to) {
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
  let cogs = 0;
  for (const row of matched) {
    const snap = await db.get(
      `SELECT COALESCE(SUM(unit_cost_at_sale * quantity), 0) AS cogs
       FROM transaction_items WHERE transaction_id = ?`,
      [row.id]
    );
    const snapCogs = Number(snap?.cogs) || 0;
    if (snapCogs > 0) {
      cogs += snapCogs;
    } else {
      cogs += await cogsForItemsJsonString(db, row.items_json);
    }
  }
  return round2(cogs);
}

/**
 * Historical COGS to REVERSE for approved refunds in a date range.
 */
export async function snapshotRefundCogsForRange(db, from, to) {
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
  let total = 0;
  for (const r of refunds.filter((row) => rowMatchesShopDateRange(row, from, to))) {
    const items = parseItemsJson(r.items_json);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.quantity) || 0;
      const price = round2(Number(it.price) || 0);
      if (!pid || qty <= 0) continue;
      const ti = await db.get(
        `SELECT unit_cost_at_sale FROM transaction_items
         WHERE transaction_id = ? AND product_id = ? AND unit_price = ? LIMIT 1`,
        [r.original_transaction_id, pid, price]
      );
      let unitCost;
      if (ti && ti.unit_cost_at_sale != null) {
        unitCost = Number(ti.unit_cost_at_sale) || 0;
      } else {
        const p = await db.get("SELECT cost FROM products WHERE id = ?", [pid]);
        unitCost = p ? Number(p.cost) || 0 : 0;
      }
      total += unitCost * qty;
    }
  }
  return round2(total);
}
