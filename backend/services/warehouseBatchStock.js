/**
 * Quantity of each dated lot and of undated stock, per operational warehouse.
 *
 * products.stock remains the company total. product_batches remains the
 * company total of each dated lot. warehouse_batch_stock is where those
 * units sit. warehouse_stock for the main and returns warehouses is a cache
 * of those sums, except for products still marked needs_reconciliation:
 * their warehouse_stock rows are the historical transfer offsets and are
 * not rewritten into guessed lots.
 */

import { round6 } from "../utils/purchaseInventoryCost.js";
import { badRequest } from "../utils/httpError.js";
import { normalizeExpiryDate } from "../utils/expiryDate.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import {
  addSourceIdentity,
  ensureProductSourceLots,
  listSourceLots,
  markReceiptReferences,
  moveSourceLots,
  takeSourceLots,
  zeroSourceLots,
} from "./stockSourceService.js";

const EPS = 1e-9;
export const UNDATED_KEY = "";
export const LOCATED = "located";
export const NEEDS_RECONCILIATION = "needs_reconciliation";

export const NO_SELLABLE_MESSAGE = "لا توجد كمية صالحة للبيع من هذا الصنف";
export const INSUFFICIENT_SELLABLE_MESSAGE = "الكمية المطلوبة أكبر من المتاح للبيع";

export function expiryKey(value) {
  return normalizeExpiryDate(value) || UNDATED_KEY;
}

/** A date-only expiry is expired before today's Asia/Hebron calendar date. Today stays valid. */
export function isExpiredOn(expiryYmd, todayYmd) {
  const expiry = normalizeExpiryDate(expiryYmd);
  const today = normalizeExpiryDate(todayYmd);
  if (!expiry || !today) return false;
  return expiry < today;
}

export function undatedIsSellable(productExpiry, todayYmd) {
  const legacy = normalizeExpiryDate(productExpiry);
  if (!legacy) return true;
  return !isExpiredOn(legacy, todayYmd);
}

export async function operationalWarehouses(db) {
  const rows = await db.all(
    `SELECT id, name, code, type FROM warehouses
      WHERE active = 1 AND type IN ('main', 'returns')
      ORDER BY CASE type WHEN 'main' THEN 0 ELSE 1 END, id`
  );
  return {
    main: rows.find((row) => row.type === "main") || null,
    returns: rows.find((row) => row.type === "returns") || null,
  };
}

async function productRow(db, productId) {
  return db.get(
    `SELECT id, stock, expiry_date, COALESCE(location_status, 'located') AS location_status
       FROM products WHERE id = ?`,
    [Number(productId)]
  );
}

export async function locationRows(db, productId, warehouseId = null) {
  const params = [Number(productId)];
  let sql = `SELECT warehouse_id, expiry_date, quantity
               FROM warehouse_batch_stock
              WHERE product_id = ?`;
  if (warehouseId) {
    sql += " AND warehouse_id = ?";
    params.push(Number(warehouseId));
  }
  sql += " ORDER BY expiry_date, warehouse_id";
  const rows = await db.all(sql, params);
  return rows.map((row) => ({
    warehouse_id: Number(row.warehouse_id),
    expiry_date: row.expiry_date ? normalizeExpiryDate(row.expiry_date) : null,
    expiry_key: row.expiry_date || UNDATED_KEY,
    quantity: round6(Number(row.quantity) || 0),
  }));
}

