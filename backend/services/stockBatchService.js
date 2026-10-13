/**
 * Dated stock lots live on `product_batches` (YYYY-MM-DD expiry).
 * Unknown-expiry remainder is derived: products.stock − sum(dated batch qty).
 * Sales never rewrite a lot's expiry date.
 */

import { round6 } from "../utils/purchaseInventoryCost.js";
import { badRequest } from "../utils/httpError.js";
import { recordMovement } from "../utils/inventory.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import {
  addWarehouseQuantity,
  clearExpiryLocations,
  clearProductLocations,
  ensureMaterialized,
  NEEDS_RECONCILIATION,
  operationalWarehouses,
  planSellableAllocations,
  locationRows,
} from "./warehouseBatchStock.js";
import { addSourceIdentity, listSourceLots, takeSourceLots } from "./stockSourceService.js";
import { getAppSettings } from "../utils/settings.js";
import {
  daysUntilExpiry,
  interpretExpiryInput,
  normalizeExpiryDate,
  parsePreferredExpiry,
  PREFERRED_AUTO,
  PREFERRED_UNKNOWN,
  UNKNOWN_EXPIRY_LABEL,
} from "../utils/expiryDate.js";

export { PREFERRED_AUTO, PREFERRED_UNKNOWN, UNKNOWN_EXPIRY_LABEL };

function isDatedExpiry(value) {
  return Boolean(normalizeExpiryDate(value));
}

export async function getProductStock(db, productId) {
  const row = await db.get("SELECT stock FROM products WHERE id = ?", [Number(productId)]);
  return Number(row?.stock) || 0;
}

export async function listDatedBatches(db, productId) {
  const pid = Number(productId);
  if (!pid) return [];
  const rows = await db.all(
    `SELECT id, product_id, batch_no, expiry_date, quantity, cost, notes, created_at
       FROM product_batches
      WHERE product_id = ?
        AND expiry_date IS NOT NULL
        AND TRIM(expiry_date) != ''
      ORDER BY expiry_date ASC, id ASC`,
    [pid]
  );
  return rows.map((r) => ({
    ...r,
    expiry_date: normalizeExpiryDate(r.expiry_date),
    quantity: round6(Number(r.quantity) || 0),
  }));
}

export function datedQuantitySum(batches) {
  return round6((batches || []).reduce((s, b) => s + (Number(b.quantity) || 0), 0));
}

export function unknownQuantityFromStock(stock, datedSum) {
  return round6((Number(stock) || 0) - (Number(datedSum) || 0));
}

function batchStatus(daysRemaining, nearDays) {
  if (daysRemaining == null) {
    return { status: "unknown", status_label: UNKNOWN_EXPIRY_LABEL };
  }
  if (daysRemaining < 0) {
    return { status: "expired", status_label: "منتهي الصلاحية" };
  }
  if (daysRemaining <= nearDays) {
    return { status: "near", status_label: "قريب الانتهاء" };
  }
  return { status: "ok", status_label: "ساري" };
}

export async function resolveNearExpiryDays(db) {
  const settings = await getAppSettings(db);
  const n = Number(settings.expiry_alert_days);
  return Number.isFinite(n) && n > 0 ? Math.min(365, Math.floor(n)) : 7;
}

export async function listStockBatches(db, productId) {
  const pid = Number(productId);
  const today = shopTodayYmd();
  const nearDays = await resolveNearExpiryDays(db);
  const stock = await getProductStock(db, pid);
  const dated = await listDatedBatches(db, pid);
  const datedSum = datedQuantitySum(dated);
  const unknownQty = unknownQuantityFromStock(stock, datedSum);

  const rows = dated
    .filter((b) => b.quantity !== 0)
    .map((b) => {
      const days = daysUntilExpiry(b.expiry_date, today);
      const st = batchStatus(days, nearDays);
      return {
        id: b.id,
        product_id: pid,
        batch_no: b.batch_no,
        expiry_date: b.expiry_date,
        quantity: b.quantity,
        cost: b.cost,
        notes: b.notes,
        created_at: b.created_at,
        days_remaining: days,
        virtual: false,
        ...st,
      };
    });

  const unknownStatus = batchStatus(null, nearDays);
  rows.push({
    id: null,
    product_id: pid,
    batch_no: null,
    expiry_date: null,
    quantity: unknownQty,
    cost: null,
    notes: null,
    created_at: null,
    days_remaining: null,
    virtual: true,
    ...unknownStatus,
  });

  return {
    product_id: pid,
    product_stock: stock,
    dated_sum: datedSum,
    unknown_quantity: unknownQty,
    near_expiry_days: nearDays,
    rows,
  };
}

/**
 * Physical sources for an issue or a count.
 * Dated rows include quantity zero so a count can record an explicit zero.
 * Undated quantity is the raw remainder and may be negative; it is not clamped.
 */
