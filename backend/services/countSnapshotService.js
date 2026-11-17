import { badRequest } from "../utils/httpError.js";
import { round6 } from "../utils/purchaseInventoryCost.js";
import { applyStockDelta } from "../utils/inventory.js";
import { addWarehouseQuantity, ensureMaterialized, locationRows, operationalWarehouses, NEEDS_RECONCILIATION } from "./warehouseBatchStock.js";
import { settleUndatedShortageLots } from "./stockSourceService.js";
import { recordBatchAllocation, moveUndatedOnMain } from "./stockBatchService.js";

/** Caller holds the posting transaction. Entered rows replace this warehouse's picture. */
export async function applyCountSnapshot(db, { productId, lines, sessionId, userId }) {
  const { main } = await operationalWarehouses(db);
  const product = await db.get("SELECT name, stock FROM products WHERE id = ?", [productId]);
  const legacyProductOnly = lines.length === 1 && !lines[0].batch_source
    && (!lines[0].warehouse_id || Number(lines[0].warehouse_id) === main?.id)
    && !(await db.get("SELECT id FROM product_batches WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != '' LIMIT 1", [productId]))
    && !(await db.get("SELECT id FROM warehouse_batch_stock WHERE product_id = ? AND warehouse_id != ? LIMIT 1", [productId, main?.id]));
  // Keep the established live-balance rule for a plain, undated product count.
  // Unlocated legacy balances retain their warehouse-reconciliation status/offsets.
  if (legacyProductOnly) {
    const counted = Number(lines[0].counted_qty);
    if (!Number.isFinite(counted) || counted < 0) throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
    const delta = counted - Number(product.stock);
    await db.run("UPDATE stock_count_lines SET system_qty = ?, variance = ? WHERE id = ?", [product.stock, delta, lines[0].id]);
    if (delta !== 0) {
      await moveUndatedOnMain(db, productId, delta);
      await applyStockDelta(db, productId, delta, { movementType: "count", referenceType: "stock_count_session", referenceId: sessionId, userId, notes: `جرد #${sessionId}` });
    }
    return;
  }
  const placed = await ensureMaterialized(db, productId);
  if (placed.mode === NEEDS_RECONCILIATION) {
    throw badRequest("حدد توزيع الصنف على المستودعات قبل ترحيل الجرد", "LOCATION_RECONCILIATION_REQUIRED");
  }
  const locations = await locationRows(db, productId);
  const liveTotal = round6(locations.reduce((sum, row) => sum + row.quantity, 0));
  if (Math.abs(liveTotal - Number(product.stock)) > 1e-6) {
    throw badRequest(`تغير رصيد ${product.name} منذ حفظ الجرد. حدّث الكميات وأعد الجرد قبل الترحيل.`, "STALE_COUNT");
  }
  const groups = new Map();
  for (const line of lines) {
    const warehouseId = Number(line.warehouse_id) || main?.id;
    if (!warehouseId || !(await db.get("SELECT id FROM warehouses WHERE id = ? AND active = 1", [warehouseId]))) {
      throw badRequest("المستودع غير صالح", "WAREHOUSE_NOT_FOUND");
    }
    const list = groups.get(warehouseId) || [];
    list.push(line);
    groups.set(warehouseId, list);
  }
  let countedCompanyTotal = liveTotal;
  for (const [warehouseId, rows] of groups) {
    const current = new Map(locations.filter((row) => row.warehouse_id === warehouseId).map((row) => [row.expiry_date || "", row.quantity]));
    const target = new Map();
    for (const row of rows) {
      if (row.stock_source_snapshot) {
        const saved = new Map(JSON.parse(row.stock_source_snapshot));
        if ([...new Set([...saved.keys(), ...current.keys()])].some((key) => Math.abs((saved.get(key) || 0) - (current.get(key) || 0)) > 1e-6)) {
          throw badRequest(`تغير رصيد ${product.name} منذ حفظ الجرد. حدّث الكميات وأعد الجرد قبل الترحيل.`, "STALE_COUNT");
        }
      }
      const key = row.batch_source === "dated" ? row.expiry_date : "";
      if (target.has(key)) throw badRequest("سطر مكرر لنفس الصنف وتاريخ الصلاحية. لن يُحسب الجرد مرتين", "DUPLICATE_SOURCE");
      const before = current.get(key) || 0;
      if (Math.abs(before - Number(row.system_qty)) > 1e-6) {
        throw badRequest(`تغير رصيد ${product.name} منذ حفظ الجرد. حدّث الكميات وأعد الجرد قبل الترحيل.`, "STALE_COUNT");
      }
      const quantity = Number(row.counted_qty);
      if (!Number.isFinite(quantity) || quantity < 0) throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
      target.set(key, round6(quantity));
      await db.run("UPDATE stock_count_lines SET variance = ? WHERE id = ?", [round6(quantity - before), row.id]);
    }
    const changes = [...new Set([...current.keys(), ...target.keys()])].map((expiry) => ({
      expiry, delta: round6((target.get(expiry) || 0) - (current.get(expiry) || 0)),
    })).filter((row) => row.delta !== 0);
    const pool = [];
    const record = async (parts, direction) => {
      for (const part of parts) await recordBatchAllocation(db, part, { productId, direction, referenceType: "stock_count", referenceId: sessionId, warehouseId });
    };
    // Take reductions first, retaining supplier/receipt identity when dates are corrected.
    for (const change of changes.filter((row) => row.delta < 0)) {
      const parts = await addWarehouseQuantity(db, { warehouseId, productId, expiryDate: change.expiry, delta: change.delta });
      pool.push(...parts.map((part) => ({ ...part, remaining: part.quantity })));
      await record(parts, "out");
    }
    for (const change of changes.filter((row) => row.delta > 0)) {
      let remaining = change.delta;
      for (const part of pool) {
        const quantity = round6(Math.min(remaining, part.remaining));
        if (quantity <= 0) continue;
        const added = await addWarehouseQuantity(db, { warehouseId, productId, expiryDate: change.expiry, delta: quantity, source: part });
        await record(added, "in");
        remaining = round6(remaining - quantity);
        part.remaining = round6(part.remaining - quantity);
      }
      if (remaining > 0) {
        const added = await addWarehouseQuantity(db, { warehouseId, productId, expiryDate: change.expiry, delta: remaining, source: { provenance: "unknown" } });
        await record(added, "in");
      }
    }
    await settleUndatedShortageLots(db, productId, warehouseId);
    const warehouseTotal = round6([...target.values()].reduce((sum, value) => sum + value, 0));
    countedCompanyTotal = round6(countedCompanyTotal + warehouseTotal - [...current.values()].reduce((sum, value) => sum + value, 0));
    if (warehouseTotal === 0) await db.run("DELETE FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?", [warehouseId, productId]);
    else await db.run(`INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(warehouse_id, product_id) DO UPDATE SET quantity = excluded.quantity`, [warehouseId, productId, warehouseTotal]);
    for (const change of changes) {
      if (!change.expiry) continue;
      const batch = await db.get("SELECT id FROM product_batches WHERE product_id = ? AND expiry_date = ? ORDER BY id LIMIT 1", [productId, change.expiry]);
      if (batch) await db.run("UPDATE product_batches SET quantity = quantity + ? WHERE id = ?", [change.delta, batch.id]);
      else await db.run("INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, ?, ?)", [productId, change.expiry, change.delta]);
    }
  }
  const stockDelta = countedCompanyTotal - Number(product.stock);
  if (stockDelta !== 0) await applyStockDelta(db, productId, stockDelta, {
    movementType: "count", referenceType: "stock_count_session", referenceId: sessionId,
    userId, notes: `جرد #${sessionId}`,
  });
}
