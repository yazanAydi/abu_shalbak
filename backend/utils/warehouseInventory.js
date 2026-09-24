/**
 * Warehouse stock views.
 *
 * Per-warehouse `warehouse_stock` is only written by posted transfers.
 * Office valuation / stock reports also overlay:
 *   - type=main    → live catalog `products.stock`
 *   - type=returns → posted purchase-return invoice lines
 *
 * `membership=bakery` uses bakery workspace products (materials + finished
 * sale categories). The default supermarket view uses retail-scope products.
 */

import { round2 } from "./money.js";
import { productSkuLookupValues } from "./entityCodes.js";
import { bakeryMembershipSql, BAKERY_KIND_WORKSPACE, parseBakeryKind } from "./bakeryMembership.js";
import { resolveBakeryReportCategories } from "../services/bakeryReportService.js";

const QTY_EPS = 0.0001;
const RETURN_QTY_SQL = `COALESCE(pri.base_quantity, pri.quantity)`;
const RETURN_VALUE_SQL = `COALESCE(pri.line_total, pri.total_cost, 0)`;

function pickWarehouse(rows, type) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    list.find((w) => w.type === type && Number(w.active) !== 0) ||
    list.find((w) => w.type === type) ||
    null
  );
}

function num(v) {
  return Number(v) || 0;
}

function isBakeryMembership(value) {
  return String(value || "").trim().toLowerCase() === "bakery";
}

/** Match name, scannable barcodes, or رقم المنتج. */
export function productSearchClause(alias, rawQuery) {
  const term = String(rawQuery || "").trim();
  if (!term) return { sql: "", params: [] };
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const like = `%${term}%`;
  const likeLower = `%${term.toLowerCase()}%`;
  const skuValues = productSkuLookupValues(term);
  const idExpr = col("id");
  const parts = [
    `LOWER(${col("name")}) LIKE ?`,
    `CAST(${col("barcode")} AS TEXT) LIKE ?`,
    `EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = ${idExpr} AND pb.barcode LIKE ?)`,
  ];
  const params = [likeLower, like, like];
  if (skuValues.length) {
    parts.push(`${col("sku")} IN (${skuValues.map(() => "?").join(", ")})`);
    params.push(...skuValues);
  } else {
    parts.push(`CAST(${col("sku")} AS TEXT) LIKE ?`);
    params.push(like);
  }
  return { sql: ` AND (${parts.join(" OR ")})`, params };
}

