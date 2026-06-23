import { round2 } from "./money.js";

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
 * Changing a product/supplier cost later never affects this value.
 *
 * Legacy fallback: transactions that have NO snapshot line items (older data)
 * fall back to current product cost via cogsForItemsJsonString.
 *
 * @param {object} db
 * @param {string} from YYYY-MM-DD (inclusive)
 * @param {string} to   YYYY-MM-DD (inclusive)
 * @returns {Promise<number>}
 */
export async function snapshotSalesCogsForRange(db, from, to) {
  const snap = await db.get(
    `SELECT COALESCE(SUM(ti.unit_cost_at_sale * ti.quantity), 0) AS cogs
     FROM transaction_items ti
     JOIN transactions t ON t.id = ti.transaction_id
     WHERE date(t.created_at) >= ? AND date(t.created_at) <= ?
       AND COALESCE(t.status, 'completed') = 'completed'`,
    [from, to]
  );
  let cogs = Number(snap?.cogs) || 0;

  const legacy = await db.all(
    `SELECT items_json FROM transactions t
     WHERE date(t.created_at) >= ? AND date(t.created_at) <= ?
       AND COALESCE(t.status, 'completed') = 'completed'
       AND NOT EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id)`,
    [from, to]
  );
  for (const row of legacy) {
    cogs += await cogsForItemsJsonString(db, row.items_json);
  }
  return round2(cogs);
}

/**
 * Historical COGS to REVERSE for refunds in a date range. Each refunded unit's
 * cost is taken from the ORIGINAL sale-item snapshot (matched by transaction +
 * product + sold unit price), never from the current product cost.
 *
 * @param {object} db
 * @param {string} from YYYY-MM-DD (inclusive)
 * @param {string} to   YYYY-MM-DD (inclusive)
 * @returns {Promise<number>}
 */
export async function snapshotRefundCogsForRange(db, from, to) {
  const refunds = await db.all(
    `SELECT items_json, original_transaction_id FROM refunds
     WHERE date(created_at) >= ? AND date(created_at) <= ?`,
    [from, to]
  );
  let total = 0;
  for (const r of refunds) {
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
