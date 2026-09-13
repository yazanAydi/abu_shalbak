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
function emptyCogsDay() {
  return { known: 0, unknown: false };
}

function addCogsDay(byDay, ymd, entry) {
  const prev = byDay.get(ymd) || emptyCogsDay();
  if (!entry || !entry.known) {
    prev.unknown = true;
  } else {
    prev.known = round2(prev.known + entry.cogs);
  }
  byDay.set(ymd, prev);
}

function summarizeCogsDays(byDay) {
  let unknown = false;
  let cogs = 0;
  for (const day of byDay.values()) {
    if (day.unknown) unknown = true;
    else cogs += day.known;
  }
  if (unknown) return { cogs: null, unknown: true };
  return { cogs: round2(cogs), unknown: false };
}

/**
 * Per-transaction snapshot: known (including valid 0) or unknown (no items / NULL cost).
 * Never falls back to live products.cost.
 */
async function loadCogsByTransactionIds(db, transactionIds) {
  const map = new Map();
  if (!transactionIds.length) return map;
  const CHUNK = 400;
  for (let i = 0; i < transactionIds.length; i += CHUNK) {
    const chunk = transactionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT transaction_id,
              COUNT(*) AS item_count,
              SUM(CASE WHEN unit_cost_at_sale IS NULL THEN 1 ELSE 0 END) AS null_costs,
              SUM(CASE WHEN unit_cost_at_sale IS NULL THEN 0 ELSE unit_cost_at_sale * quantity END) AS cogs
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})
       GROUP BY transaction_id`,
      chunk
    );
    for (const row of rows) {
      const known = Number(row.item_count) > 0 && Number(row.null_costs) === 0;
      map.set(Number(row.transaction_id), {
        known,
        cogs: known ? Number(row.cogs) || 0 : null,
      });
    }
  }
  for (const id of transactionIds) {
    if (!map.has(Number(id))) {
      map.set(Number(id), { known: false, cogs: null });
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
    const ymd = shopBusinessDayYmd(row);
    if (!ymd) continue;
    addCogsDay(byDay, ymd, cogsByTx.get(Number(row.id)));
  }
  return byDay;
}

export async function snapshotSalesCogsForRange(db, from, to) {
  return summarizeCogsDays(await snapshotSalesCogsByDay(db, from, to));
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
        costByKey.set(key, {
          known: row.unit_cost_at_sale != null,
          unitCost: row.unit_cost_at_sale == null ? null : Number(row.unit_cost_at_sale),
        });
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

  const byDay = new Map();
  for (const r of matched) {
    const items = parseItemsJson(r.items_json);
    if (!Array.isArray(items)) continue;
    const ymd = shopBusinessDayYmd(r);
    if (!ymd) continue;
    let known = true;
    let dayCogs = 0;
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.quantity) || 0;
      const price = round2(Number(it.price) || 0);
      if (!pid || qty <= 0) continue;
      const key = `${r.original_transaction_id}:${pid}:${price}`;
      const snap = costByKey.get(key);
      if (!snap || !snap.known) {
        known = false;
        break;
      }
      dayCogs += snap.unitCost * qty;
    }
    addCogsDay(byDay, ymd, known ? { known: true, cogs: dayCogs } : { known: false, cogs: null });
  }
  return byDay;
}

export async function snapshotRefundCogsForRange(db, from, to) {
  return summarizeCogsDays(await snapshotRefundCogsByDay(db, from, to));
}
