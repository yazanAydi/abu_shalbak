/**
 * Dated stock lots live on `product_batches` (YYYY-MM-DD expiry).
 * Unknown-expiry remainder is derived: products.stock − sum(dated batch qty).
 * Sales never rewrite a lot's expiry date.
 */

import { round6 } from "../utils/purchaseInventoryCost.js";
import { recordMovement } from "../utils/inventory.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { getAppSettings } from "../utils/settings.js";
import {
  daysUntilExpiry,
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
export async function receiveDatedBatch(db, { productId, expiryDate, quantity, cost = null }) {
  const ymd = normalizeExpiryDate(expiryDate);
  const qty = round6(quantity);
  if (!ymd || !qty) return null;

  const existing = await findDatedBatch(db, productId, ymd);
  if (existing) {
    await db.run("UPDATE product_batches SET quantity = quantity + ?, cost = COALESCE(?, cost) WHERE id = ?", [
      qty,
      cost != null && Number.isFinite(Number(cost)) ? Number(cost) : null,
      existing.id,
    ]);
    return { id: existing.id, expiry_date: ymd, quantity: qty };
  }

  const ins = await db.run(
    `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, cost, notes)
     VALUES (?, NULL, ?, ?, ?, NULL)`,
    [Number(productId), ymd, qty, cost != null && Number.isFinite(Number(cost)) ? Number(cost) : null]
  );
  return { id: ins.lastID, expiry_date: ymd, quantity: qty };
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

async function insertAllocations(db, allocations, meta) {
  for (const a of allocations) {
    const qty = round6(a.quantity);
    if (!qty) continue;
    await db.run(
      `INSERT INTO stock_batch_allocations
         (product_id, expiry_date, quantity, direction, reference_type, reference_id,
          transaction_item_id, invoice_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(meta.productId),
        a.expiry_date || null,
        qty,
        meta.direction,
        meta.referenceType,
        meta.referenceId != null ? Number(meta.referenceId) : null,
        meta.transactionItemId != null ? Number(meta.transactionItemId) : null,
        meta.invoiceItemId != null ? Number(meta.invoiceItemId) : null,
      ]
    );
  }
}

/**
 * Purchase receive: dated lots get explicit qty (incl. bonus, already in base units).
 * No-expiry lines only change products.stock (unknown residual).
 */
export async function applyPurchaseReceiveBatches(db, { productId, expiryDate, quantity, cost, referenceId, invoiceItemId }) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const ymd = normalizeExpiryDate(expiryDate);
  const allocations = [{ expiry_date: ymd, quantity: qty }];
  if (ymd) {
    await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: qty, cost });
  }
  await insertAllocations(db, allocations, {
    productId,
    direction: "in",
    referenceType: "purchase_invoice",
    referenceId,
    invoiceItemId,
  });
  return allocations;
}

export async function applyOutboundBatches(db, { productId, quantity, preferred, referenceType, referenceId, transactionItemId, invoiceItemId }) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const allocations = await planSaleAllocations(db, productId, qty, preferred);
  for (const a of allocations) {
    if (a.expiry_date) {
      await decrementDatedBatch(db, productId, a.expiry_date, a.quantity);
    }
  }
  await insertAllocations(db, allocations, {
    productId,
    direction: "out",
    referenceType,
    referenceId,
    transactionItemId,
    invoiceItemId,
  });
  return allocations;
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
  });
  return allocations;
}

export async function applyPurchaseReturnBatches(db, { productId, expiryDate, quantity, referenceId, invoiceItemId }) {
  const qty = round6(quantity);
  if (qty <= 0) return [];
  const preferred = normalizeExpiryDate(expiryDate) || PREFERRED_AUTO;
  return applyOutboundBatches(db, {
    productId,
    quantity: qty,
    preferred,
    referenceType: "purchase_return",
    referenceId,
    invoiceItemId,
  });
}

async function originalOutAllocations(db, transactionId, productId) {
  return db.all(
    `SELECT expiry_date, quantity FROM stock_batch_allocations
      WHERE reference_type = 'transaction'
        AND reference_id = ?
        AND product_id = ?
        AND direction = 'out'
      ORDER BY id ASC`,
    [Number(transactionId), Number(productId)]
  );
}

async function restoredInQtyByExpiry(db, transactionId, productId) {
  const rows = await db.all(
    `SELECT a.expiry_date, SUM(a.quantity) AS qty
       FROM stock_batch_allocations a
       JOIN refunds r ON a.reference_type = 'refund' AND a.reference_id = r.id
      WHERE r.original_transaction_id = ?
        AND a.product_id = ?
        AND a.direction = 'in'
      GROUP BY a.expiry_date`,
    [Number(transactionId), Number(productId)]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.expiry_date || "", round6(Number(r.qty) || 0));
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
    const allocations = [{ expiry_date: null, quantity: qty }];
    await insertAllocations(db, allocations, {
      productId,
      direction: "in",
      referenceType: "refund",
      referenceId: refundId,
    });
    return allocations;
  }

  const restored = await restoredInQtyByExpiry(db, transactionId, productId);
  const remainingByKey = new Map();
  for (const row of original) {
    const key = row.expiry_date || "";
    remainingByKey.set(key, round6((remainingByKey.get(key) || 0) + (Number(row.quantity) || 0)));
  }
  for (const [key, taken] of restored) {
    remainingByKey.set(key, round6(Math.max(0, (remainingByKey.get(key) || 0) - taken)));
  }

  let remaining = qty;
  const allocations = [];
  for (const row of original) {
    if (remaining <= 0) break;
    const key = row.expiry_date || "";
    const available = remainingByKey.get(key) || 0;
    if (available <= 0) continue;
    const take = round6(Math.min(available, remaining, Number(row.quantity) || 0));
    if (take <= 0) continue;
    remainingByKey.set(key, round6(available - take));
    remaining = round6(remaining - take);
    const ymd = normalizeExpiryDate(row.expiry_date);
    allocations.push({ expiry_date: ymd, quantity: take });
    if (ymd) {
      await receiveDatedBatch(db, { productId, expiryDate: ymd, quantity: take });
    }
  }
  if (remaining > 0) {
    allocations.push({ expiry_date: null, quantity: remaining });
  }

  await insertAllocations(db, mergeAllocations(allocations), {
    productId,
    direction: "in",
    referenceType: "refund",
    referenceId: refundId,
  });
  return mergeAllocations(allocations);
}

export function allocationsToJson(allocations) {
  return JSON.stringify(
    (allocations || []).map((a) => ({
      expiry_date: a.expiry_date || null,
      quantity: round6(a.quantity),
      overflow: a.overflow || undefined,
    }))
  );
}