export async function listPhysicalSources(db, productId) {
  const pid = Number(productId);
  const dated = await listDatedBatches(db, pid);
  const stock = await getProductStock(db, pid);
  const datedSum = datedQuantitySum(dated);
  const unknown = unknownQuantityFromStock(stock, datedSum);
  const hasDated = dated.length > 0;
  return {
    product_id: pid,
    has_dated_batches: hasDated,
    product_stock: stock,
    dated_sum: datedSum,
    unknown_quantity: unknown,
    inconsistent: unknown < -1e-9,
    inconsistency_message: unknown < -1e-9
      ? "كميات الدفعات أكبر من رصيد الصنف. أكمل جرداً لكل مصدر لتصحيح الرصيد."
      : null,
    sources: hasDated
      ? [
          ...dated.map((b) => ({
            batch_source: "dated",
            expiry_date: b.expiry_date,
            quantity: b.quantity,
            batch_id: b.id,
            batch_no: b.batch_no,
          })),
          {
            batch_source: "undated",
            expiry_date: null,
            quantity: unknown,
            batch_id: null,
            batch_no: null,
          },
        ]
      : [],
  };
}

function sourceKey(batchSource, expiryDate) {
  if (batchSource === "dated") return `dated:${normalizeExpiryDate(expiryDate) || ""}`;
  if (batchSource === "undated") return "undated";
  return "product";
}

/**
 * Remove quantity from one named lot. Does not clamp the remainder to zero
 * and does not choose another lot.
 */
export async function takeExactDatedQuantity(db, productId, expiryDate, quantity) {
  const ymd = normalizeExpiryDate(expiryDate);
  const want = round6(quantity);
  if (!ymd) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
  if (!(want > 0)) throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  const placed = await ensureMaterialized(db, productId);
  const existing = await findDatedBatch(db, productId, ymd);
  if (!existing) throw badRequest("الدفعة غير موجودة", "BATCH_NOT_FOUND");
  const have = round6(Number(existing.quantity) || 0);
  if (have + 1e-9 < want) {
    throw badRequest("الكمية غير متاحة في هذه الدفعة", "INSUFFICIENT_BATCH");
  }
  let parts = [];
  if (placed.mode !== NEEDS_RECONCILIATION) {
    const { main } = await operationalWarehouses(db);
    if (!main) throw badRequest("المخزن الرئيسي غير موجود", "WAREHOUSE_NOT_OPERATIONAL");
    parts = await addWarehouseQuantity(db, {
      warehouseId: main.id,
      productId,
      expiryDate: ymd,
      delta: -want,
    });
  }
  await db.run("UPDATE product_batches SET quantity = quantity - ? WHERE id = ?", [want, existing.id]);
  return { expiry_date: ymd, quantity: want, batch_id: existing.id, parts };
}

export async function assertUndatedAvailable(db, productId, quantity) {
  const want = round6(quantity);
  if (!(want > 0)) throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  const placed = await ensureMaterialized(db, productId);
  if (placed.mode === NEEDS_RECONCILIATION) {
    throw badRequest("هذا الصنف بانتظار جرد المستودع قبل تحريك الكمية", "RECONCILIATION_REQUIRED");
  }
  const { main } = await operationalWarehouses(db);
  const rows = main ? await locationRows(db, productId, main.id) : [];
  const have = round6(rows.find((row) => !row.expiry_date)?.quantity || 0);
  if (have + 1e-9 < want) {
    throw badRequest("الكمية غير متاحة في المخزون غير المحدد", "INSUFFICIENT_UNDATED");
  }
  return want;
}

export async function moveUndatedOnMain(db, productId, delta, source = null) {
  const placed = await ensureMaterialized(db, productId);
  if (placed.mode === NEEDS_RECONCILIATION) return [];
  const { main } = await operationalWarehouses(db);
  if (!main) return [];
  return addWarehouseQuantity(db, {
    warehouseId: main.id,
    productId,
    expiryDate: null,
    delta,
    source,
  });
}

const EXPLICIT_ADJUSTMENT_TYPES = new Set(["damage", "out", "correction"]);

/**
 * Apply one stock-adjustment line to batches.
 * Damage, out, and correction use the source the user named.
 * Consumption follows the same earliest-expiry rule as a sale and shop consumption.
 * An inbound line with an expiry increases that lot; without one it stays undated.
 */
