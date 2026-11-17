import { round2 } from "./money.js";
import {
  TX_BUSINESS_DAY_JOIN,
  REFUND_BUSINESS_DAY_JOIN,
  businessDayRangeClause,
  businessDayRangeParams,
  rowMatchesShopDateRange,
  shopBusinessDayYmd,
} from "./businessDay.js";

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

/**
 * Historical COGS of COMPLETED sales in a date range, computed from the
 * cost snapshot stored on each sale item (`transaction_items.unit_cost_at_sale`).
 */
const COST_GAP_NAME_LIMIT = 8;
const COST_GAP_ID_LIMIT = 8;
const NULL_NAME_SEP = "\x1f";

export function emptyCostGap() {
  return {
    salesMissingItems: 0,
    nullCostLines: 0,
    nullCostTransactions: 0,
    refundsWithoutLines: 0,
    refundsUnmatched: 0,
    refundsNullSnapshot: 0,
    productNames: [],
    transactionIds: [],
  };
}

export function mergeCostGap(target, extra) {
  if (!extra) return target;
  for (const key of [
    "salesMissingItems",
    "nullCostLines",
    "nullCostTransactions",
    "refundsWithoutLines",
    "refundsUnmatched",
    "refundsNullSnapshot",
  ]) {
    target[key] += Number(extra[key]) || 0;
  }
  for (const name of extra.productNames || []) {
    const text = String(name || "").trim();
    if (!text || target.productNames.includes(text) || target.productNames.length >= COST_GAP_NAME_LIMIT) continue;
    target.productNames.push(text);
  }
  for (const id of extra.transactionIds || []) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || target.transactionIds.includes(n)) continue;
    if (target.transactionIds.length >= COST_GAP_ID_LIMIT) continue;
    target.transactionIds.push(n);
  }
  target.transactionIds.sort((a, b) => a - b);
  return target;
}

function emptyCogsDay() {
  return { known: 0, unknown: false, gap: emptyCostGap() };
}

function addCogsDay(byDay, ymd, entry) {
  const prev = byDay.get(ymd) || emptyCogsDay();
  if (!entry || !entry.known) {
    prev.unknown = true;
  } else {
    prev.known = round2(prev.known + (Number(entry.cogs) || 0));
  }
  if (entry?.gap) mergeCostGap(prev.gap, entry.gap);
  byDay.set(ymd, prev);
}

function summarizeCogsDays(byDay) {
  let unknown = false;
  let cogs = 0;
  const gap = emptyCostGap();
  for (const day of byDay.values()) {
    if (day.unknown) unknown = true;
    else cogs += day.known;
    mergeCostGap(gap, day.gap);
  }
  if (unknown) return { cogs: null, unknown: true, gap };
  return { cogs: round2(cogs), unknown: false, gap };
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
              SUM(CASE WHEN unit_cost_at_sale IS NULL THEN 0 ELSE unit_cost_at_sale * quantity END) AS cogs,
              GROUP_CONCAT(CASE WHEN unit_cost_at_sale IS NULL THEN name END, char(31)) AS null_names
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})
       GROUP BY transaction_id`,
      chunk
    );
    for (const row of rows) {
      const nullCostLines = Number(row.null_costs) || 0;
      const known = Number(row.item_count) > 0 && nullCostLines === 0;
      const txId = Number(row.transaction_id);
      map.set(txId, {
        known,
        cogs: known ? Number(row.cogs) || 0 : null,
        gap: known
          ? emptyCostGap()
          : {
              ...emptyCostGap(),
              nullCostLines,
              nullCostTransactions: nullCostLines > 0 ? 1 : 0,
              productNames: String(row.null_names || "")
                .split(NULL_NAME_SEP)
                .map((name) => name.trim())
                .filter(Boolean),
              transactionIds: [txId],
            },
      });
    }
  }
  for (const id of transactionIds) {
    const txId = Number(id);
    if (!map.has(txId)) {
      map.set(txId, {
        known: false,
        cogs: null,
        gap: {
          ...emptyCostGap(),
          salesMissingItems: 1,
          transactionIds: [txId],
        },
      });
    }
  }
  return map;
}

/**
 * Historical sale COGS for transactions already assigned to a shop day.
 * `unit_cost_at_sale` is the only cost source. A missing item row or a NULL
 * snapshot makes that transaction unknown; live `products.cost` is not read.
 * @param {object} db
 * @param {object[]} transactions
 */
export async function snapshotSalesCogsForTransactions(db, transactions) {
  const list = Array.isArray(transactions) ? transactions : [];
  const cogsByTx = await loadCogsByTransactionIds(
    db,
    list.map((row) => row.id)
  );
  const byDay = new Map();
  for (const row of list) {
    const ymd = shopBusinessDayYmd(row);
    if (!ymd) continue;
    addCogsDay(byDay, ymd, cogsByTx.get(Number(row.id)));
  }
  return byDay;
}

/** Per-shop-day historical sale COGS for a date range. */
export async function snapshotSalesCogsByDay(db, from, to) {
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.created_at,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS start_time
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND ${businessDayRangeClause("t", "cs")}`,
    businessDayRangeParams(from, to)
  );
  const matched = rows.filter((r) => rowMatchesShopDateRange(r, from, to));
  return snapshotSalesCogsForTransactions(db, matched);
}

export async function snapshotSalesCogsForRange(db, from, to) {
  return summarizeCogsDays(await snapshotSalesCogsByDay(db, from, to));
}

