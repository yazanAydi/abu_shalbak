/**
 * Supplier and receipt quantities under the company batch and warehouse totals.
 * Stock and value stay on products, product_batches, and warehouse_batch_stock.
 * A source lot only says which supplier receipt those units came from.
 */

import { round6 } from "../utils/purchaseInventoryCost.js";
import { badRequest } from "../utils/httpError.js";
import { normalizeExpiryDate } from "../utils/expiryDate.js";

const EPS = 1e-9;
export const UNKNOWN_SUPPLIER_LABEL = "غير معروف";
export const SEVERAL_SUPPLIERS_LABEL = "عدة موردين";

function expiryStorageKey(value) {
  if (value == null || String(value).trim() === "") return "";
  return normalizeExpiryDate(value) || "";
}

function partFrom(lot, quantity) {
  const expiry = lot.expiry_date ? normalizeExpiryDate(lot.expiry_date) : null;
  return {
    source_lot_id: Number(lot.id),
    supplier_id: lot.supplier_id != null ? Number(lot.supplier_id) : null,
    purchase_invoice_id: lot.purchase_invoice_id != null ? Number(lot.purchase_invoice_id) : null,
    purchase_invoice_item_id: lot.purchase_invoice_item_id != null ? Number(lot.purchase_invoice_item_id) : null,
    provenance: lot.provenance || "unknown",
    received_at: lot.received_at || null,
    expiry_date: expiry,
    warehouse_id: Number(lot.warehouse_id),
    quantity: round6(quantity),
    batch_source: expiry ? "dated" : "undated",
    supplier_name: lot.supplier_name || null,
  };
}

async function insertLot(db, spec) {
  const key = expiryStorageKey(spec.expiryDate ?? spec.expiry);
  const qty = round6(spec.quantity);
  const provenance = spec.provenance || "unknown";
  const ins = await db.run(
    `INSERT INTO stock_source_lots (
       product_id, warehouse_id, expiry_date, supplier_id,
       purchase_invoice_id, purchase_invoice_item_id, quantity, provenance,
       received_at, assigned_by, assigned_at, assignment_note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)`,
    [
      Number(spec.productId),
      Number(spec.warehouseId),
      key,
      spec.supplierId != null ? Number(spec.supplierId) : null,
      spec.purchaseInvoiceId != null ? Number(spec.purchaseInvoiceId) : null,
      spec.purchaseInvoiceItemId != null ? Number(spec.purchaseInvoiceItemId) : null,
      qty,
      provenance,
      spec.receivedAt || null,
      spec.assignedBy != null ? Number(spec.assignedBy) : null,
      spec.assignedAt || null,
      spec.note || null,
    ]
  );
  return db.get("SELECT * FROM stock_source_lots WHERE id = ?", [ins.lastID]);
}

export async function listSourceLots(db, {
  productId,
  warehouseId = null,
  supplierId = null,
  attributedOnly = false,
  includeEmpty = false,
} = {}) {
  const params = [Number(productId)];
  let sql = `SELECT l.*, s.name AS supplier_name, pi.invoice_no
               FROM stock_source_lots l
               LEFT JOIN suppliers s ON s.id = l.supplier_id
               LEFT JOIN purchase_invoices pi ON pi.id = l.purchase_invoice_id
              WHERE l.product_id = ?`;
  if (!includeEmpty) {
    sql += " AND l.quantity > ?";
    params.push(EPS);
  }
  if (warehouseId) {
    sql += " AND l.warehouse_id = ?";
    params.push(Number(warehouseId));
  }
  if (supplierId) {
    sql += " AND l.supplier_id = ?";
    params.push(Number(supplierId));
  }
  if (attributedOnly) {
    sql += " AND l.supplier_id IS NOT NULL AND l.provenance IN ('receipt', 'assigned')";
  }
  sql += " ORDER BY l.expiry_date, l.received_at, l.id";
  const rows = await db.all(sql, params);
  return rows.map((row) => ({
    ...row,
    quantity: round6(Number(row.quantity) || 0),
    expiry_date: row.expiry_date ? normalizeExpiryDate(row.expiry_date) : null,
    receipt_reference: receiptReference(row),
  }));
}