export async function applyStockAdjustmentBatches(db, {
  productId,
  adjustmentType,
  delta,
  batchSource = null,
  expiryDate = null,
  referenceId = null,
}) {
  const change = round6(delta);
  if (!Number.isFinite(change) || change === 0) {
    throw badRequest("كمية غير صالحة", "VALIDATION_ERROR");
  }
  const source = batchSource == null || String(batchSource).trim() === "" ? null : String(batchSource).trim();
  const rawExpiry = expiryDate == null || String(expiryDate).trim() === "" ? null : String(expiryDate).trim();

  if (adjustmentType === "consumption") {
    await applyOutboundBatches(db, {
      productId,
      quantity: round6(Math.abs(change)),
      referenceType: "stock_adjustment",
      referenceId,
    });
    return { batch_source: null, expiry_date: null };
  }

  if (adjustmentType === "in") {
    const add = round6(Math.abs(change));
    const parsed = interpretExpiryInput(rawExpiry);
    if (!parsed.ok) throw badRequest("تاريخ الصلاحية غير صالح", "INVALID_EXPIRY");
    const ymd = parsed.date;
    if (ymd) {
      await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: add });
      await recordBatchAllocation(db, { expiry_date: ymd, quantity: add }, {
        productId, direction: "in", referenceType: "stock_adjustment", referenceId,
      });
      return { batch_source: "dated", expiry_date: ymd };
    }
    await moveUndatedOnMain(db, productId, add);
    await recordBatchAllocation(db, { expiry_date: null, quantity: add }, {
      productId, direction: "in", referenceType: "stock_adjustment", referenceId,
    });
    return { batch_source: null, expiry_date: null };
  }

  if (!EXPLICIT_ADJUSTMENT_TYPES.has(adjustmentType)) {
    throw badRequest("نوع التسوية غير صالح", "VALIDATION_ERROR");
  }

  const picture = await listPhysicalSources(db, productId);
  if (!picture.has_dated_batches) {
    if (source) throw badRequest("هذا الصنف بلا دفعات مؤرخة", "BATCH_SOURCE_UNEXPECTED");
    return { batch_source: null, expiry_date: null };
  }
  if (source !== "dated" && source !== "undated") {
    throw badRequest("حدد الدفعة أو المخزون غير المحدد. لا يُختار مصدر تلقائياً", "BATCH_SOURCE_REQUIRED");
  }
  if (source === "undated") {
    if (rawExpiry) throw badRequest("المخزون غير المحدد لا يحمل تاريخ صلاحية", "EXPIRY_UNEXPECTED");
    if (change < 0) {
      await assertUndatedAvailable(db, productId, -change);
    }
    const parts = await moveUndatedOnMain(db, productId, change);
    await recordSourceParts(db, parts, {
      productId,
      direction: change < 0 ? "out" : "in",
      referenceType: "stock_adjustment",
      referenceId,
      expiryDate: null,
      quantity: round6(Math.abs(change)),
    });
    return { batch_source: "undated", expiry_date: null };
  }

  const parsed = interpretExpiryInput(rawExpiry);
  if (!parsed.ok || !parsed.date) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
  const ymd = parsed.date;
  let parts = [];
  if (change < 0) {
    const taken = await takeExactDatedQuantity(db, productId, ymd, -change);
    parts = taken.parts || [];
  } else {
    await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: change });
  }
  await recordSourceParts(db, parts, {
    productId,
    direction: change < 0 ? "out" : "in",
    referenceType: "stock_adjustment",
    referenceId,
    expiryDate: ymd,
    quantity: round6(Math.abs(change)),
  });
  return { batch_source: "dated", expiry_date: ymd };
}

/**
 * Set every dated lot to zero and record the undated remainder so the product
 * total can be moved to zero once by the caller. Rows and allocation history stay.
 */
export async function zeroProductBatchSources(db, productId) {
  const picture = await listPhysicalSources(db, productId);
  const lots = await listSourceLots(db, { productId, includeEmpty: true });
  const activeLots = lots.filter((lot) => Math.abs(lot.quantity) > 1e-9);
  let touched = false;
  if (activeLots.length) {
    for (const lot of activeLots) {
      touched = true;
      await recordBatchAllocation(db, {
        expiry_date: lot.expiry_date,
        quantity: Math.abs(lot.quantity),
        source_lot_id: lot.id,
        supplier_id: lot.supplier_id,
        purchase_invoice_id: lot.purchase_invoice_id,
        purchase_invoice_item_id: lot.purchase_invoice_item_id,
        source_provenance: lot.provenance,
        warehouse_id: lot.warehouse_id,
      }, {
        productId,
        direction: lot.quantity > 0 ? "out" : "in",
        referenceType: "zero_all_stock",
        referenceId: null,
      });
    }
    for (const row of picture.sources) {
      if (row.batch_source !== "dated") continue;
      const ymd = normalizeExpiryDate(row.expiry_date);
      if (!ymd) continue;
      await db.run(
        "UPDATE product_batches SET quantity = 0 WHERE product_id = ? AND expiry_date = ?",
        [Number(productId), ymd]
      );
    }
  } else {
    for (const row of picture.sources) {
      const qty = round6(row.quantity);
      if (Math.abs(qty) <= 1e-9) continue;
      touched = true;
      if (row.batch_source === "dated") {
        await setDatedBatchQuantity(db, productId, row.expiry_date, 0);
      }
      await recordBatchAllocation(db, { expiry_date: row.expiry_date, quantity: Math.abs(qty) }, {
        productId,
        direction: qty > 0 ? "out" : "in",
        referenceType: "zero_all_stock",
        referenceId: null,
      });
    }
  }
  await clearProductLocations(db, productId);
  return touched;
}

/**
 * Set a lot to an absolute counted quantity, including zero. The row stays.
 * Returns the signed change (counted − previous).
 */
