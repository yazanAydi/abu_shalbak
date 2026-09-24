/**
 * Inventory movement helpers.
 *
 * IMPORTANT — source of truth: `inventory_ledger` (see inventoryLedger.js) is
 * the authoritative stock history and the ONLY place that mutates
 * `products.stock`. The legacy `inventory_movements` table is read-only
 * history and is no longer written by new operations.
 *
 * `recordMovement` applies the stock delta through the ledger when
 * `applyStock` is true (`applyStockDelta` → `addLedgerEntry`). A single sale
 * produces exactly one stock delta and one ledger row.
 *
 * `quantity` is SIGNED: positive adds to stock, negative removes from stock.
 * These helpers assume the caller already opened a DB transaction (BEGIN).
 */

export const MOVEMENT_TYPES = [
  "sale",
  "refund",
  "purchase",
  "purchase_return",
  "adjust_in",
  "adjust_out",
  "damage",
  "consumption",
  "correction",
  "count",
  "transfer_in",
  "transfer_out",
  "opening",
];

import { addLedgerEntry } from "./inventoryLedger.js";

/** Map inventory_movements types to inventory_ledger types. */
const MOVEMENT_TO_LEDGER = {
  sale: "sale",
  refund: "refund",
  purchase: "purchase_receive",
  purchase_return: "supplier_return",
  adjust_in: "manual_adjustment",
  adjust_out: "manual_adjustment",
  damage: "expiry_writeoff",
  consumption: "manual_adjustment",
  correction: "manual_adjustment",
  count: "stock_count_correction",
  transfer_in: "warehouse_transfer_in",
  transfer_out: "warehouse_transfer_out",
  opening: "manual_adjustment",
};

/** Apply a signed delta to products.stock via immutable ledger. */
export async function applyStockDelta(
  db,
  productId,
  delta,
  {
    movementType = "manual_adjustment",
    referenceType = null,
    referenceId = null,
    userId = null,
    notes = null,
    storeId = 1,
    businessDay = null,
    warehouseId = null,
  } = {}
) {
  const pid = Number(productId);
  const d = Number(delta);
  if (!pid || !Number.isFinite(d) || d === 0) return null;

  const ledgerType = MOVEMENT_TO_LEDGER[movementType] || movementType;
  return addLedgerEntry(db, {
    productId: pid,
    movementType: ledgerType,
    delta: d,
    referenceType,
    referenceId,
    userId,
    notes,
    storeId,
    businessDay,
    warehouseId,
  });
}

/**
 * Insert one ledger row. Does NOT change products.stock by itself unless
 * `applyStock` is true (convenience for callers that want both in one call).
 */
export async function recordMovement(
  db,
  {
    productId,
    movementType,
    quantity,
    unitCost = null,
    warehouseId = null,
    refType = null,
    refId = null,
    notes = null,
    userId = null,
    applyStock = false,
    businessDay = null,
  }
) {
  const pid = Number(productId);
  const qty = Number(quantity);
  if (!pid || !Number.isFinite(qty) || qty === 0) return null;
  const type = MOVEMENT_TYPES.includes(movementType) ? movementType : "correction";

  if (applyStock) {
    await applyStockDelta(db, pid, qty, {
      movementType: type,
      referenceType: refType,
      referenceId: refId,
      userId,
      notes,
      businessDay,
      warehouseId,
    });
  }
  return null;
}