export function receiptReference(row) {
  if (!row) return null;
  if (row.invoice_no != null && String(row.invoice_no).trim() !== "") return `فاتورة ${row.invoice_no}`;
  if (row.purchase_invoice_id) return `فاتورة ${row.purchase_invoice_id}`;
  if (row.purchase_invoice_item_id) return `سند ${row.purchase_invoice_item_id}`;
  return null;
}

/**
 * Remaining supplier or unknown lots physically in the returns warehouse.
 * Catalog SQL is the department scope already built for warehouse reports.
 */
export async function listReturnsWarehouseLots(db, {
  warehouseId,
  supplierId = null,
  unknownOnly = false,
  catalogSql = "",
  catalogParams = [],
  limit = 25,
  offset = 0,
} = {}) {
  const params = [Number(warehouseId), EPS];
  let where = "l.warehouse_id = ? AND l.quantity > ?";
  if (unknownOnly) {
    where += " AND (l.provenance = 'unknown' OR l.supplier_id IS NULL)";
  } else {
    where += " AND l.supplier_id = ? AND l.provenance IN ('receipt', 'assigned')";
    params.push(Number(supplierId));
  }
  where += catalogSql || "";
  params.push(...catalogParams);
  const from = `FROM stock_source_lots l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN purchase_invoices pi ON pi.id = l.purchase_invoice_id
    WHERE ${where}`;
  const totalRow = await db.get(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await db.all(
    `SELECT l.id AS source_lot_id, l.product_id, p.name AS product_name, p.barcode, p.sku,
            l.expiry_date, l.quantity, l.supplier_id, l.provenance,
            l.purchase_invoice_id, l.purchase_invoice_item_id, l.received_at,
            s.name AS supplier_name, pi.invoice_no,
            (SELECT COUNT(*) FROM stock_source_lots s2
              WHERE s2.product_id = l.product_id
                AND s2.warehouse_id = l.warehouse_id
                AND IFNULL(s2.supplier_id, 0) = IFNULL(l.supplier_id, 0)
                AND s2.expiry_date = l.expiry_date
                AND s2.quantity > ?
                AND s2.provenance IN ('receipt', 'assigned')) AS sibling_count
       ${from}
      ORDER BY p.name, l.expiry_date, l.received_at, l.id
      LIMIT ? OFFSET ?`,
    [EPS, ...params, limit, offset]
  );
  return {
    warehouse_id: Number(warehouseId),
    total: Number(totalRow?.n) || 0,
    limit,
    offset,
    rows: rows.map((row) => {
      const expiry = row.expiry_date ? normalizeExpiryDate(row.expiry_date) : null;
      const reference = receiptReference(row);
      const unknown = !row.supplier_id || row.provenance === "unknown";
      return {
        source_lot_id: Number(row.source_lot_id),
        product_id: Number(row.product_id),
        product_name: row.product_name,
        barcode: row.barcode || "",
        sku: row.sku || "",
        expiry_date: expiry,
        batch_source: expiry ? "dated" : "undated",
        quantity: round6(Number(row.quantity) || 0),
        supplier_id: unknown ? null : Number(row.supplier_id),
        supplier_name: unknown ? UNKNOWN_SUPPLIER_LABEL : (row.supplier_name || UNKNOWN_SUPPLIER_LABEL),
        provenance: unknown ? "unknown" : row.provenance,
        purchase_invoice_id: row.purchase_invoice_id != null ? Number(row.purchase_invoice_id) : null,
        purchase_invoice_item_id: row.purchase_invoice_item_id != null ? Number(row.purchase_invoice_item_id) : null,
        receipt_reference: reference,
        show_receipt_reference: !unknown && Number(row.sibling_count) > 1 && Boolean(reference),
        warehouse_id: Number(warehouseId),
        eligible: !unknown,
        received_at: row.received_at || null,
      };
    }),
  };
}

export function markReceiptReferences(lots) {
  const counts = new Map();
  for (const lot of lots) {
    const key = `${lot.supplier_id || 0}:${lot.expiry_date || ""}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return lots.map((lot) => {
    const key = `${lot.supplier_id || 0}:${lot.expiry_date || ""}`;
    const crowded = (counts.get(key) || 0) > 1;
    return {
      ...lot,
      show_receipt_reference: Boolean(crowded && (lot.receipt_reference || lot.purchase_invoice_item_id)),
    };
  });
}

/**
 * Add quantity to a receipt identity. The same purchase line on the same
 * warehouse and expiry stays one lot. A different receipt inserts a new lot.
 */
export async function addSourceIdentity(db, spec) {
  const qty = round6(spec.quantity);
  if (!(qty > 0)) return null;
  const key = expiryStorageKey(spec.expiryDate ?? spec.expiry);
  const provenance = spec.provenance || (spec.supplierId ? "receipt" : "unknown");
  const supplierId = spec.supplierId != null ? Number(spec.supplierId) : null;
  const itemId = spec.purchaseInvoiceItemId != null ? Number(spec.purchaseInvoiceItemId) : null;

  if (spec.sourceLotId) {
    const named = await db.get("SELECT * FROM stock_source_lots WHERE id = ?", [Number(spec.sourceLotId)]);
    if (named && Number(named.warehouse_id) === Number(spec.warehouseId) && (named.expiry_date || "") === key) {
      await db.run("UPDATE stock_source_lots SET quantity = quantity + ? WHERE id = ?", [qty, named.id]);
      return db.get("SELECT * FROM stock_source_lots WHERE id = ?", [named.id]);
    }
  }

  const existing = await db.get(
    `SELECT * FROM stock_source_lots
      WHERE product_id = ? AND warehouse_id = ? AND expiry_date = ?
        AND provenance = ?
        AND IFNULL(supplier_id, 0) = IFNULL(?, 0)
        AND IFNULL(purchase_invoice_item_id, 0) = IFNULL(?, 0)
      ORDER BY id ASC LIMIT 1`,
    [Number(spec.productId), Number(spec.warehouseId), key, provenance, supplierId, itemId]
  );
  if (existing) {
    await db.run("UPDATE stock_source_lots SET quantity = quantity + ? WHERE id = ?", [qty, existing.id]);
    if (spec.receivedAt && (!existing.received_at || String(spec.receivedAt) < String(existing.received_at))) {
      await db.run("UPDATE stock_source_lots SET received_at = ? WHERE id = ?", [spec.receivedAt, existing.id]);
    }
    return db.get("SELECT * FROM stock_source_lots WHERE id = ?", [existing.id]);
  }
  return insertLot(db, { ...spec, expiryDate: key, provenance, supplierId, purchaseInvoiceItemId: itemId, quantity: qty });
}

export async function takeSourceLots(db, {
  productId,
  warehouseId,
  expiryDate = null,
  quantity,
  sourceLotId = null,
  supplierId = null,
  attributedOnly = false,
}) {
  const need = round6(quantity);
  if (!(need > 0)) throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  const key = expiryStorageKey(expiryDate);

  if (sourceLotId) {
    const lot = await db.get(
      `SELECT l.*, s.name AS supplier_name
         FROM stock_source_lots l
         LEFT JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.id = ?`,
      [Number(sourceLotId)]
    );
    if (!lot || Number(lot.product_id) !== Number(productId)) {
      throw badRequest("المصدر غير موجود", "SOURCE_NOT_FOUND");
    }
    if (Number(lot.warehouse_id) !== Number(warehouseId)) {
      throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
    }
    if ((lot.expiry_date || "") !== key) {
      throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
    }
    if (attributedOnly && (!lot.supplier_id || lot.provenance === "unknown" || (supplierId && Number(lot.supplier_id) !== Number(supplierId)))) {
      throw badRequest("لا يمكن إرجاع بضاعة مورّد آخر", "WRONG_SUPPLIER");
    }
    const have = round6(Number(lot.quantity) || 0);
    if (have + EPS < need) throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
    await db.run("UPDATE stock_source_lots SET quantity = ? WHERE id = ?", [round6(have - need), lot.id]);
    return [partFrom(lot, need)];
  }

  const params = [Number(productId), Number(warehouseId), key, EPS];
  let sql = `SELECT l.*, s.name AS supplier_name
               FROM stock_source_lots l
               LEFT JOIN suppliers s ON s.id = l.supplier_id
              WHERE l.product_id = ? AND l.warehouse_id = ? AND l.expiry_date = ? AND l.quantity > ?`;
  if (supplierId) {
    sql += " AND l.supplier_id = ?";
    params.push(Number(supplierId));
  }
  if (attributedOnly) {
    sql += " AND l.supplier_id IS NOT NULL AND l.provenance IN ('receipt', 'assigned')";
  }
  sql += " ORDER BY l.received_at ASC, l.id ASC";
  const lots = await db.all(sql, params);
  let remaining = need;
  const parts = [];
  for (const lot of lots) {
    if (remaining <= EPS) break;
    const have = round6(Number(lot.quantity) || 0);
    const take = round6(Math.min(have, remaining));
    if (take <= EPS) continue;
    await db.run("UPDATE stock_source_lots SET quantity = ? WHERE id = ?", [round6(have - take), lot.id]);
    remaining = round6(remaining - take);
    parts.push(partFrom(lot, take));
  }
  if (remaining > EPS) {
    if (attributedOnly) {
      const others = await db.get(
        `SELECT COUNT(*) AS n FROM stock_source_lots
          WHERE product_id = ? AND warehouse_id = ? AND expiry_date = ? AND quantity > ?
            AND (supplier_id IS NULL OR supplier_id != ? OR provenance = 'unknown')`,
        [Number(productId), Number(warehouseId), key, EPS, supplierId != null ? Number(supplierId) : 0]
      );
      if (Number(others?.n) > 0) {
        throw badRequest("لا يمكن إرجاع بضاعة مورّد آخر", "WRONG_SUPPLIER");
      }
    }
    throw badRequest("الكمية غير متاحة في المستودع", "INSUFFICIENT_WAREHOUSE_QTY");
  }
  return parts;
}

export async function moveSourceLots(db, {
  productId,
  fromWarehouseId,
  toWarehouseId,
  expiryDate = null,
  quantity,
  sourceLotId = null,
}) {
  const parts = await takeSourceLots(db, {
    productId,
    warehouseId: fromWarehouseId,
    expiryDate,
    quantity,
    sourceLotId,
  });
  const moved = [];
  for (const part of parts) {
    const dest = await addSourceIdentity(db, {
      productId,
      warehouseId: toWarehouseId,
      expiryDate: part.expiry_date || "",
      quantity: part.quantity,
      supplierId: part.supplier_id,
      purchaseInvoiceId: part.purchase_invoice_id,
      purchaseInvoiceItemId: part.purchase_invoice_item_id,
      provenance: part.provenance,
      receivedAt: part.received_at,
    });
    moved.push({
      ...part,
      origin_lot_id: part.source_lot_id,
      source_lot_id: dest.id,
      warehouse_id: Number(toWarehouseId),
    });
  }
  return moved;
}

export async function zeroSourceLots(db, productId, expiryKey = null) {
  if (expiryKey == null) {
    await db.run("UPDATE stock_source_lots SET quantity = 0 WHERE product_id = ?", [Number(productId)]);
    return;
  }
  await db.run(
    "UPDATE stock_source_lots SET quantity = 0 WHERE product_id = ? AND expiry_date = ?",
    [Number(productId), expiryStorageKey(expiryKey)]
  );
}

async function locationRows(db, productId) {
  return db.all(
    `SELECT warehouse_id, expiry_date, quantity
       FROM warehouse_batch_stock
      WHERE product_id = ? AND ABS(quantity) > ?`,
    [Number(productId), EPS]
  );
}

async function unambiguousPlan(db, productId, expiryKey, whRows) {
  const purchases = await db.all(
    `SELECT a.quantity, a.invoice_item_id, a.created_at,
            pi.supplier_id, pi.id AS invoice_id
       FROM stock_batch_allocations a
       JOIN purchase_invoice_items pii ON pii.id = a.invoice_item_id
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id
      WHERE a.product_id = ?
        AND a.direction = 'in'
        AND a.reference_type = 'purchase_invoice'
        AND IFNULL(a.expiry_date, '') = ?
        AND a.invoice_item_id IS NOT NULL`,
    [Number(productId), expiryKey]
  );
  const other = await db.get(
    `SELECT COUNT(*) AS n FROM stock_batch_allocations
      WHERE product_id = ? AND direction = 'in'
        AND reference_type NOT IN ('purchase_invoice', 'warehouse_transfer')
        AND IFNULL(expiry_date, '') = ?`,
    [Number(productId), expiryKey]
  );
  if (Number(other?.n) > 0 || purchases.length === 0) return null;

  const groups = new Map();
  for (const row of purchases) {
    const id = Number(row.invoice_item_id);
    const current = groups.get(id) || {
      invoice_item_id: id,
      invoice_id: row.invoice_id,
      supplier_id: row.supplier_id,
      quantity: 0,
      created_at: row.created_at,
    };
    current.quantity = round6(current.quantity + (Number(row.quantity) || 0));
    if (row.created_at && (!current.created_at || String(row.created_at) < String(current.created_at))) {
      current.created_at = row.created_at;
    }
    groups.set(id, current);
  }
  const receipts = [...groups.values()];
  const received = receipts.reduce((sum, row) => round6(sum + row.quantity), 0);
  const onHand = whRows.reduce((sum, row) => round6(sum + (Number(row.quantity) || 0)), 0);
  if (onHand <= EPS || onHand > received + 1e-4) return null;

  const positiveWh = whRows.filter((row) => Math.abs(Number(row.quantity) || 0) > EPS);
  if (receipts.length === 1) {
    return positiveWh.map((row) => ({
      productId,
      warehouseId: row.warehouse_id,
      expiryDate: expiryKey,
      quantity: round6(Number(row.quantity) || 0),
      supplierId: receipts[0].supplier_id,
      purchaseInvoiceId: receipts[0].invoice_id,
      purchaseInvoiceItemId: receipts[0].invoice_item_id,
      provenance: "receipt",
      receivedAt: receipts[0].created_at,
    }));
  }

  const outs = await db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_batch_allocations
      WHERE product_id = ? AND direction = 'out'
        AND reference_type NOT IN ('warehouse_transfer')
        AND IFNULL(expiry_date, '') = ?`,
    [Number(productId), expiryKey]
  );
  if ((Number(outs?.qty) || 0) > 1e-6) return null;
  if (Math.abs(onHand - received) > 1e-4) return null;
  if (positiveWh.length !== 1) return null;
  const wh = positiveWh[0];
  return receipts.map((row) => ({
    productId,
    warehouseId: wh.warehouse_id,
    expiryDate: expiryKey,
    quantity: row.quantity,
    supplierId: row.supplier_id,
    purchaseInvoiceId: row.invoice_id,
    purchaseInvoiceItemId: row.invoice_item_id,
    provenance: "receipt",
    receivedAt: row.created_at,
  }));
}

async function fillGaps(db, productId, locations) {
  for (const row of locations) {
    const key = row.expiry_date || "";
    const sum = await db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_source_lots
        WHERE product_id = ? AND warehouse_id = ? AND expiry_date = ?`,
      [Number(productId), Number(row.warehouse_id), key]
    );
    const gap = round6((Number(row.quantity) || 0) - (Number(sum?.qty) || 0));
    if (gap > 1e-6) {
      await insertLot(db, {
        productId,
        warehouseId: row.warehouse_id,
        expiryDate: key,
        quantity: gap,
        provenance: "unknown",
      });
    }
  }
}

/**
 * Create source lots for located stock once. Later calls only add an unknown
 * lot when a warehouse total has no matching source quantity. They do not
 * rebuild remaining stock from purchase history.
 */
export async function ensureProductSourceLots(db, productId) {
  const product = await db.get(
    "SELECT id, COALESCE(location_status, 'located') AS location_status FROM products WHERE id = ?",
    [Number(productId)]
  );
  if (!product || product.location_status === "needs_reconciliation") return { mode: "skipped" };
  const locations = await locationRows(db, product.id);
  if (!locations.length) return { mode: "empty" };
  const any = await db.get(
    "SELECT id FROM stock_source_lots WHERE product_id = ? LIMIT 1",
    [product.id]
  );
  if (any) {
    await fillGaps(db, product.id, locations);
    return { mode: "kept" };
  }
  const byExpiry = new Map();
  for (const row of locations) {
    const key = row.expiry_date || "";
    const list = byExpiry.get(key) || [];
    list.push(row);
    byExpiry.set(key, list);
  }
  for (const [key, rows] of byExpiry) {
    const plan = await unambiguousPlan(db, product.id, key, rows);
    if (plan) {
      for (const lot of plan) await insertLot(db, lot);
    } else {
      for (const row of rows) {
        const qty = round6(Number(row.quantity) || 0);
        if (Math.abs(qty) <= EPS) continue;
        await insertLot(db, {
          productId: product.id,
          warehouseId: row.warehouse_id,
          expiryDate: key,
          quantity: qty,
          provenance: "unknown",
        });
      }
    }
  }
  return { mode: "backfilled" };
}

export async function backfillAllSourceLots(db) {
  const products = await db.all("SELECT DISTINCT product_id FROM warehouse_batch_stock");
  for (const row of products) {
    await ensureProductSourceLots(db, row.product_id);
  }
}

export async function assignUnknownSource(db, {
  sourceLotId,
  supplierId,
  purchaseInvoiceItemId = null,
  quantity,
  userId = null,
  note = null,
}) {
  const lot = await db.get("SELECT * FROM stock_source_lots WHERE id = ?", [Number(sourceLotId)]);
  if (!lot) throw badRequest("المصدر غير موجود", "SOURCE_NOT_FOUND");
  if (lot.provenance !== "unknown" || lot.supplier_id) {
    throw badRequest("هذا المصدر منسوب مسبقاً", "SOURCE_ALREADY_ATTRIBUTED");
  }
  const qty = round6(quantity);
  const have = round6(Number(lot.quantity) || 0);
  if (!(qty > 0) || qty > have + EPS) {
    throw badRequest("الكمية أكبر من المتاح غير المعروف", "INSUFFICIENT_UNKNOWN");
  }
  const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [Number(supplierId)]);
  if (!supplier) throw badRequest("المورد غير موجود", "NOT_FOUND");
  let invoiceId = null;
  let itemId = null;
  if (purchaseInvoiceItemId) {
    const item = await db.get(
      `SELECT pii.id, pii.product_id, pi.supplier_id, pi.id AS invoice_id
         FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.invoice_id
        WHERE pii.id = ?`,
      [Number(purchaseInvoiceItemId)]
    );
    if (!item || Number(item.product_id) !== Number(lot.product_id) || Number(item.supplier_id) !== Number(supplier.id)) {
      throw badRequest("بند الشراء لا يطابق هذا الصنف والمورد", "SOURCE_NOT_FOUND");
    }
    invoiceId = item.invoice_id;
    itemId = item.id;
  }
  await db.run("UPDATE stock_source_lots SET quantity = ? WHERE id = ?", [round6(have - qty), lot.id]);
  const created = await addSourceIdentity(db, {
    productId: lot.product_id,
    warehouseId: lot.warehouse_id,
    expiryDate: lot.expiry_date || "",
    quantity: qty,
    supplierId: supplier.id,
    purchaseInvoiceId: invoiceId,
    purchaseInvoiceItemId: itemId,
    provenance: "assigned",
    receivedAt: lot.received_at,
    assignedBy: userId,
    assignedAt: new Date().toISOString(),
    note: note ? String(note).slice(0, 500) : null,
  });
  await db.run(
    `INSERT INTO stock_source_assignments (
       product_id, from_lot_id, to_lot_id, supplier_id, purchase_invoice_item_id,
       quantity, expiry_date, warehouse_id, note, assigned_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lot.product_id,
      lot.id,
      created.id,
      supplier.id,
      itemId,
      qty,
      lot.expiry_date || "",
      lot.warehouse_id,
      note ? String(note).slice(0, 500) : null,
      userId != null ? Number(userId) : null,
    ]
  );
  return {
    from_lot_id: lot.id,
    to_lot_id: created.id,
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    quantity: qty,
    purchase_invoice_item_id: itemId,
  };
}

function supplierLabelFrom(parts) {
  const named = parts.filter((row) => row.supplier_id && row.quantity > EPS);
  const unknown = parts.filter((row) => !row.supplier_id && row.quantity > EPS);
  const ids = new Set(named.map((row) => Number(row.supplier_id)));
  if (ids.size === 1 && unknown.length === 0) return named[0].supplier_name || UNKNOWN_SUPPLIER_LABEL;
  if (ids.size === 0) return UNKNOWN_SUPPLIER_LABEL;
  return SEVERAL_SUPPLIERS_LABEL;
}

export async function attachSupplierBreakdown(db, rows) {
  const ids = [...new Set((rows || []).map((row) => Number(row.product_id)).filter(Boolean))];
  if (!ids.length) return rows || [];
  const lots = await db.all(
    `SELECT l.product_id, l.expiry_date, l.supplier_id, l.quantity, l.provenance, l.id AS source_lot_id,
            l.purchase_invoice_id, l.purchase_invoice_item_id, l.received_at,
            s.name AS supplier_name, pi.invoice_no
       FROM stock_source_lots l
       LEFT JOIN suppliers s ON s.id = l.supplier_id
       LEFT JOIN purchase_invoices pi ON pi.id = l.purchase_invoice_id
      WHERE l.product_id IN (${ids.map(() => "?").join(",")})
        AND l.quantity > ?
      ORDER BY l.received_at, l.id`,
    [...ids, EPS]
  );
  return rows.map((row) => {
    const key = row.source === "batch" ? (normalizeExpiryDate(row.expiry_date) || "") : "";
    const mine = lots.filter((lot) => Number(lot.product_id) === Number(row.product_id) && (lot.expiry_date || "") === key);
    const bySupplier = new Map();
    for (const lot of mine) {
      const id = lot.supplier_id != null ? Number(lot.supplier_id) : 0;
      const current = bySupplier.get(id) || {
        supplier_id: lot.supplier_id != null ? Number(lot.supplier_id) : null,
        supplier_name: lot.supplier_id ? (lot.supplier_name || UNKNOWN_SUPPLIER_LABEL) : UNKNOWN_SUPPLIER_LABEL,
        quantity: 0,
        receipts: [],
      };
      const qty = round6(Number(lot.quantity) || 0);
      current.quantity = round6(current.quantity + qty);
      current.receipts.push({
        source_lot_id: lot.source_lot_id,
        quantity: qty,
        provenance: lot.provenance,
        purchase_invoice_id: lot.purchase_invoice_id,
        purchase_invoice_item_id: lot.purchase_invoice_item_id,
        receipt_reference: receiptReference(lot),
      });
      bySupplier.set(id, current);
    }
    let suppliers = [...bySupplier.values()];
    let covered = suppliers.reduce((sum, item) => round6(sum + item.quantity), 0);
    const target = round6(Number(row.stock) || 0);
    if (target - covered > 1e-6) {
      const gap = round6(target - covered);
      const unknown = suppliers.find((item) => !item.supplier_id);
      if (unknown) unknown.quantity = round6(unknown.quantity + gap);
      else suppliers.push({ supplier_id: null, supplier_name: UNKNOWN_SUPPLIER_LABEL, quantity: gap, receipts: [] });
      covered = target;
    } else if (covered - target > 1e-6) {
      let extra = round6(covered - target);
      for (let i = suppliers.length - 1; i >= 0 && extra > 1e-6; i -= 1) {
        const cut = round6(Math.min(suppliers[i].quantity, extra));
        suppliers[i].quantity = round6(suppliers[i].quantity - cut);
        extra = round6(extra - cut);
      }
      suppliers = suppliers.filter((item) => item.quantity > EPS);
    }
    const supplier_label = supplierLabelFrom(suppliers);
    return { ...row, suppliers, supplier_label };
  });
}