export async function setDatedBatchQuantity(db, productId, expiryDate, countedQty) {
  const ymd = normalizeExpiryDate(expiryDate);
  const next = round6(countedQty);
  if (!ymd) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
  if (!Number.isFinite(next) || next < 0) {
    throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
  }
  const placed = await ensureMaterialized(db, productId);
  const existing = await findDatedBatch(db, productId, ymd);
  if (!existing) throw badRequest("الدفعة غير موجودة", "BATCH_NOT_FOUND");
  const prev = round6(Number(existing.quantity) || 0);
  await db.run("UPDATE product_batches SET quantity = ? WHERE id = ?", [next, existing.id]);
  const delta = round6(next - prev);
  let parts = [];
  if (next === 0) {
    parts = (await listSourceLots(db, { productId }))
      .filter((lot) => (lot.expiry_date || "") === ymd && Math.abs(lot.quantity) > 1e-9)
      .map((lot) => ({
        source_lot_id: lot.id,
        supplier_id: lot.supplier_id,
        purchase_invoice_id: lot.purchase_invoice_id,
        purchase_invoice_item_id: lot.purchase_invoice_item_id,
        source_provenance: lot.provenance,
        expiry_date: lot.expiry_date,
        warehouse_id: lot.warehouse_id,
        quantity: Math.abs(lot.quantity),
      }));
    await clearExpiryLocations(db, productId, ymd);
  } else if (placed.mode !== NEEDS_RECONCILIATION && delta !== 0) {
    const { main } = await operationalWarehouses(db);
    if (main) {
      parts = await addWarehouseQuantity(db, {
        warehouseId: main.id,
        productId,
        expiryDate: ymd,
        delta,
      });
    }
  }
  return { expiry_date: ymd, previous: prev, counted: next, delta, batch_id: existing.id, parts, funded: 0 };
}

/**
 * Set one counted expiry to an absolute quantity.
 * A date that has no batch yet is created. An increase can take its units from
 * undated stock so an existing supplier identity moves with them. Anything
 * beyond that undated decrease is discovered stock: unknown provenance, no
 * supplier, and no purchase receipt. A zero count of a date that does not
 * exist yet does not insert an empty batch.
 */
export async function applyCountedDatedQuantity(db, productId, expiryDate, countedQty, { fundFromUndated = 0 } = {}) {
  const parsed = interpretExpiryInput(expiryDate);
  if (!parsed.ok || !parsed.date) throw badRequest("تاريخ الصلاحية غير صالح", "INVALID_EXPIRY");
  const ymd = parsed.date;
  const next = round6(countedQty);
  if (!Number.isFinite(next) || next < 0) {
    throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
  }
  const existing = await findDatedBatch(db, productId, ymd);
  const prev = round6(Number(existing?.quantity) || 0);
  const delta = round6(next - prev);
  if (!existing && next === 0) {
    return { expiry_date: ymd, previous: 0, counted: 0, delta: 0, parts: [], batch_id: null, funded: 0 };
  }
  const fund = round6(Math.min(Math.max(0, fundFromUndated), Math.max(0, delta)));
  if (fund === 0 && existing) {
    return setDatedBatchQuantity(db, productId, ymd, next);
  }
  const parts = [];
  if (fund > 0) {
    await receiveDatedBatch(db, {
      productId,
      expiryDate: ymd,
      quantity: fund,
      fromUndated: true,
      movedParts: parts,
    });
  }
  const rest = round6(delta - fund);
  if (rest > 0) {
    await receiveDatedBatch(db, {
      productId,
      expiryDate: ymd,
      quantity: rest,
      source: { provenance: "unknown" },
      movedParts: parts,
    });
  }
  const saved = await findDatedBatch(db, productId, ymd);
  return {
    expiry_date: ymd,
    previous: prev,
    counted: next,
    delta,
    batch_id: saved?.id || null,
    parts,
    funded: fund,
  };
}

async function findDatedBatch(db, productId, expiryDate) {
  const ymd = normalizeExpiryDate(expiryDate);
  if (!ymd) return null;
  return db.get(
    `SELECT id, quantity, cost FROM product_batches
      WHERE product_id = ? AND expiry_date = ?
      ORDER BY id ASC LIMIT 1`,
    [Number(productId), ymd]
  );
}

/**
 * Increase a dated lot. Unknown-expiry inbound is represented only via products.stock.
 */
