import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals, productTaxRate, round2 } from "../utils/tax.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";
import { ensureDefaultProductUnit } from "../utils/productUnits.js";

function normalizeNote(note) {
  if (note == null) return null;
  const s = String(note).trim();
  return s || null;
}

async function normalizeSuspendLine(db, line, settings) {
  const productId = Number(line.product_id);
  const qty = Math.max(1, Number(line.quantity) || 1);
  const price = round2(Number(line.price));

  if (!Number.isFinite(price) || price < 0) {
    throw { status: 400, message: "السعر غير صالح في أحد الأصناف" };
  }

  const p = await db.get("SELECT * FROM products WHERE id = ?", [productId]);
  if (!p) {
    throw { status: 404, message: `المنتج غير موجود: ${productId}` };
  }
  if (Number(p.is_active) === 0) {
    throw {
      status: 409,
      message: "المنتج غير نشط ولا يمكن تعليقه",
      code: "PRODUCT_INACTIVE",
      product_id: productId,
      name: p.name,
    };
  }

  await ensureDefaultProductUnit(db, productId);

  let unitId =
    line.unit_id != null
      ? Number(line.unit_id)
      : line.product_unit_id != null
        ? Number(line.product_unit_id)
        : null;

  let unit = null;
  if (unitId) {
    unit = await db.get("SELECT * FROM product_units WHERE id = ? AND product_id = ?", [
      unitId,
      productId,
    ]);
    if (!unit) {
      throw { status: 400, message: "معرّف الوحدة لا يطابق المنتج" };
    }
  } else {
    unit = await db.get(
      "SELECT * FROM product_units WHERE product_id = ? ORDER BY is_default DESC, id ASC LIMIT 1",
      [productId]
    );
    if (!unit) {
      throw { status: 409, message: "لا توجد وحدة بيع للمنتج", product_id: productId };
    }
    unitId = unit.id;
  }

  const conversionToBase = Math.max(0.0001, Number(unit.conversion_to_base) || 1);
  const scannedBarcode =
    line.scanned_barcode != null ? String(line.scanned_barcode).trim() || null : null;
  const taxRate = productTaxRate(p, settings);

  return {
    product_id: productId,
    product_unit_id: unitId,
    product_name_snapshot: p.name,
    unit_name_snapshot: unit.unit_name,
    barcode_snapshot: unit.barcode || p.barcode || null,
    quantity: qty,
    unit_price_snapshot: price,
    total_price: round2(qty * price),
    conversion_to_base: conversionToBase,
    tax_rate_snapshot: taxRate,
    scanned_barcode_snapshot: scannedBarcode,
    category: p.category,
  };
}

export function buildStockWarnings(items, productStockMap) {
  const warnings = [];
  for (const it of items) {
    const required = round2(Number(it.quantity) * Number(it.conversion_to_base));
    const available = round2(Number(productStockMap[it.product_id]) || 0);
    if (required > available) {
      warnings.push({
        product_id: it.product_id,
        name: it.product_name_snapshot,
        required_base: required,
        available_stock: available,
        shortfall: round2(required - available),
      });
    }
  }
  return warnings;
}

