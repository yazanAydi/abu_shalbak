/**
 * Office expiry-report cycle.
 *
 * A reset hides the dates that were already on hand. It does not delete
 * products, batches, dates, ledger rows, or money. A posted stock count
 * brings a date back only when that line explicitly verifies it. A new
 * date that was not in the snapshot stays visible once any verified count
 * has reopened the scope. Older stock that the count verified stays visible
 * with its live quantity.
 */

import { shopTodayYmd } from "../utils/shopTime.js";
import { normalizeExpiryDate } from "../utils/expiryDate.js";
import { operationalWarehouses } from "./warehouseBatchStock.js";
import { round6 } from "../utils/purchaseInventoryCost.js";
import { parseCountDepartment } from "../utils/countDepartment.js";

export const EXPIRY_REPORT_AWAITING_MESSAGE =
  "تمت إعادة ضبط تقرير الصلاحية. بانتظار اعتماد جرد بكميات وتواريخ صلاحية صحيحة.";

const EPS = 1e-9;

export function parseExpiryReportScope(value) {
  return parseCountDepartment(value);
}

function scopeOf(value) {
  return String(value || "retail").trim().toLowerCase() === "bakery" ? "bakery" : "retail";
}

function expiryKey(value) {
  return normalizeExpiryDate(value) || "";
}

export async function resetExpiryReportCycle(db, { scope, reason, userId }) {
  const parsed = parseExpiryReportScope(scope);
  if (!parsed) {
    const err = new Error("حدد نطاق التقرير");
    err.status = 400;
    err.code = "SCOPE_REQUIRED";
    throw err;
  }
  const now = new Date().toISOString();
  const businessDay = shopTodayYmd();
  await db.run(
    `UPDATE expiry_report_cycles
        SET status = 'closed', closed_at = ?
      WHERE scope = ? AND status = 'open'`,
    [now, parsed]
  );
  const ins = await db.run(
    `INSERT INTO expiry_report_cycles
       (scope, status, reset_at, reset_by, reset_reason, business_day)
     VALUES (?, 'open', ?, ?, ?, ?)`,
    [parsed, now, userId ?? null, String(reason).trim(), businessDay]
  );
  const excluded = await snapshotExclusions(db, ins.lastID, parsed);
  return {
    id: ins.lastID,
    scope: parsed,
    reset_at: now,
    business_day: businessDay,
    reason: String(reason).trim(),
    excluded,
  };
}

async function snapshotExclusions(db, cycleId, scope) {
  const { main } = await operationalWarehouses(db);
  const mainId = Number(main?.id) || 0;
  const products = await db.all(
    `SELECT id, stock, expiry_date
       FROM products
      WHERE COALESCE(inventory_scope, 'retail') = ?`,
    [scope]
  );
  if (!products.length) return 0;
  const productIds = new Set(products.map((row) => Number(row.id)));
  const batches = await db.all(
    `SELECT b.product_id, b.expiry_date, b.quantity
       FROM product_batches b
       JOIN products p ON p.id = b.product_id
      WHERE COALESCE(p.inventory_scope, 'retail') = ?
        AND b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
        AND b.quantity > ?`,
    [scope, EPS]
  );
  const locations = await db.all(
    `SELECT w.product_id, w.warehouse_id, w.expiry_date, w.quantity
       FROM warehouse_batch_stock w
       JOIN products p ON p.id = w.product_id
      WHERE COALESCE(p.inventory_scope, 'retail') = ?
        AND w.quantity > ?`,
    [scope, EPS]
  );
  const locsByProduct = new Map();
  for (const loc of locations) {
    const id = Number(loc.product_id);
    const list = locsByProduct.get(id) || [];
    list.push(loc);
    locsByProduct.set(id, list);
  }
  const datedSum = new Map();
  let inserted = 0;
  const seen = new Set();
  async function add(productId, warehouseId, source, expiry) {
    const key = `${productId}|${warehouseId}|${source}|${expiry}`;
    if (seen.has(key)) return;
    seen.add(key);
    const result = await db.run(
      `INSERT OR IGNORE INTO expiry_report_exclusions
         (cycle_id, scope, product_id, warehouse_id, source, expiry_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'excluded')`,
      [cycleId, scope, productId, warehouseId, source, expiry]
    );
    inserted += Number(result?.changes) || 0;
  }

  for (const batch of batches) {
    const productId = Number(batch.product_id);
    if (!productIds.has(productId)) continue;
    const expiry = expiryKey(batch.expiry_date);
    if (!expiry) continue;
    datedSum.set(productId, round6((datedSum.get(productId) || 0) + (Number(batch.quantity) || 0)));
    const placed = (locsByProduct.get(productId) || []).filter(
      (loc) => expiryKey(loc.expiry_date) === expiry && Number(loc.quantity) > EPS
    );
    const warehouses = placed.length
      ? [...new Set(placed.map((loc) => Number(loc.warehouse_id)))]
      : [mainId];
    for (const warehouseId of warehouses) {
      await add(productId, warehouseId, "batch", expiry);
    }
  }

  for (const product of products) {
    const productId = Number(product.id);
    const expiry = expiryKey(product.expiry_date);
    if (!expiry) continue;
    const undated = round6((Number(product.stock) || 0) - (datedSum.get(productId) || 0));
    if (!(undated > EPS)) continue;
    const placed = (locsByProduct.get(productId) || []).filter(
      (loc) => !expiryKey(loc.expiry_date) && Number(loc.quantity) > EPS
    );
    const warehouses = placed.length
      ? [...new Set(placed.map((loc) => Number(loc.warehouse_id)))]
      : [mainId];
    for (const warehouseId of warehouses) {
      await add(productId, warehouseId, "product", expiry);
    }
  }
  return inserted;
}