export async function receiveDatedBatch(db, { productId, expiryDate, quantity, cost = null, batchNo = null, notes = null, fromUndated = false, source = null, movedParts = null }) {
  const ymd = normalizeExpiryDate(expiryDate);
  const qty = round6(quantity);
  if (!ymd || !qty) return null;
  const costValue = cost != null && Number.isFinite(Number(cost)) ? Number(cost) : null;
  const batchLabel = batchNo != null && String(batchNo).trim() !== "" ? String(batchNo).trim() : null;
  const noteValue = notes != null && String(notes).trim() !== "" ? String(notes).trim() : null;

  const placed = await ensureMaterialized(db, productId);
  const existing = await findDatedBatch(db, productId, ymd);
  let saved;
  if (existing) {
    await db.run(
      `UPDATE product_batches
          SET quantity = quantity + ?,
              cost = COALESCE(?, cost),
              batch_no = COALESCE(?, batch_no),
              notes = COALESCE(?, notes)
        WHERE id = ?`,
      [qty, costValue, batchLabel, noteValue, existing.id]
    );
    saved = await db.get("SELECT * FROM product_batches WHERE id = ?", [existing.id]);
  } else {
    const ins = await db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, cost, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(productId), batchLabel, ymd, qty, costValue, noteValue]
    );
    saved = await db.get("SELECT * FROM product_batches WHERE id = ?", [ins.lastID]);
  }
  if (placed.mode !== NEEDS_RECONCILIATION) {
    const { main } = await operationalWarehouses(db);
    if (main) {
      if (fromUndated) {
        const taken = await takeSourceLots(db, {
          productId,
          warehouseId: main.id,
          expiryDate: null,
          quantity: qty,
        });
        await addWarehouseQuantity(db, {
          warehouseId: main.id,
          productId,
          expiryDate: ymd,
          delta: qty,
          sourcePolicy: "skip",
        });
        await addWarehouseQuantity(db, {
          warehouseId: main.id,
          productId,
          expiryDate: null,
          delta: -qty,
          sourcePolicy: "skip",
        });
        for (const part of taken) {
          const created = await addSourceIdentity(db, {
            productId,
            warehouseId: main.id,
            expiryDate: ymd,
            quantity: part.quantity,
            supplierId: part.supplier_id,
            purchaseInvoiceId: part.purchase_invoice_id,
            purchaseInvoiceItemId: part.purchase_invoice_item_id,
            provenance: part.provenance,
            receivedAt: part.received_at,
          });
          if (Array.isArray(movedParts)) {
            movedParts.push({
              ...part,
              source_lot_id: created?.id || null,
              expiry_date: ymd,
              quantity: part.quantity,
            });
          }
        }
      } else {
        const added = await addWarehouseQuantity(db, {
          warehouseId: main.id,
          productId,
          expiryDate: ymd,
          delta: qty,
          source: source || { provenance: "unknown" },
        });
        if (Array.isArray(movedParts) && added?.length) movedParts.push(...added);
      }
    }
  }
  return saved;
}

/**
 * Assign an expiry to stock that is not already on a dated lot.
 * Does not receive new goods and does not write inventory_ledger.
 * Caller must be inside withTransaction so two requests cannot assign the same units.
 */