export async function createSuspendedSale(db, { cashierId, note, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw { status: 400, message: "لا توجد أصناف لتعليقها" };
  }

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    throw { status: 400, message: shiftErr || "لا توجد وردية مفتوحة", code: "NO_OPEN_SHIFT" };
  }

  const settings = await getAppSettings(db);
  const normalized = [];
  for (const line of items) {
    normalized.push(await normalizeSuspendLine(db, line, settings));
  }

  const taxLines = normalized.map((L) => ({
    quantity: L.quantity,
    unitPrice: L.unit_price_snapshot,
    taxRate: L.tax_rate_snapshot,
  }));
  const { subtotal, tax } = computeSaleTotals(taxLines, settings);
  const grossTotal = round2(subtotal + tax);

  let discount = 0;
  try {
    const activePromos = await getActivePromotions(db);
    if (activePromos.length > 0) {
      const promoLines = normalized.map((L) => ({
        product_id: L.product_id,
        category: L.category,
        quantity: L.quantity,
        unitPrice: L.unit_price_snapshot,
      }));
      discount = Math.min(computeCartDiscount(activePromos, promoLines).discount, grossTotal);
    }
  } catch (_) {
    discount = 0;
  }
  const total = round2(grossTotal - discount);

  const ins = await db.run(
    `INSERT INTO suspended_sales (
      cashier_id, shift_id, note, subtotal, discount, tax, total, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'suspended', datetime('now'), datetime('now'))`,
    [cashierId, shift.id, normalizeNote(note), subtotal, discount, tax, total]
  );
  const suspendedSaleId = ins.lastID;

  for (const L of normalized) {
    await db.run(
      `INSERT INTO suspended_sale_items (
        suspended_sale_id, product_id, product_unit_id, product_name_snapshot, unit_name_snapshot,
        barcode_snapshot, quantity, unit_price_snapshot, total_price, conversion_to_base,
        tax_rate_snapshot, scanned_barcode_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        suspendedSaleId,
        L.product_id,
        L.product_unit_id,
        L.product_name_snapshot,
        L.unit_name_snapshot,
        L.barcode_snapshot,
        L.quantity,
        L.unit_price_snapshot,
        L.total_price,
        L.conversion_to_base,
        L.tax_rate_snapshot,
        L.scanned_barcode_snapshot,
      ]
    );
  }

  return {
    id: suspendedSaleId,
    shift_id: shift.id,
    subtotal,
    discount,
    tax,
    total,
    note: normalizeNote(note),
  };
}

export async function updateSuspendedSale(db, id, cashierId, { items, note }) {
  const sale = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
  if (!sale || sale.status !== "suspended") {
    throw { status: 404, message: "الفاتورة المعلقة غير موجودة" };
  }

  const { shift } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift || Number(shift.id) !== Number(sale.shift_id)) {
    throw { status: 403, message: "لا يمكن تعديل فاتورة من وردية أخرى" };
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw { status: 400, message: "لا توجد أصناف لتعليقها" };
  }

  const settings = await getAppSettings(db);
  const normalized = [];
  for (const line of items) {
    normalized.push(await normalizeSuspendLine(db, line, settings));
  }

  const taxLines = normalized.map((L) => ({
    quantity: L.quantity,
    unitPrice: L.unit_price_snapshot,
    taxRate: L.tax_rate_snapshot,
  }));
  const { subtotal, tax } = computeSaleTotals(taxLines, settings);
  const grossTotal = round2(subtotal + tax);

  let discount = 0;
  try {
    const activePromos = await getActivePromotions(db);
    if (activePromos.length > 0) {
      const promoLines = normalized.map((L) => ({
        product_id: L.product_id,
        category: L.category,
        quantity: L.quantity,
        unitPrice: L.unit_price_snapshot,
      }));
      discount = Math.min(computeCartDiscount(activePromos, promoLines).discount, grossTotal);
    }
  } catch (_) {
    discount = 0;
  }
  const total = round2(grossTotal - discount);
  const nextNote = note !== undefined ? normalizeNote(note) : sale.note;

  await db.run("DELETE FROM suspended_sale_items WHERE suspended_sale_id = ?", [id]);
  for (const L of normalized) {
    await db.run(
      `INSERT INTO suspended_sale_items (
        suspended_sale_id, product_id, product_unit_id, product_name_snapshot, unit_name_snapshot,
        barcode_snapshot, quantity, unit_price_snapshot, total_price, conversion_to_base,
        tax_rate_snapshot, scanned_barcode_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        L.product_id,
        L.product_unit_id,
        L.product_name_snapshot,
        L.unit_name_snapshot,
        L.barcode_snapshot,
        L.quantity,
        L.unit_price_snapshot,
        L.total_price,
        L.conversion_to_base,
        L.tax_rate_snapshot,
        L.scanned_barcode_snapshot,
      ]
    );
  }

  await db.run(
    `UPDATE suspended_sales
     SET note = ?, subtotal = ?, discount = ?, tax = ?, total = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [nextNote, subtotal, discount, tax, total, id]
  );

  return {
    id,
    shift_id: sale.shift_id,
    subtotal,
    discount,
    tax,
    total,
    note: nextNote,
  };
}

export async function listSuspendedSalesForShift(db, shiftId) {
  const rows = await db.all(
    `SELECT s.id, s.cashier_id, s.shift_id, s.note, s.subtotal, s.discount, s.tax, s.total,
            s.status, s.created_at, s.updated_at, u.username AS cashier_name,
            COALESCE(SUM(si.quantity), 0) AS item_count
     FROM suspended_sales s
     JOIN users u ON u.id = s.cashier_id
     LEFT JOIN suspended_sale_items si ON si.suspended_sale_id = s.id
     WHERE s.shift_id = ? AND s.status = 'suspended'
     GROUP BY s.id
     ORDER BY datetime(s.created_at) DESC, s.id DESC`,
    [shiftId]
  );
  return rows.map((r) => ({
    id: r.id,
    cashier_id: r.cashier_id,
    cashier_name: r.cashier_name,
    shift_id: r.shift_id,
    note: r.note,
    subtotal: round2(Number(r.subtotal)),
    discount: round2(Number(r.discount)),
    tax: round2(Number(r.tax)),
    total: round2(Number(r.total)),
    item_count: round2(Number(r.item_count)),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function getSuspendedSalesSummary(db, shiftId) {
  const row = await db.get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total_sum
     FROM suspended_sales WHERE shift_id = ? AND status = 'suspended'`,
    [shiftId]
  );
  return {
    suspended_sales_count: Number(row?.count) || 0,
    suspended_sales_total: round2(Number(row?.total_sum) || 0),
  };
}