export async function resolveWarehouseCatalog(db, options = {}) {
  const search = productSearchClause("p", options.q);
  if (isBakeryMembership(options.membership || options.workspace)) {
    const resolved = await resolveBakeryReportCategories(db);
    const names = (resolved.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
    const filter = bakeryMembershipSql(names, {
      alias: "p",
      kind: parseBakeryKind(options.kind, BAKERY_KIND_WORKSPACE),
    });
    return {
      mode: "bakery",
      sql: `${filter.sql}${search.sql}`,
      params: [...filter.params, ...search.params],
    };
  }
  return {
    mode: "retail",
    sql: ` AND COALESCE(p.inventory_scope, 'retail') = 'retail'${search.sql}`,
    params: [...search.params],
  };
}

export async function loadWarehouses(db) {
  return db.all("SELECT * FROM warehouses ORDER BY active DESC, id");
}

export function warehouseRoles(warehouses) {
  return {
    main: pickWarehouse(warehouses, "main"),
    returns: pickWarehouse(warehouses, "returns"),
  };
}

const STOCK_LINE_SELECT = `SELECT ? AS warehouse_id, ? AS warehouse_name, p.id AS product_id,
            p.name AS product_name, p.barcode, p.sku, p.stock AS quantity, p.cost,
            ROUND(p.stock * COALESCE(p.cost, 0), 2) AS value
       FROM products p`;

export async function catalogStockTotals(db, catalog) {
  return db.get(
    `SELECT COALESCE(SUM(p.stock), 0) AS total_qty,
            COALESCE(SUM(p.stock * COALESCE(p.cost, 0)), 0) AS total_value
       FROM products p
      WHERE 1=1${catalog.sql}`,
    catalog.params
  );
}

export async function catalogStockLines(db, warehouse, catalog, outsideByProduct = null) {
  if (!warehouse) return [];
  const rows = await db.all(
    `${STOCK_LINE_SELECT}
      WHERE ABS(COALESCE(p.stock, 0)) > ?${catalog.sql}
      ORDER BY p.name`,
    [warehouse.id, warehouse.name, QTY_EPS, ...catalog.params]
  );
  if (!outsideByProduct) return rows;
  const adjusted = [];
  for (const row of rows) {
    const away = num(outsideByProduct.get(Number(row.product_id)));
    const quantity = num(row.quantity) - away;
    if (Math.abs(quantity) <= QTY_EPS) continue;
    adjusted.push({
      ...row,
      quantity,
      value: round2(quantity * num(row.cost)),
    });
  }
  return adjusted;
}

/** Units sitting in transfer warehouses. Main and returns are overlaid separately. */
export async function quantitiesOutsideMain(db, catalog, excludeWarehouseIds) {
  const skip = [...new Set((excludeWarehouseIds || []).map((id) => Number(id)).filter(Boolean))];
  let sql = `SELECT ws.product_id, COALESCE(SUM(ws.quantity), 0) AS quantity
       FROM warehouse_stock ws
       JOIN products p ON p.id = ws.product_id
      WHERE 1=1${catalog.sql}`;
  const params = [...catalog.params];
  if (skip.length) {
    sql += ` AND ws.warehouse_id NOT IN (${skip.map(() => "?").join(",")})`;
    params.push(...skip);
  }
  sql += " GROUP BY ws.product_id";
  const rows = await db.all(sql, params);
  return new Map(rows.map((row) => [Number(row.product_id), num(row.quantity)]));
}

async function adjustedCatalogTotals(db, warehouse, catalog, outsideByProduct) {
  const lines = await catalogStockLines(db, warehouse, catalog, outsideByProduct);
  return {
    total_qty: lines.reduce((sum, row) => sum + num(row.quantity), 0),
    total_value: lines.reduce((sum, row) => round2(sum + num(row.value)), 0),
  };
}

export async function postedPurchaseReturnTotals(db, catalog) {
  return db.get(
    `SELECT COALESCE(SUM(${RETURN_QTY_SQL}), 0) AS total_qty,
            COALESCE(SUM(${RETURN_VALUE_SQL}), 0) AS total_value
       FROM purchase_return_items pri
       JOIN purchase_returns pr ON pr.id = pri.return_id
       JOIN products p ON p.id = pri.product_id
      WHERE pr.status = 'posted'${catalog.sql}`,
    catalog.params
  );
}

export async function postedPurchaseReturnLines(db, warehouse, catalog) {
  if (!warehouse) return [];
  return db.all(
    `SELECT ? AS warehouse_id, ? AS warehouse_name, p.id AS product_id,
            p.name AS product_name, p.barcode, p.sku,
            SUM(${RETURN_QTY_SQL}) AS quantity,
            p.cost,
            ROUND(SUM(${RETURN_VALUE_SQL}), 2) AS value
       FROM purchase_return_items pri
       JOIN purchase_returns pr ON pr.id = pri.return_id
       JOIN products p ON p.id = pri.product_id
      WHERE pr.status = 'posted'${catalog.sql}
      GROUP BY p.id, p.name, p.barcode, p.sku, p.cost
     HAVING ABS(SUM(${RETURN_QTY_SQL})) > ?
      ORDER BY p.name`,
    [warehouse.id, warehouse.name, ...catalog.params, QTY_EPS]
  );
}

export async function transferStockTotalsByWarehouse(db, catalog) {
  const rows = await db.all(
    `SELECT w.id AS warehouse_id,
            COALESCE(agg.total_qty, 0) AS total_qty,
            COALESCE(agg.total_value, 0) AS total_value
       FROM warehouses w
       LEFT JOIN (
         SELECT ws.warehouse_id,
                SUM(ws.quantity) AS total_qty,
                SUM(ws.quantity * COALESCE(p.cost, 0)) AS total_value
           FROM warehouse_stock ws
           JOIN products p ON p.id = ws.product_id
          WHERE 1=1${catalog.sql}
          GROUP BY ws.warehouse_id
       ) agg ON agg.warehouse_id = w.id`,
    catalog.params
  );
  return new Map(rows.map((r) => [Number(r.warehouse_id), r]));
}

export async function transferStockLines(db, { warehouseId = null, excludeIds = [], catalog } = {}) {
  let sql = `SELECT ws.warehouse_id, w.name AS warehouse_name, ws.product_id,
                    p.name AS product_name, p.barcode, p.sku, ws.quantity, p.cost,
                    ROUND(ws.quantity * COALESCE(p.cost, 0), 2) AS value
               FROM warehouse_stock ws
               JOIN warehouses w ON w.id = ws.warehouse_id
               JOIN products p ON p.id = ws.product_id
              WHERE ABS(ws.quantity) > ?${catalog?.sql || ""}`;
  const params = [QTY_EPS, ...(catalog?.params || [])];
  if (warehouseId) {
    sql += " AND ws.warehouse_id = ?";
    params.push(Number(warehouseId));
  }
  const skip = [...new Set((excludeIds || []).map((id) => Number(id)).filter(Boolean))];
  if (skip.length) {
    sql += ` AND ws.warehouse_id NOT IN (${skip.map(() => "?").join(",")})`;
    params.push(...skip);
  }
  sql += " ORDER BY w.name, p.name";
  return db.all(sql, params);
}

function mapValuationRow(warehouse, qty, value) {
  return {
    warehouse_id: warehouse.id,
    warehouse_name: warehouse.name,
    total_qty: num(qty),
    total_value: round2(value),
  };
}

export async function getWarehouseValuation(db, options = {}) {
  const catalog = await resolveWarehouseCatalog(db, options);
  const warehouses = await loadWarehouses(db);
  const { main, returns: returnsWh } = warehouseRoles(warehouses);
  const outside = await quantitiesOutsideMain(db, catalog, [main?.id]);
  const [catalogTotals, returns, transferMap] = await Promise.all([
    main ? adjustedCatalogTotals(db, main, catalog, outside) : Promise.resolve(null),
    postedPurchaseReturnTotals(db, catalog),
    transferStockTotalsByWarehouse(db, catalog),
  ]);

  const rows = warehouses.map((w) => {
    if (main && Number(w.id) === Number(main.id)) {
      return mapValuationRow(w, catalogTotals?.total_qty, catalogTotals?.total_value);
    }
    if (returnsWh && Number(w.id) === Number(returnsWh.id)) {
      const moved = transferMap.get(Number(returnsWh.id));
      return mapValuationRow(
        w,
        num(returns?.total_qty) + num(moved?.total_qty),
        round2(num(returns?.total_value) + num(moved?.total_value))
      );
    }
    const transferred = transferMap.get(Number(w.id));
    return mapValuationRow(w, transferred?.total_qty, transferred?.total_value);
  });

  rows.sort((a, b) => b.total_value - a.total_value || a.warehouse_id - b.warehouse_id);
  const grand = rows.reduce((s, r) => round2(s + r.total_value), 0);
  return { warehouses: rows, grand_total: round2(grand) };
}

export async function listWarehouseStock(db, options = {}) {
  const catalog = await resolveWarehouseCatalog(db, options);
  const warehouses = await loadWarehouses(db);
  const { main, returns: returnsWh } = warehouseRoles(warehouses);
  const warehouseId = options.warehouseId;
  const filterId = warehouseId != null && warehouseId !== "" ? Number(warehouseId) : null;
  const derivedIds = [];
  const lines = [];

  const includeMain = main && (filterId == null || filterId === Number(main.id));
  const includeReturns = returnsWh && (filterId == null || filterId === Number(returnsWh.id));

  const outside = await quantitiesOutsideMain(db, catalog, [main?.id]);
  if (includeMain) {
    derivedIds.push(main.id);
    lines.push(...(await catalogStockLines(db, main, catalog, outside)));
  }
  if (includeReturns) {
    lines.push(...(await postedPurchaseReturnLines(db, returnsWh, catalog)));
  }

  const extra = await transferStockLines(db, {
    warehouseId: filterId,
    excludeIds: derivedIds,
    catalog,
  });
  lines.push(...extra);
  return lines;
}

export async function listProductWarehouseLocations(db, productId) {
  const pid = Number(productId);
  if (!pid) return [];
  const product = await db.get(
    `SELECT id, stock, cost, COALESCE(inventory_scope, 'retail') AS inventory_scope
       FROM products WHERE id = ?`,
    [pid]
  );
  if (!product) return [];

  const warehouses = await loadWarehouses(db);
  const { main, returns: returnsWh } = warehouseRoles(warehouses);
  const out = [];
  const derivedIds = [];

  if (main) {
    derivedIds.push(Number(main.id));
    const awayRow = await db.get(
      `SELECT COALESCE(SUM(ws.quantity), 0) AS qty
         FROM warehouse_stock ws
         JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ws.product_id = ? AND w.id != ?`,
      [pid, main.id]
    );
    const qty = num(product.stock) - num(awayRow?.qty);
    if (Math.abs(qty) > QTY_EPS) {
      out.push({
        warehouse_id: main.id,
        warehouse_name: main.name,
        code: main.code,
        type: main.type,
        quantity: qty,
      });
    }
  }

  if (returnsWh) {
    derivedIds.push(Number(returnsWh.id));
    const ret = await db.get(
      `SELECT COALESCE(SUM(${RETURN_QTY_SQL}), 0) AS qty
         FROM purchase_return_items pri
         JOIN purchase_returns pr ON pr.id = pri.return_id
        WHERE pr.status = 'posted' AND pri.product_id = ?`,
      [pid]
    );
    const moved = await db.get(
      "SELECT COALESCE(quantity, 0) AS qty FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
      [returnsWh.id, pid]
    );
    const qty = num(ret?.qty) + num(moved?.qty);
    if (Math.abs(qty) > QTY_EPS) {
      out.push({
        warehouse_id: returnsWh.id,
        warehouse_name: returnsWh.name,
        code: returnsWh.code,
        type: returnsWh.type,
        quantity: qty,
      });
    }
  }

  const extra = await db.all(
    `SELECT w.id AS warehouse_id, w.name AS warehouse_name, w.code, w.type, ws.quantity
       FROM warehouse_stock ws
       JOIN warehouses w ON w.id = ws.warehouse_id
      WHERE ws.product_id = ? AND ABS(ws.quantity) > ?${
        derivedIds.length
          ? ` AND ws.warehouse_id NOT IN (${derivedIds.map(() => "?").join(",")})`
          : ""
      }
      ORDER BY w.name`,
    derivedIds.length ? [pid, QTY_EPS, ...derivedIds] : [pid, QTY_EPS]
  );
  out.push(...extra);
  return out;
}
