import { parseItemsJson } from "./cogs.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Aggregate completed-sale quantities/revenue/profit grouped by the selling price
 * recorded at sale time (transaction_items.unit_price). Reads ONLY snapshot
 * columns, so results never change when products.price changes later.
 */
export async function aggregateSalesByPrice(db, productId, filters = {}) {
  const { dateFrom, dateTo, cashierId, storeId } = filters;
  const params = [productId];
  let where = "ti.product_id = ? AND t.status = 'completed'";

  if (dateFrom) {
    where += " AND date(t.created_at) >= ?";
    params.push(dateFrom);
  }
  if (dateTo) {
    where += " AND date(t.created_at) <= ?";
    params.push(dateTo);
  }
  if (cashierId) {
    where += " AND t.cashier_id = ?";
    params.push(cashierId);
  }
  if (storeId) {
    where += " AND t.store_id = ?";
    params.push(storeId);
  }

  return db.all(
    `SELECT
       ti.product_id,
       MAX(ti.name) AS product_name,
       ti.unit_price AS unit_price_at_sale,
       SUM(ti.quantity) AS sold_quantity,
       COUNT(DISTINCT ti.transaction_id) AS number_of_transactions,
       ROUND(SUM(ti.line_gross), 2) AS total_revenue,
       ROUND(SUM(COALESCE(ti.gross_profit, 0)), 2) AS total_profit,
       MIN(t.created_at) AS first_sale_date,
       MAX(t.created_at) AS last_sale_date
     FROM transaction_items ti
     JOIN transactions t ON t.id = ti.transaction_id
     WHERE ${where}
     GROUP BY ti.unit_price
     ORDER BY ti.unit_price ASC`,
    params
  );
}

/**
 * Aggregate non-rejected refunds grouped by the price the customer paid.
 * Profit per refunded unit is derived from the matching transaction_items snapshot.
 */
export async function aggregateRefundsByPrice(db, productId, filters = {}) {
  const { dateFrom, dateTo, cashierId, storeId } = filters;
  const params = [productId];
  let where = `r.status != 'rejected'
     AND EXISTS (
       SELECT 1 FROM transaction_items ti
       WHERE ti.transaction_id = r.original_transaction_id AND ti.product_id = ?
     )`;

  if (dateFrom) {
    where += " AND date(t.created_at) >= ?";
    params.push(dateFrom);
  }
  if (dateTo) {
    where += " AND date(t.created_at) <= ?";
    params.push(dateTo);
  }
  if (cashierId) {
    where += " AND t.cashier_id = ?";
    params.push(cashierId);
  }
  if (storeId) {
    where += " AND t.store_id = ?";
    params.push(storeId);
  }

  const refundRows = await db.all(
    `SELECT r.items_json, r.original_transaction_id
     FROM refunds r
     JOIN transactions t ON t.id = r.original_transaction_id
     WHERE ${where}`,
    params
  );

  const byPrice = new Map();

  for (const row of refundRows) {
    const items = parseItemsJson(row.items_json);
    if (!Array.isArray(items)) continue;

    for (const it of items) {
      if (Number(it.product_id) !== productId) continue;
      const qty = Number(it.quantity) || 0;
      const price = round2(Number(it.price) || 0);
      if (qty <= 0) continue;

      const prev = byPrice.get(price) || {
        refunded_quantity: 0,
        refunded_revenue: 0,
        refunded_profit: 0,
      };
      prev.refunded_quantity = round2(prev.refunded_quantity + qty);

      const grossRev = round2(qty * price);
      prev.refunded_revenue = round2(prev.refunded_revenue + grossRev);

      const txItem = await db.get(
        `SELECT quantity, gross_profit, unit_cost_at_sale, line_net
         FROM transaction_items
         WHERE transaction_id = ? AND product_id = ? AND unit_price = ?
         LIMIT 1`,
        [row.original_transaction_id, productId, price]
      );
      if (txItem && Number(txItem.quantity) > 0) {
        const profitPerUnit = Number(txItem.gross_profit || 0) / Number(txItem.quantity);
        prev.refunded_profit = round2(prev.refunded_profit + profitPerUnit * qty);
      }

      byPrice.set(price, prev);
    }
  }

  return byPrice;
}

/**
 * Merge gross sales rows with refund aggregates into net rows + summary.
 */
export function mergeSalesAndRefunds(salesRows, refundByPrice, includeRefunds) {
  const priceMap = new Map();

  for (const row of salesRows) {
    const price = round2(Number(row.unit_price_at_sale));
    priceMap.set(price, {
      product_id: row.product_id,
      product_name: row.product_name,
      unit_price_at_sale: price,
      sold_quantity: round2(Number(row.sold_quantity) || 0),
      refunded_quantity: 0,
      net_quantity_sold: round2(Number(row.sold_quantity) || 0),
      number_of_transactions: Number(row.number_of_transactions) || 0,
      total_revenue: round2(Number(row.total_revenue) || 0),
      total_profit: round2(Number(row.total_profit) || 0),
      first_sale_date: row.first_sale_date,
      last_sale_date: row.last_sale_date,
    });
  }

  if (includeRefunds) {
    for (const [price, ref] of refundByPrice.entries()) {
      const existing = priceMap.get(price);
      const refundedQty = round2(Number(ref.refunded_quantity) || 0);
      const refundedRev = round2(Number(ref.refunded_revenue) || 0);
      const refundedProfit = round2(Number(ref.refunded_profit) || 0);

      if (existing) {
        existing.refunded_quantity = refundedQty;
        existing.net_quantity_sold = round2(existing.sold_quantity - refundedQty);
        existing.total_revenue = round2(existing.total_revenue - refundedRev);
        existing.total_profit = round2(existing.total_profit - refundedProfit);
      } else {
        priceMap.set(price, {
          product_id: salesRows[0]?.product_id ?? null,
          product_name: salesRows[0]?.product_name ?? null,
          unit_price_at_sale: price,
          sold_quantity: 0,
          refunded_quantity: refundedQty,
          net_quantity_sold: round2(-refundedQty),
          number_of_transactions: 0,
          total_revenue: round2(-refundedRev),
          total_profit: round2(-refundedProfit),
          first_sale_date: null,
          last_sale_date: null,
        });
      }
    }
  }

  const rows = [...priceMap.values()].sort((a, b) => a.unit_price_at_sale - b.unit_price_at_sale);

  const summary = {
    total_quantity: round2(rows.reduce((s, r) => s + r.net_quantity_sold, 0)),
    total_revenue: round2(rows.reduce((s, r) => s + r.total_revenue, 0)),
    total_profit: round2(rows.reduce((s, r) => s + r.total_profit, 0)),
    distinct_prices: rows.length,
  };

  return { rows, summary };
}

/**
 * High-level convenience used by both the reports and product routers.
 */
export async function getSalesByPrice(db, productId, filters = {}, includeRefunds = true) {
  const salesRows = await aggregateSalesByPrice(db, productId, filters);
  const refundByPrice = includeRefunds
    ? await aggregateRefundsByPrice(db, productId, filters)
    : new Map();
  return mergeSalesAndRefunds(salesRows, refundByPrice, includeRefunds);
}