async function excludedStockRemains(db, cycleId) {
  const row = await db.get(
    `SELECT 1 AS hit
       FROM expiry_report_exclusions e
      WHERE e.cycle_id = ? AND e.status = 'excluded'
        AND (
          (e.source = 'batch' AND EXISTS (
            SELECT 1 FROM product_batches b
             WHERE b.product_id = e.product_id
               AND TRIM(b.expiry_date) = e.expiry_date
               AND b.quantity > ?
          ))
          OR
          (e.source = 'product' AND EXISTS (
            SELECT 1 FROM products p
             WHERE p.id = e.product_id
               AND TRIM(COALESCE(p.expiry_date, '')) = e.expiry_date
               AND (
                 p.stock - COALESCE((
                   SELECT SUM(b.quantity) FROM product_batches b
                    WHERE b.product_id = p.id
                      AND b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
                 ), 0)
               ) > ?
          ))
        )
      LIMIT 1`,
    [cycleId, EPS, EPS]
  );
  return Boolean(row);
}

export async function getExpiryReportCycle(db, scope) {
  const parsed = parseExpiryReportScope(scope);
  if (!parsed) {
    const err = new Error("حدد نطاق التقرير");
    err.status = 400;
    err.code = "SCOPE_REQUIRED";
    throw err;
  }
  const cycle = await db.get(
    `SELECT c.*, u.username AS reset_by_name
       FROM expiry_report_cycles c
       LEFT JOIN users u ON u.id = c.reset_by
      WHERE c.scope = ? AND c.status = 'open'
      ORDER BY c.id DESC
      LIMIT 1`,
    [parsed]
  );
  if (!cycle) {
    return {
      scope: parsed,
      status: "active",
      message: null,
      cycle_open: false,
    };
  }
  const verified = await db.get(
    "SELECT COUNT(*) AS n FROM expiry_report_verifications WHERE cycle_id = ?",
    [cycle.id]
  );
  const verifiedLines = Number(verified?.n) || 0;
  let status = "awaiting_count";
  if (verifiedLines > 0) {
    status = (await excludedStockRemains(db, cycle.id)) ? "partial" : "active";
  }
  return {
    scope: parsed,
    status,
    message: status === "active" ? null : EXPIRY_REPORT_AWAITING_MESSAGE,
    cycle_open: true,
    cycle_id: cycle.id,
    reset_at: cycle.reset_at,
    reset_by: cycle.reset_by,
    reset_by_name: cycle.reset_by_name || null,
    reset_reason: cycle.reset_reason,
    business_day: cycle.business_day,
    verified_lines: verifiedLines,
  };
}

export async function getExpiryReportCycleMap(db) {
  const [retail, bakery] = await Promise.all([
    getExpiryReportCycle(db, "retail"),
    getExpiryReportCycle(db, "bakery"),
  ]);
  const hold = [retail, bakery].find((cycle) => cycle.status !== "active");
  return {
    retail,
    bakery,
    message: hold ? EXPIRY_REPORT_AWAITING_MESSAGE : null,
  };
}

async function loadFilterState(db) {
  const cycles = await db.all(
    "SELECT id, scope FROM expiry_report_cycles WHERE status = 'open'"
  );
  if (!cycles.length) return null;
  const byScope = new Map();
  let needsLocations = false;
  for (const cycle of cycles) {
    const verified = await db.get(
      "SELECT COUNT(*) AS n FROM expiry_report_verifications WHERE cycle_id = ?",
      [cycle.id]
    );
    const holdAll = (Number(verified?.n) || 0) === 0;
    const exclusions = holdAll
      ? []
      : await db.all(
        `SELECT product_id, warehouse_id, source, expiry_date, status
           FROM expiry_report_exclusions
          WHERE cycle_id = ?`,
        [cycle.id]
      );
    if (!holdAll) needsLocations = true;
    byScope.set(cycle.scope, { holdAll, exclusions });
  }
  let locations = [];
  if (needsLocations) {
    locations = await db.all(
      `SELECT product_id, warehouse_id, expiry_date, quantity
         FROM warehouse_batch_stock
        WHERE quantity > ?`,
      [EPS]
    );
  }
  const locationsByProduct = new Map();
  for (const loc of locations) {
    const id = Number(loc.product_id);
    const list = locationsByProduct.get(id) || [];
    list.push(loc);
    locationsByProduct.set(id, list);
  }
  return { byScope, locationsByProduct };
}