async function loadSuspendedItems(db, suspendedSaleId) {
  return db.all(
    `SELECT * FROM suspended_sale_items WHERE suspended_sale_id = ? ORDER BY id`,
    [suspendedSaleId]
  );
}

export async function getSuspendedSaleDetail(db, id) {
  const sale = await db.get(
    `SELECT s.*, u.username AS cashier_name
     FROM suspended_sales s
     JOIN users u ON u.id = s.cashier_id
     WHERE s.id = ?`,
    [id]
  );
  if (!sale) {
    throw { status: 404, message: "الفاتورة المعلقة غير موجودة" };
  }

  const itemRows = await loadSuspendedItems(db, id);

  const items = itemRows.map((r) => ({
    id: r.id,
    product_id: r.product_id,
    product_unit_id: r.product_unit_id,
    product_name_snapshot: r.product_name_snapshot,
    unit_name_snapshot: r.unit_name_snapshot,
    barcode_snapshot: r.barcode_snapshot,
    quantity: Number(r.quantity),
    unit_price_snapshot: round2(Number(r.unit_price_snapshot)),
    total_price: round2(Number(r.total_price)),
    conversion_to_base: Number(r.conversion_to_base),
    tax_rate_snapshot: Number(r.tax_rate_snapshot),
    scanned_barcode_snapshot: r.scanned_barcode_snapshot,
    created_at: r.created_at,
  }));

  return {
    id: sale.id,
    cashier_id: sale.cashier_id,
    cashier_name: sale.cashier_name,
    shift_id: sale.shift_id,
    note: sale.note,
    subtotal: round2(Number(sale.subtotal)),
    discount: round2(Number(sale.discount)),
    tax: round2(Number(sale.tax)),
    total: round2(Number(sale.total)),
    status: sale.status,
    created_at: sale.created_at,
    updated_at: sale.updated_at,
    items,
    stock_warnings: [],
  };
}

export async function deleteSuspendedSale(db, id, cashierId) {
  const sale = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
  if (!sale || sale.status !== "suspended") {
    throw { status: 404, message: "الفاتورة المعلقة غير موجودة" };
  }

  const { shift } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift || Number(shift.id) !== Number(sale.shift_id)) {
    throw { status: 403, message: "لا يمكن حذف فاتورة من وردية أخرى" };
  }

  await db.run(
    `UPDATE suspended_sales SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`,
    [id]
  );
  return { success: true, id };
}

/**
 * Load suspended sale items for checkout price matching.
 * @returns {Map<string, object>} key = `${product_id}-${product_unit_id}`
 */
export async function loadSuspendedSaleItemMap(db, suspendedSaleId) {
  const sale = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [suspendedSaleId]);
  if (!sale || sale.status !== "suspended") {
    return { sale: null, itemMap: null };
  }
  const rows = await loadSuspendedItems(db, suspendedSaleId);
  const itemMap = new Map();
  for (const r of rows) {
    const key = `${r.product_id}-${r.product_unit_id}`;
    itemMap.set(key, r);
  }
  return { sale, itemMap };
}

export async function markSuspendedSaleCompleted(db, suspendedSaleId) {
  await db.run(
    `UPDATE suspended_sales SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'suspended'`,
    [suspendedSaleId]
  );
}
