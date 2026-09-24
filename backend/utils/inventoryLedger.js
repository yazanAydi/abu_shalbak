import { syncDepletionAdjustment } from "./warehouseValuationHistory.js";
import { businessDayFromTimestamp } from "./businessDay.js";
import { isProductCostKnown } from "./productUnits.js";
import { round2 } from "./money.js";
import { getAppSettings } from "./settings.js";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Immutable inventory ledger — every stock change creates a ledger entry.
 *
 * SOURCE OF TRUTH: `inventory_ledger` is the authoritative, append-only history
 * of stock movements. `products.stock` is a live cache that this module keeps
 * in sync via the atomic `UPDATE products SET stock = stock + ?`. Overselling
 * is allowed and stock may go negative; the ledger records the requested
 * delta with qty_before / qty_after for every change.
 *
 * `inventory_movements` (see utils/inventory.js) is a SECONDARY/legacy analytics
 * log written only by `recordMovement`. It does NOT mutate stock and is not the
 * source of truth — always reconcile against `inventory_ledger`.
 */

export const LEDGER_MOVEMENT_TYPES = [
  "sale",
  "refund",
  "purchase_receive",
  "supplier_return",
  "manual_adjustment",
  "warehouse_transfer_in",
  "warehouse_transfer_out",
  "stock_count_correction",
  "expiry_writeoff",
];

/**
 * Apply stock delta and record immutable ledger entry.
 * Must be called inside an open DB transaction.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.productId
 * @param {string} opts.movementType
 * @param {number} opts.delta Signed quantity change (+ in, - out)
 * @param {string} [opts.referenceType]
 * @param {number} [opts.referenceId]
 * @param {number} [opts.userId]
 * @param {string} [opts.notes]
 * @param {number} [opts.storeId]
 * @param {string} [opts.businessDay] YYYY-MM-DD accounting day. Date-only
 *   document dates are stored as given (no cutoff). When omitted, the shop
 *   business day of the posting instant is stored.
 * @param {number} [opts.warehouseId]
 */
export async function addLedgerEntry(
  db,
  {
    productId,
    movementType,
    delta,
    referenceType = null,
    referenceId = null,
    userId = null,
    notes = null,
    storeId = 1,
    businessDay = null,
    warehouseId = null,
  }
) {
  const pid = Number(productId);
  const d = Number(delta);
  if (!pid || !Number.isFinite(d) || d === 0) return null;

  const type = LEDGER_MOVEMENT_TYPES.includes(movementType)
    ? movementType
    : "manual_adjustment";

  const product = await db.get("SELECT stock FROM products WHERE id = ?", [pid]);
  if (!product) {
    throw new Error(`Product not found: ${pid}`);
  }

  const qtyBefore = Number(product.stock) || 0;
  const qtyAfter = qtyBefore + d;
  const effectiveDelta = d;

  if (effectiveDelta !== 0) {
    await db.run("UPDATE products SET stock = stock + ? WHERE id = ?", [effectiveDelta, pid]);
  }

  const snap = await db.get(
    `SELECT cost, cost_known, inventory_scope, category FROM products WHERE id = ?`,
    [pid]
  );
  const known = isProductCostKnown(snap);
  let day = typeof businessDay === "string" && YMD_RE.test(businessDay.trim()) ? businessDay.trim() : null;
  if (!day) {
    const settings = await getAppSettings(db);
    day = businessDayFromTimestamp(new Date().toISOString(), settings.business_day_cutoff_hour);
  }
  const wh = warehouseId != null && Number(warehouseId) > 0 ? Number(warehouseId) : null;

  const ins = await db.run(
    `INSERT INTO inventory_ledger
       (product_id, movement_type, quantity_delta, qty_before, qty_after,
        reference_type, reference_id, notes, user_id, store_id,
        business_day, unit_cost_after, cost_known, inventory_scope, category, warehouse_id, value_adjustment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      pid,
      type,
      effectiveDelta,
      qtyBefore,
      qtyAfter,
      referenceType,
      referenceId != null ? Number(referenceId) : null,
      notes,
      userId != null ? Number(userId) : null,
      storeId != null ? Number(storeId) : 1,
      day,
      known ? round2(Number(snap?.cost) || 0) : null,
      known ? 1 : 0,
      snap?.inventory_scope != null ? String(snap.inventory_scope) : "retail",
      snap?.category != null ? String(snap.category) : null,
      wh,
    ]
  );

  await syncDepletionAdjustment(db, {
    productId: pid,
    ledgerId: ins.lastID,
    qtyBefore,
    qtyAfter,
    movementType: type,
  });

  return { ledgerId: ins.lastID, qtyBefore, qtyAfter };
}

/**
 * Derive current stock from ledger sum (verification / reporting).
 */
export async function deriveStockFromLedger(db, productId) {
  const row = await db.get(
    "SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM inventory_ledger WHERE product_id = ?",
    [Number(productId)]
  );
  return Number(row?.total) || 0;
}