function includedQuantity(row, cycle, locationsByProduct) {
  const source = row.source === "batch" ? "batch" : "product";
  const expiry = expiryKey(row.expiry_date);
  const productId = Number(row.product_id);
  const live = Number(row.stock) || 0;
  const relevant = cycle.exclusions.filter((item) => (
    Number(item.product_id) === productId
    && item.source === source
    && item.expiry_date === expiry
  ));
  if (!relevant.length) {
    if (source === "product") {
      const pending = cycle.exclusions.some((item) => (
        Number(item.product_id) === productId
        && item.source === "product"
        && item.status !== "verified"
      ));
      if (pending) return 0;
    }
    return live;
  }
  if (!relevant.some((item) => item.status !== "verified")) return live;
  const locs = (locationsByProduct.get(productId) || []).filter((loc) => {
    if (!(Number(loc.quantity) > EPS)) return false;
    if (source === "batch") return expiryKey(loc.expiry_date) === expiry;
    return !expiryKey(loc.expiry_date);
  });
  if (!locs.length) return 0;
  const verifiedWarehouses = new Set(
    relevant.filter((item) => item.status === "verified").map((item) => Number(item.warehouse_id))
  );
  let sum = 0;
  for (const loc of locs) {
    if (verifiedWarehouses.has(Number(loc.warehouse_id))) sum = round6(sum + (Number(loc.quantity) || 0));
  }
  return sum;
}

export async function applyExpiryCycleToReportRows(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const state = await loadFilterState(db);
  if (!state) return list;
  const out = [];
  for (const row of list) {
    const scope = scopeOf(row.inventory_scope);
    const cycle = state.byScope.get(scope);
    if (!cycle) {
      out.push(row);
      continue;
    }
    if (cycle.holdAll) continue;
    const stock = includedQuantity(row, cycle, state.locationsByProduct);
    if (!(stock > EPS)) continue;
    out.push(stock === Number(row.stock) ? row : { ...row, stock });
  }
  return out;
}

export async function filterNearExpiryItems(db, { products = [], batches = [] } = {}) {
  const wrapped = [
    ...products.map((row, index) => ({
      product_id: row.id,
      inventory_scope: row.inventory_scope || "retail",
      source: "product",
      expiry_date: row.expiry_date,
      stock: Number(row.stock) || 0,
      _index: index,
      _kind: "product",
    })),
    ...batches.map((row, index) => ({
      product_id: row.product_id,
      inventory_scope: row.inventory_scope || "retail",
      source: "batch",
      expiry_date: row.expiry_date,
      stock: Number(row.quantity) || 0,
      _index: index,
      _kind: "batch",
    })),
  ];
  const visible = await applyExpiryCycleToReportRows(db, wrapped);
  const nextProducts = [];
  const nextBatches = [];
  for (const row of visible) {
    if (row._kind === "product") {
      nextProducts.push({ ...products[row._index], stock: row.stock });
    } else {
      nextBatches.push({ ...batches[row._index], quantity: row.stock });
    }
  }
  return { products: nextProducts, batches: nextBatches };
}

/**
 * A posted count line verifies a date only when expiry_verified is set on a
 * dated line. Quantity-only and undated lines do not release a snapshot.
 * Safe to call again: the verification key is unique per session and line.
 */
export async function recordCountExpiryBaseline(db, { sessionId, department, lines }) {
  const dated = (lines || []).filter((line) => (
    Number(line.expiry_verified) === 1
    && line.batch_source === "dated"
    && expiryKey(line.expiry_date)
  ));
  if (!dated.length) return { verified: 0 };
  const { main } = await operationalWarehouses(db);
  const mainId = Number(main?.id) || 0;
  const now = new Date().toISOString();
  let verified = 0;
  for (const line of dated) {
    const product = await db.get(
      "SELECT COALESCE(inventory_scope, 'retail') AS inventory_scope FROM products WHERE id = ?",
      [line.product_id]
    );
    const scope = scopeOf(product?.inventory_scope);
    if (department && scope !== department) continue;
    const cycle = await db.get(
      "SELECT id FROM expiry_report_cycles WHERE scope = ? AND status = 'open'",
      [scope]
    );
    if (!cycle) continue;
    const warehouseId = Number(line.warehouse_id) || mainId;
    const expiry = expiryKey(line.expiry_date);
    const inserted = await db.run(
      `INSERT OR IGNORE INTO expiry_report_verifications
         (cycle_id, session_id, product_id, warehouse_id, expiry_date, counted_qty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cycle.id, sessionId, line.product_id, warehouseId, expiry, Number(line.counted_qty) || 0, now]
    );
    await db.run(
      `UPDATE expiry_report_exclusions
          SET status = 'verified', verified_session_id = ?, verified_at = ?
        WHERE cycle_id = ? AND product_id = ? AND warehouse_id = ?
          AND source = 'batch' AND expiry_date = ? AND status = 'excluded'`,
      [sessionId, now, cycle.id, line.product_id, warehouseId, expiry]
    );
    verified += Number(inserted?.changes) || 0;
  }
  return { verified };
}