export async function assignDatedQuantityFromUnknown(db, { productId, expiryDate, quantity, cost = null, batchNo = null, notes = null }) {
  const ymd = normalizeExpiryDate(expiryDate);
  if (!ymd) {
    const err = new Error("تاريخ الصلاحية مطلوب لتعيين دفعة من المخزون القائم");
    err.status = 400;
    err.code = "EXPIRY_REQUIRED";
    throw err;
  }
  const qty = round6(quantity);
  if (!(qty > 0)) {
    const err = new Error("الكمية يجب أن تكون أكبر من صفر");
    err.status = 400;
    err.code = "INVALID_QTY";
    throw err;
  }
  const product = await db.get("SELECT id, stock FROM products WHERE id = ?", [Number(productId)]);
  if (!product) {
    const err = new Error("المنتج غير موجود");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const dated = await listDatedBatches(db, productId);
  const unknown = unknownQuantityFromStock(product.stock, datedQuantitySum(dated));
  if (qty > unknown + 1e-9) {
    const available = round6(Math.max(0, unknown));
    const err = new Error(`الكمية أكبر من المخزون غير المخصص للصلاحية (المتاح ${available})`);
    err.status = 400;
    err.code = "BATCH_EXCEEDS_UNASSIGNED";
    err.available = available;
    throw err;
  }
  return receiveDatedBatch(db, {
    productId,
    expiryDate: ymd,
    quantity: qty,
    cost,
    batchNo,
    notes,
    fromUndated: true,
  });
}

async function decrementDatedBatch(db, productId, expiryDate, quantity) {
  const ymd = normalizeExpiryDate(expiryDate);
  const want = round6(quantity);
  if (!ymd || want <= 0) return 0;

  const existing = await findDatedBatch(db, productId, ymd);
  if (!existing) return 0;
  const have = Math.max(0, round6(Number(existing.quantity) || 0));
  const take = round6(Math.min(have, want));
  if (take <= 0) return 0;
  await db.run("UPDATE product_batches SET quantity = quantity - ? WHERE id = ?", [take, existing.id]);
  return take;
}

function takeFromDatedList(dated, expiryDate, remaining) {
  const ymd = normalizeExpiryDate(expiryDate);
  if (!ymd || remaining <= 0) return { take: 0, remaining };
  const batch = dated.find((b) => b.expiry_date === ymd);
  if (!batch) return { take: 0, remaining };
  const have = Math.max(0, round6(Number(batch.quantity) || 0));
  const take = round6(Math.min(have, remaining));
  if (take > 0) batch.quantity = round6(batch.quantity - take);
  return { take, remaining: round6(remaining - take) };
}

/**
 * FEFO: earliest dated lots first, then unknown remainder, then overflow (still unknown — never invent a date).
 * @param {'auto' | 'unknown' | string} preferred
 */
export function planOutboundAllocations({ stock, datedBatches, quantity, preferred = PREFERRED_AUTO }) {
  const need = round6(quantity);
  if (need <= 0) return [];

  const dated = (datedBatches || []).map((b) => ({
    expiry_date: normalizeExpiryDate(b.expiry_date),
    quantity: Math.max(0, round6(Number(b.quantity) || 0)),
  }));
  const datedSum = datedQuantitySum(dated);
  let unknownAvail = unknownQuantityFromStock(stock, datedSum);
  let remaining = need;
  const out = [];

  const push = (expiryDate, qty, overflow = false) => {
    const q = round6(qty);
    if (q <= 0) return;
    out.push({ expiry_date: expiryDate, quantity: q, overflow: overflow || undefined });
  };

  const pref = parsePreferredExpiry(preferred);

  if (pref === PREFERRED_UNKNOWN) {
    const fromUnknown = round6(Math.min(Math.max(0, unknownAvail), remaining));
    if (fromUnknown > 0) {
      push(null, fromUnknown);
      unknownAvail = round6(unknownAvail - fromUnknown);
      remaining = round6(remaining - fromUnknown);
    }
  } else if (pref !== PREFERRED_AUTO) {
    const hit = takeFromDatedList(dated, pref, remaining);
    if (hit.take > 0) push(hit.expiry_date || pref, hit.take);
    remaining = hit.remaining;
  }

  for (const b of dated) {
    if (remaining <= 0) break;
    const take = round6(Math.min(b.quantity, remaining));
    if (take <= 0) continue;
    b.quantity = round6(b.quantity - take);
    remaining = round6(remaining - take);
    push(b.expiry_date, take);
  }

  if (remaining > 0) {
    const fromUnknown = round6(Math.min(Math.max(0, unknownAvail), remaining));
    if (fromUnknown > 0) {
      push(null, fromUnknown);
      remaining = round6(remaining - fromUnknown);
    }
  }

  if (remaining > 0) {
    push(null, remaining, true);
  }

  return mergeAllocations(out);
}

function mergeAllocations(rows) {
  const map = new Map();
  const order = [];
  for (const row of rows) {
    const key = row.expiry_date || "";
    if (!map.has(key)) {
      map.set(key, { expiry_date: row.expiry_date || null, quantity: 0, overflow: false });
      order.push(key);
    }
    const acc = map.get(key);
    acc.quantity = round6(acc.quantity + row.quantity);
    if (row.overflow) acc.overflow = true;
  }
  return order.map((k) => {
    const row = map.get(k);
    if (!row.overflow) delete row.overflow;
    return row;
  });
}

export async function planSaleAllocations(db, productId, quantity, preferred) {
  const stock = await getProductStock(db, productId);
  const datedBatches = await listDatedBatches(db, productId);
  return planOutboundAllocations({ stock, datedBatches, quantity, preferred });
}

export async function recordBatchAllocation(db, allocation, meta) {
  await insertAllocations(db, [allocation], meta);
}

async function insertAllocations(db, allocations, meta) {
  for (const a of allocations) {
    const qty = round6(a.quantity);
    if (!qty) continue;
    await db.run(
      `INSERT INTO stock_batch_allocations
         (product_id, expiry_date, quantity, direction, reference_type, reference_id,
          transaction_item_id, invoice_item_id, warehouse_id,
          source_lot_id, supplier_id, purchase_invoice_id, purchase_invoice_item_id, source_provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(meta.productId),
        a.expiry_date || null,
        qty,
        meta.direction,
        meta.referenceType,
        meta.referenceId != null ? Number(meta.referenceId) : null,
        meta.transactionItemId != null ? Number(meta.transactionItemId) : null,
        meta.invoiceItemId != null ? Number(meta.invoiceItemId) : null,
        a.warehouse_id != null ? Number(a.warehouse_id) : (meta.warehouseId != null ? Number(meta.warehouseId) : null),
        a.source_lot_id != null ? Number(a.source_lot_id) : null,
        a.supplier_id != null ? Number(a.supplier_id) : null,
        a.purchase_invoice_id != null ? Number(a.purchase_invoice_id) : null,
        a.purchase_invoice_item_id != null ? Number(a.purchase_invoice_item_id) : null,
        a.source_provenance || a.provenance || null,
      ]
    );
  }
}

async function recordSourceParts(db, parts, meta) {
  if (parts?.length) {
    await insertAllocations(db, parts, meta);
    return;
  }
  await recordBatchAllocation(db, {
    expiry_date: meta.expiryDate ?? null,
    quantity: meta.quantity,
  }, meta);
}

/**
 * Purchase receive: dated lots get explicit qty (incl. bonus, already in base units).
 * No-expiry lines only change products.stock (unknown residual).
 */
export async function applyPurchaseReceiveBatches(db, {
  productId,
  expiryDate,
  quantity,
  cost,
  referenceId,
  invoiceItemId,
  supplierId = null,
  purchaseInvoiceId = null,
}) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const ymd = normalizeExpiryDate(expiryDate);
  const source = supplierId ? {
    supplierId,
    purchaseInvoiceId: purchaseInvoiceId || referenceId,
    purchaseInvoiceItemId: invoiceItemId,
    provenance: "receipt",
  } : { provenance: "unknown" };
  let parts = [];
  if (ymd) {
    await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: qty, cost, source });
    parts = [{
      expiry_date: ymd,
      quantity: qty,
      supplier_id: supplierId,
      purchase_invoice_id: purchaseInvoiceId || referenceId,
      purchase_invoice_item_id: invoiceItemId,
      source_provenance: supplierId ? "receipt" : "unknown",
    }];
  } else {
    parts = await moveUndatedOnMain(db, productId, qty, source);
  }
  const allocations = parts?.length ? parts : [{ expiry_date: ymd, quantity: qty, supplier_id: supplierId, purchase_invoice_item_id: invoiceItemId, purchase_invoice_id: purchaseInvoiceId || referenceId, source_provenance: supplierId ? "receipt" : "unknown" }];
  await insertAllocations(db, allocations, {
    productId,
    direction: "in",
    referenceType: "purchase_invoice",
    referenceId,
    invoiceItemId,
  });
  return allocations;
}

async function consumePlanned(db, productId, allocations, meta) {
  const recorded = [];
  for (const allocation of allocations) {
    const parts = await addWarehouseQuantity(db, {
      warehouseId: allocation.warehouse_id,
      productId,
      expiryDate: allocation.expiry_date,
      delta: -allocation.quantity,
      source: allocation.source_lot_id ? { sourceLotId: allocation.source_lot_id } : null,
    });
    if (allocation.expiry_date) {
      await decrementDatedBatch(db, productId, allocation.expiry_date, allocation.quantity);
    }
    recorded.push(...(parts?.length ? parts : [allocation]));
  }
  await insertAllocations(db, recorded, { productId, direction: "out", ...meta });
  return recorded;
}

export async function applyOutboundBatches(db, { productId, quantity, preferred, referenceType, referenceId, transactionItemId, invoiceItemId }) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const meta = { referenceType, referenceId, transactionItemId, invoiceItemId };
  if (referenceType === "purchase_return") {
    throw badRequest("مرتجع المورد يحدد كمية المورد في المرتجعات", "WRONG_SUPPLIER");
  }
  await ensureMaterialized(db, productId);
  const allocations = await planSellableAllocations(db, productId, qty, preferred);
  return consumePlanned(db, productId, allocations, meta);
}

export async function applySaleStock(db, opts) {
  const {
    productId,
    quantity,
    preferred,
    userId,
    notes,
    referenceType,
    referenceId,
    transactionItemId,
    invoiceItemId,
    businessDay = null,
  } = opts;
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const allocations = await applyOutboundBatches(db, {
    productId,
    quantity: qty,
    preferred,
    referenceType,
    referenceId,
    transactionItemId,
    invoiceItemId,
  });
  await recordMovement(db, {
    productId,
    movementType: "sale",
    quantity: -qty,
    refType: referenceType,
    refId: referenceId,
    notes,
    userId,
    applyStock: true,
    businessDay,
  });
  return allocations;
}

export async function applyPurchaseReturnBatches(db, {
  productId,
  expiryDate,
  batchSource,
  quantity,
  referenceId,
  invoiceItemId,
  supplierId = null,
  sourceLotId = null,
}) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const placed = await ensureMaterialized(db, productId);
  if (placed.mode === NEEDS_RECONCILIATION) {
    throw badRequest("هذا الصنف بانتظار جرد المستودع قبل تحريك الكمية", "RECONCILIATION_REQUIRED");
  }
  const { returns } = await operationalWarehouses(db);
  if (!returns) throw badRequest("مستودع المرتجعات غير موجود", "WAREHOUSE_NOT_OPERATIONAL");
  const namedExpiry = batchSource === "undated" ? null : normalizeExpiryDate(expiryDate);
  const expiry = batchSource === "dated" || namedExpiry ? namedExpiry : null;
  if (!supplierId) throw badRequest("المورد مطلوب", "VALIDATION_ERROR");
  if (sourceLotId) {
    const lot = await db.get("SELECT * FROM stock_source_lots WHERE id = ?", [Number(sourceLotId)]);
    const samePlace = lot
      && Number(lot.product_id) === Number(productId)
      && Number(lot.warehouse_id) === Number(returns.id);
    if (!samePlace) {
      throw badRequest(
        "تغيّرت الكمية المتاحة في المرتجعات. حدّث القائمة ثم أعد الاختيار.",
        "STALE_RETURN_QTY"
      );
    }
    if (!lot.supplier_id || lot.provenance === "unknown" || Number(lot.supplier_id) !== Number(supplierId)) {
      throw badRequest("لا يمكن إرجاع بضاعة مورّد آخر", "WRONG_SUPPLIER");
    }
    if (round6(Number(lot.quantity) || 0) + 1e-9 < qty) {
      throw badRequest(
        "تغيّرت الكمية المتاحة في المرتجعات. حدّث القائمة ثم أعد الاختيار.",
        "STALE_RETURN_QTY"
      );
    }
  }
  const parts = await takeSourceLots(db, {
    productId,
    warehouseId: returns.id,
    expiryDate: batchSource === "undated" ? null : expiry,
    quantity: qty,
    sourceLotId: sourceLotId || null,
    supplierId,
    attributedOnly: true,
  });
  for (const part of parts) {
    await addWarehouseQuantity(db, {
      warehouseId: returns.id,
      productId,
      expiryDate: part.expiry_date,
      delta: -part.quantity,
      sourcePolicy: "skip",
    });
    if (part.expiry_date) await decrementDatedBatch(db, productId, part.expiry_date, part.quantity);
  }
  await insertAllocations(db, parts, {
    productId,
    direction: "out",
    referenceType: "purchase_return",
    referenceId,
    invoiceItemId,
  });
  return parts;
}

function allocationRestoreKey(row) {
  if (row.source_lot_id) return `lot:${row.source_lot_id}`;
  return `exp:${row.expiry_date || ""}`;
}

async function originalOutAllocations(db, transactionId, productId) {
  return db.all(
    `SELECT expiry_date, quantity, source_lot_id, supplier_id, purchase_invoice_id,
            purchase_invoice_item_id, source_provenance, warehouse_id
       FROM stock_batch_allocations
      WHERE reference_type = 'transaction'
        AND reference_id = ?
        AND product_id = ?
        AND direction = 'out'
      ORDER BY id ASC`,
    [Number(transactionId), Number(productId)]
  );
}

async function restoredInQtyByKey(db, transactionId, productId) {
  const rows = await db.all(
    `SELECT a.expiry_date, a.source_lot_id, SUM(a.quantity) AS qty
       FROM stock_batch_allocations a
       JOIN refunds r ON a.reference_type = 'refund' AND a.reference_id = r.id
      WHERE r.original_transaction_id = ?
        AND a.product_id = ?
        AND a.direction = 'in'
      GROUP BY a.source_lot_id, a.expiry_date`,
    [Number(transactionId), Number(productId)]
  );
  const map = new Map();
  for (const row of rows) {
    const key = allocationRestoreKey(row);
    map.set(key, round6((map.get(key) || 0) + (Number(row.qty) || 0)));
  }
  return map;
}

/**
 * Restore lots consumed by the original sale, in original allocation order.
 * Legacy sales with no allocations return to unknown (no dated rewrite).
 */
export async function restoreSaleBatches(db, { transactionId, productId, quantity, refundId }) {
  const qty = round6(quantity);
  if (qty <= 0) return [];

  const original = await originalOutAllocations(db, transactionId, productId);
  if (!original.length) {
    const parts = await moveUndatedOnMain(db, productId, qty);
    const allocations = parts?.length ? parts : [{ expiry_date: null, quantity: qty }];
    await insertAllocations(db, allocations, {
      productId,
      direction: "in",
      referenceType: "refund",
      referenceId: refundId,
    });
    return allocations;
  }

  const restored = await restoredInQtyByKey(db, transactionId, productId);
  const remainingByKey = new Map();
  for (const row of original) {
    const key = allocationRestoreKey(row);
    remainingByKey.set(key, round6((remainingByKey.get(key) || 0) + (Number(row.quantity) || 0)));
  }
  for (const [key, taken] of restored) {
    remainingByKey.set(key, round6(Math.max(0, (remainingByKey.get(key) || 0) - taken)));
  }

  let remaining = qty;
  const allocations = [];
  for (const row of original) {
    if (remaining <= 0) break;
    const key = allocationRestoreKey(row);
    const available = remainingByKey.get(key) || 0;
    if (available <= 0) continue;
    const take = round6(Math.min(available, remaining, Number(row.quantity) || 0));
    if (take <= 0) continue;
    remainingByKey.set(key, round6(available - take));
    remaining = round6(remaining - take);
    const ymd = normalizeExpiryDate(row.expiry_date);
    const source = row.source_lot_id || row.supplier_id ? {
      sourceLotId: row.source_lot_id,
      supplierId: row.supplier_id,
      purchaseInvoiceId: row.purchase_invoice_id,
      purchaseInvoiceItemId: row.purchase_invoice_item_id,
      provenance: row.source_provenance || (row.supplier_id ? "receipt" : "unknown"),
    } : { provenance: "unknown" };
    if (ymd) {
      await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: take, source });
    } else {
      await moveUndatedOnMain(db, productId, take, source);
    }
    allocations.push({
      expiry_date: ymd,
      quantity: take,
      source_lot_id: row.source_lot_id || null,
      supplier_id: row.supplier_id || null,
      purchase_invoice_id: row.purchase_invoice_id || null,
      purchase_invoice_item_id: row.purchase_invoice_item_id || null,
      source_provenance: source.provenance || null,
    });
  }
  if (remaining > 0) {
    const parts = await moveUndatedOnMain(db, productId, remaining);
    allocations.push(...(parts?.length ? parts : [{ expiry_date: null, quantity: remaining }]));
  }

  await insertAllocations(db, allocations, {
    productId,
    direction: "in",
    referenceType: "refund",
    referenceId: refundId,
  });
  return allocations;
}

export function allocationsToJson(allocations) {
  return JSON.stringify(
    (allocations || []).map((a) => ({
      expiry_date: a.expiry_date || null,
      quantity: round6(a.quantity),
      overflow: a.overflow || undefined,
      source_lot_id: a.source_lot_id || undefined,
      supplier_id: a.supplier_id || undefined,
      purchase_invoice_item_id: a.purchase_invoice_item_id || undefined,
    }))
  );
}