/**
 * Historical COGS to REVERSE for approved refunds in a date range.
 */
async function loadSaleItemsByTransaction(db, refunds) {
  const origIds = [
    ...new Set(
      refunds.map((r) => Number(r.original_transaction_id)).filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const byTx = new Map();
  const CHUNK = 400;
  for (let i = 0; i < origIds.length; i += CHUNK) {
    const chunk = origIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT id, transaction_id, product_id, product_unit_id, unit_price, unit_cost_at_sale, name
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      const txId = Number(row.transaction_id);
      if (!byTx.has(txId)) byTx.set(txId, []);
      byTx.get(txId).push(row);
    }
  }
  return byTx;
}

/**
 * Reverse a refund line from the sale's saved unit cost.
 * A discounted refund price may differ from transaction_items.unit_price.
 * Today's products.cost is never read. Ambiguous or missing snapshots stay unknown.
 */
function resolveRefundLineCost(line, saleItems) {
  const pid = Number(line?.product_id);
  const qty = Number(line?.quantity) || 0;
  if (!pid || qty <= 0) return { skip: true };
  const rows = Array.isArray(saleItems) ? saleItems : [];
  let pool = rows.filter((row) => Number(row.product_id) === pid);
  const itemId = Number(line.transaction_item_id);
  if (itemId) {
    const pinned = rows.find((row) => Number(row.id) === itemId);
    if (!pinned || Number(pinned.product_id) !== pid) return { reason: "unmatched", name: line.name || null };
    pool = [pinned];
  } else {
    const unitId = Number(line.unit_id || line.product_unit_id || 0);
    if (unitId) {
      const byUnit = pool.filter((row) => Number(row.product_unit_id) === unitId);
      if (byUnit.length) pool = byUnit;
    }
  }
  if (!pool.length) return { reason: "unmatched", name: line.name || null };
  const price = round2(Number(line.price ?? line.unit_price) || 0);
  const priceHits = pool.filter((row) => round2(Number(row.unit_price) || 0) === price);
  const chosen = priceHits.length ? priceHits : pool;
  const name = chosen.find((row) => row.name)?.name || line.name || null;
  if (chosen.some((row) => row.unit_cost_at_sale == null)) {
    return { reason: "null_snapshot", name };
  }
  const costs = [...new Set(chosen.map((row) => round2(Number(row.unit_cost_at_sale))))];
  if (costs.length === 1) return { known: true, unitCost: costs[0], qty, name };
  return { reason: "unmatched", name };
}

/**
 * Historical refund COGS for approved refund rows already loaded.
 * Attribution uses the refund's shop business day, not the original sale day.
 * @param {object} db
 * @param {object[]} refunds
 */
function refundGap(reason, refund, name) {
  const gap = emptyCostGap();
  if (reason === "null_snapshot") gap.refundsNullSnapshot = 1;
  else if (reason === "unmatched") gap.refundsUnmatched = 1;
  else gap.refundsWithoutLines = 1;
  if (name) gap.productNames = [name];
  const txId = Number(refund?.original_transaction_id);
  if (Number.isInteger(txId) && txId > 0) gap.transactionIds = [txId];
  return gap;
}

export async function snapshotRefundCogsForRefundRows(db, refunds) {
  const matched = Array.isArray(refunds) ? refunds : [];
  const itemsByTx = await loadSaleItemsByTransaction(db, matched);
  const byDay = new Map();
  for (const r of matched) {
    const ymd = shopBusinessDayYmd(r);
    if (!ymd) continue;
    const items = parseItemsJson(r.items_json);
    if (!Array.isArray(items) || items.length === 0) {
      addCogsDay(byDay, ymd, { known: false, cogs: null, gap: refundGap("without_lines", r) });
      continue;
    }
    const saleItems = itemsByTx.get(Number(r.original_transaction_id)) || [];
    let blocking = null;
    let blockingName = null;
    let dayCogs = 0;
    let sawLine = false;
    const rank = { null_snapshot: 3, unmatched: 2, without_lines: 1 };
    for (const it of items) {
      const resolved = resolveRefundLineCost(it, saleItems);
      if (resolved.skip) continue;
      sawLine = true;
      if (!resolved.known) {
        if (!blocking || rank[resolved.reason] > rank[blocking]) {
          blocking = resolved.reason;
          blockingName = resolved.name;
        }
        continue;
      }
      dayCogs += resolved.unitCost * resolved.qty;
    }
    if (!sawLine || blocking) {
      addCogsDay(byDay, ymd, {
        known: false,
        cogs: null,
        gap: refundGap(blocking || "without_lines", r, blockingName),
      });
      continue;
    }
    addCogsDay(byDay, ymd, { known: true, cogs: dayCogs, gap: emptyCostGap() });
  }
  return byDay;
}

/** Per-shop-day historical refund COGS reversal for a date range. */
export async function snapshotRefundCogsByDay(db, from, to) {
  const refunds = await db.all(
    `SELECT r.id, r.items_json, r.original_transaction_id, r.created_at,
            r.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS start_time
     FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE r.status = 'approved'
       AND ${businessDayRangeClause("r", "cs")}`,
    businessDayRangeParams(from, to)
  );
  const matched = refunds.filter((row) => rowMatchesShopDateRange(row, from, to));
  return snapshotRefundCogsForRefundRows(db, matched);
}

export async function snapshotRefundCogsForRange(db, from, to) {
  return summarizeCogsDays(await snapshotRefundCogsByDay(db, from, to));
}