async function refreshCache(db, warehouseId, productId) {
  const sum = await db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS qty
       FROM warehouse_batch_stock
      WHERE warehouse_id = ? AND product_id = ?`,
    [Number(warehouseId), Number(productId)]
  );
  const qty = round6(Number(sum?.qty) || 0);
  const existing = await db.get(
    "SELECT id FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
    [Number(warehouseId), Number(productId)]
  );
  if (Math.abs(qty) <= EPS) {
    if (existing) await db.run("DELETE FROM warehouse_stock WHERE id = ?", [existing.id]);
    return;
  }
  if (existing) {
    await db.run("UPDATE warehouse_stock SET quantity = ? WHERE id = ?", [qty, existing.id]);
  } else {
    await db.run(
      "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)",
      [Number(warehouseId), Number(productId), qty]
    );
  }
}

/**
 * Place the current company picture on the main warehouse once.
 * Products that already have location rows, or that still need a physical
 * reconciliation, are left untouched.
 */
export async function ensureMaterialized(db, productId) {
  const product = await productRow(db, productId);
  if (!product) return { mode: "missing" };
  if (product.location_status === NEEDS_RECONCILIATION) return { mode: NEEDS_RECONCILIATION };
  const existing = await db.get(
    "SELECT id FROM warehouse_batch_stock WHERE product_id = ? LIMIT 1",
    [product.id]
  );
  if (existing) {
    await ensureProductSourceLots(db, product.id);
    return { mode: LOCATED };
  }
  const { main } = await operationalWarehouses(db);
  if (!main) return { mode: "missing" };
  const dated = await db.all(
    `SELECT expiry_date, quantity FROM product_batches
      WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != ''`,
    [product.id]
  );
  let datedSum = 0;
  for (const batch of dated) {
    const qty = round6(Number(batch.quantity) || 0);
    datedSum = round6(datedSum + qty);
    if (Math.abs(qty) <= EPS) continue;
    await db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, ?, ?)`,
      [main.id, product.id, normalizeExpiryDate(batch.expiry_date), qty]
    );
  }
  const undated = round6((Number(product.stock) || 0) - datedSum);
  if (Math.abs(undated) > EPS) {
    await db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, ?, ?)`,
      [main.id, product.id, UNDATED_KEY, undated]
    );
  }
  await refreshCache(db, main.id, product.id);
  const stale = await db.get(
    "SELECT id FROM stock_source_lots WHERE product_id = ? AND quantity > 0.0000001 LIMIT 1",
    [product.id]
  );
  if (stale) await zeroSourceLots(db, product.id);
  await ensureProductSourceLots(db, product.id);
  return { mode: LOCATED };
}

export async function addWarehouseQuantity(db, {
  warehouseId,
  productId,
  expiryDate,
  delta,
  sourcePolicy = null,
  source = null,
}) {
  const change = round6(delta);
  if (!change) return [];
  const key = expiryKey(expiryDate);
  const row = await db.get(
    `SELECT id, quantity FROM warehouse_batch_stock
      WHERE warehouse_id = ? AND product_id = ? AND expiry_date = ?`,
    [Number(warehouseId), Number(productId), key]
  );
  const have = round6(Number(row?.quantity) || 0);
  const next = round6(have + change);
  if (change < 0 && have + EPS < Math.abs(change)) {
    throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
  }
  if (!row) {
    await db.run(
      `INSERT INTO warehouse_batch_stock (warehouse_id, product_id, expiry_date, quantity)
       VALUES (?, ?, ?, ?)`,
      [Number(warehouseId), Number(productId), key, next]
    );
  } else if (Math.abs(next) <= EPS) {
    await db.run("DELETE FROM warehouse_batch_stock WHERE id = ?", [row.id]);
  } else {
    await db.run("UPDATE warehouse_batch_stock SET quantity = ? WHERE id = ?", [next, row.id]);
  }
  await refreshCache(db, warehouseId, productId);
  if (sourcePolicy === "skip") return [];
  if (change > 0) {
    const lot = await addSourceIdentity(db, {
      productId,
      warehouseId,
      expiryDate: key,
      quantity: change,
      supplierId: source?.supplierId ?? source?.supplier_id ?? null,
      purchaseInvoiceId: source?.purchaseInvoiceId ?? source?.purchase_invoice_id ?? null,
      purchaseInvoiceItemId: source?.purchaseInvoiceItemId ?? source?.purchase_invoice_item_id ?? null,
      provenance: source?.provenance || source?.source_provenance || (source?.supplierId || source?.supplier_id ? "receipt" : "unknown"),
      receivedAt: source?.receivedAt || source?.received_at || null,
      sourceLotId: source?.sourceLotId || source?.source_lot_id || null,
    });
    return lot ? [{
      source_lot_id: lot.id,
      supplier_id: lot.supplier_id,
      purchase_invoice_id: lot.purchase_invoice_id,
      purchase_invoice_item_id: lot.purchase_invoice_item_id,
      provenance: lot.provenance,
      source_provenance: lot.provenance,
      received_at: lot.received_at,
      expiry_date: key ? normalizeExpiryDate(key) : null,
      warehouse_id: Number(warehouseId),
      quantity: change,
      batch_source: key ? "dated" : "undated",
    }] : [];
  }
  return takeSourceLots(db, {
    productId,
    warehouseId,
    expiryDate: key,
    quantity: Math.abs(change),
    sourceLotId: source?.sourceLotId || source?.source_lot_id || null,
    supplierId: source?.supplierId || source?.supplier_id || null,
    attributedOnly: Boolean(source?.attributedOnly),
  });
}

export async function clearProductLocations(db, productId) {
  const warehouses = await db.all(
    "SELECT DISTINCT warehouse_id FROM warehouse_batch_stock WHERE product_id = ?",
    [Number(productId)]
  );
  await zeroSourceLots(db, productId);
  await db.run("DELETE FROM warehouse_batch_stock WHERE product_id = ?", [Number(productId)]);
  for (const warehouse of warehouses) {
    await refreshCache(db, warehouse.warehouse_id, productId);
  }
}

export async function clearExpiryLocations(db, productId, expiryDate) {
  const key = expiryKey(expiryDate);
  const warehouses = await db.all(
    `SELECT DISTINCT warehouse_id FROM warehouse_batch_stock
      WHERE product_id = ? AND expiry_date = ?`,
    [Number(productId), key]
  );
  await zeroSourceLots(db, productId, key);
  await db.run(
    "DELETE FROM warehouse_batch_stock WHERE product_id = ? AND expiry_date = ?",
    [Number(productId), key]
  );
  for (const warehouse of warehouses) {
    await refreshCache(db, warehouse.warehouse_id, productId);
  }
}

function sourceFromRow(row, today) {
  const dated = Boolean(row.expiry_date);
  const expired = dated && isExpiredOn(row.expiry_date, today);
  return {
    warehouse_id: row.warehouse_id,
    batch_source: dated ? "dated" : "undated",
    expiry_date: row.expiry_date,
    quantity: row.quantity,
    expired,
    source_lot_id: row.source_lot_id || null,
    supplier_id: row.supplier_id || null,
    supplier_name: row.supplier_name || null,
    purchase_invoice_id: row.purchase_invoice_id || null,
    purchase_invoice_item_id: row.purchase_invoice_item_id || null,
    receipt_reference: row.receipt_reference || null,
    show_receipt_reference: Boolean(row.show_receipt_reference),
    provenance: row.provenance || null,
    received_at: row.received_at || null,
    receipt_order: row.receipt_order || 0,
  };
}

export async function listWarehouseSources(db, warehouseId, productId, options = {}) {
  const product = await productRow(db, productId);
  if (!product) return [];
  if (product.location_status === NEEDS_RECONCILIATION) return [];
  const today = shopTodayYmd();
  const { main } = await operationalWarehouses(db);
  const supplierId = options.supplierId ? Number(options.supplierId) : null;
  const lots = markReceiptReferences(await listSourceLots(db, {
    productId,
    warehouseId,
    supplierId,
    attributedOnly: Boolean(supplierId),
  }));
  if (lots.length || supplierId) {
    return lots.map((lot, index) => sourceFromRow({
      warehouse_id: Number(warehouseId),
      expiry_date: lot.expiry_date,
      quantity: lot.quantity,
      source_lot_id: lot.id,
      supplier_id: lot.supplier_id,
      supplier_name: lot.supplier_id ? lot.supplier_name : null,
      purchase_invoice_id: lot.purchase_invoice_id,
      purchase_invoice_item_id: lot.purchase_invoice_item_id,
      receipt_reference: lot.receipt_reference,
      show_receipt_reference: lot.show_receipt_reference,
      provenance: lot.provenance,
      received_at: lot.received_at,
      receipt_order: index,
    }, today));
  }
  const rows = await locationRows(db, productId, warehouseId);
  const any = await locationRows(db, productId);
  if (rows.length || any.length) {
    return rows.filter((row) => row.quantity > EPS).map((row) => sourceFromRow(row, today));
  }
  if (!main || Number(warehouseId) !== Number(main.id)) return [];
  const dated = await db.all(
    `SELECT expiry_date, quantity FROM product_batches
      WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != ''
        AND ABS(quantity) > ?`,
    [product.id, EPS]
  );
  const sources = dated.map((batch) => sourceFromRow({
    warehouse_id: main.id,
    expiry_date: normalizeExpiryDate(batch.expiry_date),
    quantity: round6(Number(batch.quantity) || 0),
  }, today));
  const datedSum = sources.reduce((sum, row) => round6(sum + row.quantity), 0);
  const undated = round6((Number(product.stock) || 0) - datedSum);
  if (undated > EPS) {
    sources.push(sourceFromRow({
      warehouse_id: main.id,
      expiry_date: null,
      quantity: undated,
    }, today));
  }
  return sources;
}

export async function sellableQuantity(db, productId, todayYmd = shopTodayYmd()) {
  const product = await productRow(db, productId);
  if (!product || product.location_status === NEEDS_RECONCILIATION) return 0;
  const { main } = await operationalWarehouses(db);
  if (!main) return 0;
  const sources = await listWarehouseSources(db, main.id, productId);
  let total = 0;
  for (const source of sources) {
    if (source.batch_source === "dated") {
      if (!isExpiredOn(source.expiry_date, todayYmd)) total = round6(total + source.quantity);
    } else if (undatedIsSellable(product.expiry_date, todayYmd)) {
      total = round6(total + Math.max(0, source.quantity));
    }
  }
  return round6(Math.max(0, total));
}

export function assertSellable(available, requested) {
  const need = round6(requested);
  const have = round6(available);
  if (!(need > 0)) throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  if (have <= EPS) throw badRequest(NO_SELLABLE_MESSAGE, "NO_SELLABLE_STOCK");
  if (need > have + EPS) throw badRequest(INSUFFICIENT_SELLABLE_MESSAGE, "INSUFFICIENT_SELLABLE");
}

/**
 * FEFO among eligible main-warehouse sources. Preferred expiry is honored
 * only when that source is itself eligible.
 */
export function planEligibleAllocations(sources, quantity, { preferred = null, productExpiry = null, today = shopTodayYmd() } = {}) {
  const need = round6(quantity);
  const eligible = sources
    .filter((source) => source.quantity > EPS)
    .filter((source) => {
      if (source.batch_source === "undated") return undatedIsSellable(productExpiry, today);
      return !isExpiredOn(source.expiry_date, today);
    })
    .map((source) => ({ ...source, quantity: round6(source.quantity) }));
  eligible.sort((a, b) => {
    if (a.batch_source !== b.batch_source) return a.batch_source === "dated" ? -1 : 1;
    const expiryDiff = String(a.expiry_date || "").localeCompare(String(b.expiry_date || ""));
    if (expiryDiff !== 0) return expiryDiff;
    const receiptDiff = (Number(a.receipt_order) || 0) - (Number(b.receipt_order) || 0);
    if (receiptDiff !== 0) return receiptDiff;
    return (Number(a.source_lot_id) || 0) - (Number(b.source_lot_id) || 0);
  });
  const pref = preferred == null || preferred === "auto" ? null : preferred;
  const ordered = [];
  if (pref && pref !== "__unknown__") {
    const ymd = normalizeExpiryDate(pref);
    for (const source of eligible) {
      if (source.expiry_date === ymd) ordered.push(source);
    }
  } else if (pref === "__unknown__") {
    for (const source of eligible) {
      if (source.batch_source === "undated") ordered.push(source);
    }
  }
  for (const source of eligible) {
    if (!ordered.includes(source)) ordered.push(source);
  }
  let remaining = need;
  const out = [];
  for (const source of ordered) {
    if (remaining <= EPS) break;
    const take = round6(Math.min(source.quantity, remaining));
    if (take <= EPS) continue;
    source.quantity = round6(source.quantity - take);
    remaining = round6(remaining - take);
    out.push({
      expiry_date: source.expiry_date,
      quantity: take,
      warehouse_id: source.warehouse_id,
      batch_source: source.batch_source,
      source_lot_id: source.source_lot_id || null,
      supplier_id: source.supplier_id || null,
      purchase_invoice_id: source.purchase_invoice_id || null,
      purchase_invoice_item_id: source.purchase_invoice_item_id || null,
      source_provenance: source.provenance || null,
      received_at: source.received_at || null,
    });
  }
  if (remaining > EPS) {
    const have = round6(need - remaining);
    assertSellable(have, need);
  }
  return out;
}

export async function planSellableAllocations(db, productId, quantity, preferred = null) {
  const product = await productRow(db, productId);
  if (!product || product.location_status === NEEDS_RECONCILIATION) {
    throw badRequest(NO_SELLABLE_MESSAGE, "NO_SELLABLE_STOCK");
  }
  const { main } = await operationalWarehouses(db);
  const today = shopTodayYmd();
  const sources = main ? await listWarehouseSources(db, main.id, productId) : [];
  return planEligibleAllocations(sources, quantity, {
    preferred,
    productExpiry: product.expiry_date,
    today,
  });
}

/** Every source in the warehouse, earliest expiry first, then undated. Expired lots are included. */
export function planWarehouseTake(sources, quantity) {
  const ordered = sources
    .filter((source) => source.quantity > EPS)
    .map((source) => ({ ...source }))
    .sort((a, b) => {
      if (a.batch_source !== b.batch_source) return a.batch_source === "dated" ? -1 : 1;
      const expiryDiff = String(a.expiry_date || "").localeCompare(String(b.expiry_date || ""));
      if (expiryDiff !== 0) return expiryDiff;
      const receiptDiff = (Number(a.receipt_order) || 0) - (Number(b.receipt_order) || 0);
      if (receiptDiff !== 0) return receiptDiff;
      return (Number(a.source_lot_id) || 0) - (Number(b.source_lot_id) || 0);
    });
  let remaining = round6(quantity);
  const out = [];
  for (const source of ordered) {
    if (remaining <= EPS) break;
    const take = round6(Math.min(source.quantity, remaining));
    if (take <= EPS) continue;
    remaining = round6(remaining - take);
    out.push({
      batch_source: source.batch_source,
      expiry_date: source.expiry_date,
      quantity: take,
      warehouse_id: source.warehouse_id,
      source_lot_id: source.source_lot_id || null,
      supplier_id: source.supplier_id || null,
      purchase_invoice_id: source.purchase_invoice_id || null,
      purchase_invoice_item_id: source.purchase_invoice_item_id || null,
      source_provenance: source.provenance || null,
      received_at: source.received_at || null,
    });
  }
  if (remaining > EPS) {
    throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
  }
  return out;
}

export async function moveWarehouseQuantity(db, {
  productId,
  fromWarehouseId,
  toWarehouseId,
  expiryDate,
  quantity,
  sourceLotId = null,
}) {
  const qty = round6(quantity);
  if (!(qty > 0)) throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  if (Number(fromWarehouseId) === Number(toWarehouseId)) {
    throw badRequest("المستودعان متطابقان", "VALIDATION_ERROR");
  }
  const moved = await moveSourceLots(db, {
    productId,
    fromWarehouseId,
    toWarehouseId,
    expiryDate,
    quantity: qty,
    sourceLotId,
  });
  await addWarehouseQuantity(db, {
    warehouseId: fromWarehouseId,
    productId,
    expiryDate,
    delta: -qty,
    sourcePolicy: "skip",
  });
  await addWarehouseQuantity(db, {
    warehouseId: toWarehouseId,
    productId,
    expiryDate,
    delta: qty,
    sourcePolicy: "skip",
  });
  return moved;
}

export async function displayedWarehouseQuantities(db, productId) {
  const product = await productRow(db, productId);
  if (!product) return null;
  const { main, returns } = await operationalWarehouses(db);
  const reconciliation = product.location_status === NEEDS_RECONCILIATION;
  const located = await locationRows(db, productId);
  if (!reconciliation && located.length && main) {
    const sum = (id) => located
      .filter((row) => Number(row.warehouse_id) === Number(id))
      .reduce((total, row) => round6(total + row.quantity), 0);
    return {
      company: round6(Number(product.stock) || 0),
      main: main ? sum(main.id) : 0,
      returns: returns ? sum(returns.id) : 0,
      reconciliation_required: false,
    };
  }
  const away = main
    ? await db.get(
      `SELECT COALESCE(SUM(ws.quantity), 0) AS qty
         FROM warehouse_stock ws
        WHERE ws.product_id = ? AND ws.warehouse_id != ?`,
      [product.id, main.id]
    )
    : { qty: 0 };
  const returnsQty = returns
    ? await db.get(
      "SELECT COALESCE(quantity, 0) AS qty FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
      [returns.id, product.id]
    )
    : { qty: 0 };
  return {
    company: round6(Number(product.stock) || 0),
    main: round6((Number(product.stock) || 0) - (Number(away?.qty) || 0)),
    returns: round6(Number(returnsQty?.qty) || 0),
    reconciliation_required: reconciliation,
  };
}

export async function expiredOnMain(db, productId = null) {
  const { main } = await operationalWarehouses(db);
  if (!main) return [];
  const today = shopTodayYmd();
  const products = productId
    ? await db.all(
      "SELECT id, name, barcode, sku, expiry_date FROM products WHERE id = ?",
      [Number(productId)]
    )
    : await db.all(
      `SELECT id, name, barcode, sku, expiry_date FROM products
        WHERE COALESCE(is_active, 1) = 1
          AND COALESCE(location_status, 'located') != 'needs_reconciliation'`
    );
  const out = [];
  for (const product of products) {
    const sources = await listWarehouseSources(db, main.id, product.id);
    for (const source of sources) {
      if (!(source.quantity > EPS)) continue;
      if (source.batch_source === "dated" && source.expired) {
        out.push({
          product_id: product.id,
          name: product.name,
          barcode: product.barcode,
          sku: product.sku,
          expiry_date: source.expiry_date,
          quantity: source.quantity,
          batch_source: "dated",
          warehouse_id: main.id,
          source_lot_id: source.source_lot_id || null,
          supplier_id: source.supplier_id || null,
          supplier_name: source.supplier_name || null,
          receipt_reference: source.show_receipt_reference ? source.receipt_reference : null,
        });
      } else if (source.batch_source === "undated" && !undatedIsSellable(product.expiry_date, today)) {
        out.push({
          product_id: product.id,
          name: product.name,
          barcode: product.barcode,
          sku: product.sku,
          expiry_date: normalizeExpiryDate(product.expiry_date),
          quantity: source.quantity,
          batch_source: "undated",
          warehouse_id: main.id,
          source_lot_id: source.source_lot_id || null,
          supplier_id: source.supplier_id || null,
          supplier_name: source.supplier_name || null,
          receipt_reference: source.show_receipt_reference ? source.receipt_reference : null,
        });
      }
    }
  }
  out.sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)) || String(a.name).localeCompare(String(b.name)));
  return out;
}

/**
 * Assign an already-counted physical split. Quantities must match the company
 * batches and the undated remainder. Nothing is invented and stock value
 * does not change.
 */
async function legacyQuantityMove(db, fromWarehouseId, toWarehouseId, productId, quantity) {
  const qty = round6(quantity);
  for (const [warehouseId, delta] of [[fromWarehouseId, -qty], [toWarehouseId, qty]]) {
    const row = await db.get(
      "SELECT id, quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
      [Number(warehouseId), Number(productId)]
    );
    if (row) {
      await db.run("UPDATE warehouse_stock SET quantity = quantity + ? WHERE id = ?", [delta, row.id]);
    } else {
      await db.run(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, ?)",
        [Number(warehouseId), Number(productId), delta]
      );
    }
  }
}

/**
 * Move transfer lines between the two operational warehouses.
 * Explicit sources are required to match stock on hand. A line without a
 * source takes earliest-expiry stock, including expired lots, and the chosen
 * source is returned so it can be stored on the document.
 * Products still awaiting reconciliation keep the historical quantity move
 * and do not receive a guessed batch.
 */
export async function applyPostedTransfer(db, { fromWarehouseId, toWarehouseId, items }) {
  const byProduct = new Map();
  for (const item of items) {
    const list = byProduct.get(Number(item.product_id)) || [];
    list.push(item);
    byProduct.set(Number(item.product_id), list);
  }
  const resolved = [];
  for (const [productId, lines] of byProduct) {
    const product = await productRow(db, productId);
    if (!product) throw badRequest("المنتج غير موجود", "NOT_FOUND");
    const byLot = new Map();
    const explicit = new Map();
    let autoQty = 0;
    for (const line of lines) {
      const dated = Boolean(normalizeExpiryDate(line.expiry_date));
      const source = line.batch_source === "undated" || line.batch_source === "dated"
        ? line.batch_source
        : (dated ? "dated" : null);
      const qty = round6(Number(line.quantity) || 0);
      if (!(qty > 0)) throw badRequest("كمية غير صالحة", "VALIDATION_ERROR");
      const lotId = Number(line.source_lot_id) || null;
      if (lotId) {
        byLot.set(lotId, round6((byLot.get(lotId) || 0) + qty));
        continue;
      }
      if (!source) {
        autoQty = round6(autoQty + qty);
        continue;
      }
      if (source === "dated" && !dated) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
      if (source === "undated" && dated) throw badRequest("المخزون غير المحدد لا يحمل تاريخ صلاحية", "EXPIRY_UNEXPECTED");
      const key = source === "undated" ? UNDATED_KEY : normalizeExpiryDate(line.expiry_date);
      explicit.set(key, round6((explicit.get(key) || 0) + qty));
    }
    if (product.location_status === NEEDS_RECONCILIATION) {
      if (explicit.size) {
        throw badRequest("هذا الصنف بانتظار جرد المستودع قبل تحريك الكمية", "RECONCILIATION_REQUIRED");
      }
      await legacyQuantityMove(db, fromWarehouseId, toWarehouseId, productId, autoQty);
      resolved.push({
        product_id: productId,
        quantity: autoQty,
        batch_source: null,
        expiry_date: null,
        legacy: true,
      });
      continue;
    }
    await ensureMaterialized(db, productId);
    const sources = await listWarehouseSources(db, fromWarehouseId, productId);
    const lotAvailable = new Map();
    const available = new Map();
    for (const source of sources) {
      const key = source.batch_source === "undated" ? UNDATED_KEY : source.expiry_date;
      available.set(key, round6((available.get(key) || 0) + source.quantity));
      if (source.source_lot_id) lotAvailable.set(Number(source.source_lot_id), source);
    }
    const pushMoved = (parts) => {
      for (const part of parts) {
        resolved.push({
          product_id: productId,
          quantity: part.quantity,
          batch_source: part.batch_source || (part.expiry_date ? "dated" : "undated"),
          expiry_date: part.expiry_date || null,
          source_lot_id: part.source_lot_id || null,
          origin_lot_id: part.origin_lot_id || null,
          supplier_id: part.supplier_id || null,
          purchase_invoice_id: part.purchase_invoice_id || null,
          purchase_invoice_item_id: part.purchase_invoice_item_id || null,
          source_provenance: part.provenance || part.source_provenance || null,
          received_at: part.received_at || null,
          legacy: false,
        });
      }
    };
    for (const [lotId, qty] of byLot) {
      const lot = lotAvailable.get(lotId);
      if (!lot || qty > lot.quantity + EPS) {
        throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
      }
      const key = lot.batch_source === "undated" ? UNDATED_KEY : lot.expiry_date;
      available.set(key, round6((available.get(key) || 0) - qty));
      const parts = await moveWarehouseQuantity(db, {
        productId,
        fromWarehouseId,
        toWarehouseId,
        expiryDate: lot.expiry_date,
        quantity: qty,
        sourceLotId: lotId,
      });
      pushMoved(parts);
    }
    for (const [key, qty] of explicit) {
      const have = available.get(key) || 0;
      if (qty > have + EPS) throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
      available.set(key, round6(have - qty));
      const parts = await moveWarehouseQuantity(db, {
        productId,
        fromWarehouseId,
        toWarehouseId,
        expiryDate: key || null,
        quantity: qty,
      });
      pushMoved(parts);
    }
    if (autoQty > EPS) {
      const pool = sources.map((source) => ({ ...source }));
      for (const row of pool) {
        const reserved = row.source_lot_id ? (byLot.get(Number(row.source_lot_id)) || 0) : 0;
        if (reserved) row.quantity = round6(Math.max(0, row.quantity - reserved));
      }
      for (const [key, qty] of explicit) {
        let left = qty;
        for (const row of pool) {
          const rowKey = row.batch_source === "undated" ? UNDATED_KEY : row.expiry_date;
          if (rowKey !== key || left <= EPS || row.quantity <= EPS) continue;
          const take = round6(Math.min(row.quantity, left));
          row.quantity = round6(row.quantity - take);
          left = round6(left - take);
        }
      }
      const parts = planWarehouseTake(pool.filter((row) => row.quantity > EPS), autoQty);
      for (const part of parts) {
        const moved = await moveWarehouseQuantity(db, {
          productId,
          fromWarehouseId,
          toWarehouseId,
          expiryDate: part.expiry_date,
          quantity: part.quantity,
          sourceLotId: part.source_lot_id,
        });
        pushMoved(moved);
      }
    }
  }
  return resolved;
}

export async function reconcileProductLocations(db, productId, lines) {
  const product = await productRow(db, productId);
  if (!product) throw badRequest("المنتج غير موجود", "NOT_FOUND");
  const { main, returns } = await operationalWarehouses(db);
  const allowed = new Set([main?.id, returns?.id].filter(Boolean).map(Number));
  const dated = await db.all(
    `SELECT expiry_date, quantity FROM product_batches
      WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != ''`,
    [product.id]
  );
  const expected = new Map();
  let datedSum = 0;
  for (const batch of dated) {
    const key = normalizeExpiryDate(batch.expiry_date);
    const qty = round6(Number(batch.quantity) || 0);
    datedSum = round6(datedSum + qty);
    if (Math.abs(qty) > EPS) expected.set(key, qty);
  }
  const undated = round6((Number(product.stock) || 0) - datedSum);
  if (Math.abs(undated) > EPS) expected.set(UNDATED_KEY, undated);

  const got = new Map();
  for (const line of lines || []) {
    const warehouseId = Number(line.warehouse_id);
    if (!allowed.has(warehouseId)) throw badRequest("المستودع غير تشغيلي", "WAREHOUSE_NOT_OPERATIONAL");
    const key = line.batch_source === "undated" ? UNDATED_KEY : expiryKey(line.expiry_date);
    if (line.batch_source === "dated" && !key) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
    if (line.batch_source === "undated" && line.expiry_date) {
      throw badRequest("المخزون غير المحدد لا يحمل تاريخ صلاحية", "EXPIRY_UNEXPECTED");
    }
    const qty = round6(Number(line.quantity) || 0);
    if (qty < -EPS) throw badRequest("الكمية المعدودة غير صالحة", "VALIDATION_ERROR");
    got.set(key, round6((got.get(key) || 0) + qty));
    line._key = key;
    line._qty = qty;
    line._warehouseId = warehouseId;
  }
  for (const [key, qty] of expected) {
    if (Math.abs((got.get(key) || 0) - qty) > 1e-6) {
      throw badRequest("جرد المستودعات لا يطابق كميات الدفعات الحالية", "RECONCILIATION_MISMATCH");
    }
  }
  for (const [key, qty] of got) {
    if (Math.abs(qty) > EPS && !expected.has(key)) {
      throw badRequest("جرد المستودعات لا يطابق كميات الدفعات الحالية", "RECONCILIATION_MISMATCH");
    }
  }

  await clearProductLocations(db, product.id);
  for (const line of lines || []) {
    if (line._qty <= EPS) continue;
    await addWarehouseQuantity(db, {
      warehouseId: line._warehouseId,
      productId: product.id,
      expiryDate: line._key || null,
      delta: line._qty,
    });
  }
  await db.run("UPDATE products SET location_status = ? WHERE id = ?", [LOCATED, product.id]);
  return displayedWarehouseQuantities(db, product.id);
}
