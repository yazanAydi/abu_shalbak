import { createHash } from "node:crypto";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals, productTaxRate, round2 } from "../utils/tax.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";
import { ensureDefaultProductUnit, isWeighedBaseUnit } from "../utils/productUnits.js";
import { HttpError } from "../utils/httpError.js";
import { withTransaction } from "../utils/dbTx.js";

function normalizeNote(note) {
  if (note == null) return null;
  const s = String(note).trim();
  return s || null;
}

async function normalizeSuspendLine(db, line, settings) {
  const productId = Number(line.product_id);
  const qty = Number(line.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw { status: 400, message: "الكمية يجب أن تكون رقماً موجباً" };
  }
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
  const dbPrice = round2(Number(unit.price) || Number(p.price) || 0);
  if (Math.abs(dbPrice - price) > 0.009) {
    throw {
      status: 409,
      message: "عدم تطابق السعر مع أحدث سعر في النظام",
      code: "PRICE_MISMATCH",
      product_id: productId,
      expected: dbPrice,
      received: price,
    };
  }
  const scannedBarcode =
    line.scanned_barcode != null ? String(line.scanned_barcode).trim() || null : null;
  const taxRate = productTaxRate(p, settings);
  const scaleWeighed = isWeighedBaseUnit(unit, Number(p.is_weighed) === 1);
  const totalPrice = round2(qty * dbPrice);

  return {
    product_id: productId,
    product_unit_id: unitId,
    product_name_snapshot: p.name,
    unit_name_snapshot: unit.unit_name,
    barcode_snapshot: unit.barcode || p.barcode || null,
    quantity: qty,
    unit_price_snapshot: dbPrice,
    total_price: totalPrice,
    conversion_to_base: conversionToBase,
    tax_rate_snapshot: taxRate,
    scanned_barcode_snapshot: scannedBarcode,
    category: p.category,
    scaleWeighed,
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

function isUniqueConstraint(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return code === "SQLITE_CONSTRAINT" || /UNIQUE constraint failed/i.test(message);
}

function fingerprintSuspend(normalized, note, customerId, employeeId) {
  const items = normalized
    .map((L) => ({
      product_id: Number(L.product_id),
      unit_id: Number(L.product_unit_id) || 0,
      quantity: Number(L.quantity),
      price: round2(Number(L.unit_price_snapshot)),
      scanned_barcode: L.scanned_barcode_snapshot || null,
    }))
    .sort((a, b) => a.product_id - b.product_id || a.unit_id - b.unit_id || a.quantity - b.quantity);
  return createHash("sha256")
    .update(
      JSON.stringify({
        items,
        note: note || null,
        customer_id: customerId || null,
        employee_id: employeeId || null,
      })
    )
    .digest("hex");
}

function mapSuspendedHeader(row, { replayed = false } = {}) {
  return {
    id: row.id,
    shift_id: row.shift_id,
    cashier_id: row.cashier_id,
    subtotal: round2(Number(row.subtotal)),
    discount: round2(Number(row.discount)),
    tax: round2(Number(row.tax)),
    total: round2(Number(row.total)),
    note: row.note ?? null,
    customer_id: row.customer_id ? Number(row.customer_id) : null,
    employee_id: row.employee_id ? Number(row.employee_id) : null,
    version: Number(row.version || 1),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    replayed: Boolean(replayed),
  };
}

function assertSuspendedMutable(sale) {
  if (!sale) {
    throw new HttpError(404, "الفاتورة المعلقة غير موجودة", "SUSPENDED_NOT_FOUND");
  }
  if (sale.status === "completed") {
    throw new HttpError(
      409,
      "الفاتورة المعلقة مكتملة مسبقاً. لن يُنشأ سجل جديد.",
      "SUSPENDED_ALREADY_COMPLETED"
    );
  }
  if (sale.status === "deleted") {
    throw new HttpError(
      409,
      "الفاتورة المعلقة حُذفت. لن يُنشأ سجل جديد بدلاً منها.",
      "SUSPENDED_DELETED"
    );
  }
  if (sale.status !== "suspended") {
    throw new HttpError(409, "الفاتورة المعلقة غير متاحة للتعديل", "SUSPENDED_NOT_ACTIVE");
  }
}

function assertSuspendedOwner(sale, cashierId) {
  if (Number(sale.cashier_id) !== Number(cashierId)) {
    throw new HttpError(403, "لا يمكن تعديل فاتورة معلقة لكاشير آخر", "SUSPENDED_NOT_OWNER");
  }
}

async function resolveSuspendParty(db, customerId, employeeId) {
  const cust = customerId ? Number(customerId) : null;
  const emp = employeeId ? Number(employeeId) : null;
  if (cust) {
    const row = await db.get("SELECT id FROM customers WHERE id = ?", [cust]);
    if (!row) throw new HttpError(404, "العميل غير موجود", "CUSTOMER_NOT_FOUND");
  }
  if (emp) {
    const row = await db.get("SELECT id FROM employees WHERE id = ?", [emp]);
    if (!row) throw new HttpError(404, "الموظف غير موجود", "EMPLOYEE_NOT_FOUND");
  }
  return { customerId: cust, employeeId: emp };
}

async function priceNormalizedSuspend(db, normalized, settings) {
  const taxLines = normalized.map((L) => ({
    quantity: L.quantity,
    unitPrice: L.unit_price_snapshot,
    taxRate: L.tax_rate_snapshot,
    scaleWeighed: Boolean(L.scaleWeighed),
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
  return { subtotal, tax, discount, total: round2(grossTotal - discount) };
}

async function insertSuspendedItems(db, suspendedSaleId, normalized) {
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
}

async function findIdempotentSuspend(db, key, cashierId, fingerprint) {
  const existing = await db.get("SELECT * FROM suspended_sales WHERE idempotency_key = ?", [key]);
  if (!existing) return null;
  if (Number(existing.cashier_id) !== Number(cashierId)) {
    throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
  }
  if (existing.payload_fingerprint && fingerprint && existing.payload_fingerprint !== fingerprint) {
    throw new HttpError(
      409,
      "تم استخدام مفتاح التكرار مع محتوى مختلف. الفاتورة المعلقة السابقة ما زالت محفوظة.",
      "IDEMPOTENCY_KEY_REUSE"
    );
  }
  return existing;
}

async function normalizeSuspendItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, "لا توجد أصناف لتعليقها", "EMPTY_CART");
  }
  const settings = await getAppSettings(db);
  const normalized = [];
  for (const line of items) {
    normalized.push(await normalizeSuspendLine(db, line, settings));
  }
  const priced = await priceNormalizedSuspend(db, normalized, settings);
  return { normalized, priced };
}

export async function createSuspendedSale(db, { cashierId, note, items, idempotencyKey, customerId, employeeId }) {
  const party = await resolveSuspendParty(db, customerId, employeeId);
  const { normalized, priced } = await normalizeSuspendItems(db, items);
  const noteValue = normalizeNote(note);
  const fingerprint = fingerprintSuspend(normalized, noteValue, party.customerId, party.employeeId);
  const key = idempotencyKey ? String(idempotencyKey).trim() : null;

  return withTransaction(db, async () => {
    if (key) {
      const existing = await findIdempotentSuspend(db, key, cashierId, fingerprint);
      if (existing) return mapSuspendedHeader(existing, { replayed: true });
    }

    const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
    if (shiftErr || !shift) {
      throw new HttpError(400, shiftErr || "لا توجد وردية مفتوحة", "NO_OPEN_SHIFT");
    }

    let ins;
    try {
      ins = await db.run(
        `INSERT INTO suspended_sales (
          cashier_id, shift_id, note, subtotal, discount, tax, total, status,
          created_at, updated_at, version, idempotency_key, payload_fingerprint,
          customer_id, employee_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'suspended', datetime('now'), datetime('now'), 1, ?, ?, ?, ?)`,
        [
          cashierId,
          shift.id,
          noteValue,
          priced.subtotal,
          priced.discount,
          priced.tax,
          priced.total,
          key,
          fingerprint,
          party.customerId,
          party.employeeId,
        ]
      );
    } catch (err) {
      if (key && isUniqueConstraint(err)) {
        const existing = await findIdempotentSuspend(db, key, cashierId, fingerprint);
        if (existing) return mapSuspendedHeader(existing, { replayed: true });
      }
      throw err;
    }

    await insertSuspendedItems(db, ins.lastID, normalized);
    const row = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [ins.lastID]);
    return mapSuspendedHeader(row, { replayed: false });
  });
}

export async function updateSuspendedSale(db, id, cashierId, { items, note, version, customerId, employeeId }) {
  const preview = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
  assertSuspendedMutable(preview);
  assertSuspendedOwner(preview, cashierId);
  const { shift } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift || Number(shift.id) !== Number(preview.shift_id)) {
    throw new HttpError(403, "لا يمكن تعديل فاتورة من وردية أخرى", "SUSPENDED_SHIFT_MISMATCH");
  }

  const nextCustomer = customerId !== undefined ? customerId || null : preview.customer_id || null;
  const nextEmployee = employeeId !== undefined ? employeeId || null : preview.employee_id || null;
  await resolveSuspendParty(db, nextCustomer, nextEmployee);
  const nextNote = note !== undefined ? normalizeNote(note) : preview.note;
  const { normalized, priced } = await normalizeSuspendItems(db, items);
  const fingerprint = fingerprintSuspend(normalized, nextNote, nextCustomer, nextEmployee);
  const expectedVersion = version != null && version !== "" ? Number(version) : null;

  return withTransaction(db, async () => {
    const sale = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
    assertSuspendedMutable(sale);
    assertSuspendedOwner(sale, cashierId);
    const open = await requireOpenShiftForCashier(db, cashierId);
    if (!open.shift || Number(open.shift.id) !== Number(sale.shift_id)) {
      throw new HttpError(403, "لا يمكن تعديل فاتورة من وردية أخرى", "SUSPENDED_SHIFT_MISMATCH");
    }

    const currentVersion = Number(sale.version || 1);
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      if (sale.payload_fingerprint && sale.payload_fingerprint === fingerprint) {
        return mapSuspendedHeader(sale, { replayed: true });
      }
      throw new HttpError(
        409,
        "تم تعديل هذه الفاتورة المعلقة من شاشة أخرى. لم يُستبدل الحفظ الأحدث.",
        "SUSPENDED_VERSION_CONFLICT"
      );
    }

    const params = [
      nextNote,
      priced.subtotal,
      priced.discount,
      priced.tax,
      priced.total,
      nextCustomer,
      nextEmployee,
      fingerprint,
      id,
    ];
    let sql = `UPDATE suspended_sales
      SET note = ?, subtotal = ?, discount = ?, tax = ?, total = ?,
          customer_id = ?, employee_id = ?, payload_fingerprint = ?,
          version = COALESCE(version, 1) + 1, updated_at = datetime('now')
      WHERE id = ? AND status = 'suspended'`;
    if (expectedVersion != null) {
      sql += " AND COALESCE(version, 1) = ?";
      params.push(expectedVersion);
    }
    const info = await db.run(sql, params);
    if (!info.changes) {
      const fresh = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
      if (fresh && fresh.status === "suspended" && fresh.payload_fingerprint === fingerprint) {
        return mapSuspendedHeader(fresh, { replayed: true });
      }
      assertSuspendedMutable(fresh);
      throw new HttpError(
        409,
        "تم تعديل هذه الفاتورة المعلقة من شاشة أخرى. لم يُستبدل الحفظ الأحدث.",
        "SUSPENDED_VERSION_CONFLICT"
      );
    }

    await db.run("DELETE FROM suspended_sale_items WHERE suspended_sale_id = ?", [id]);
    await insertSuspendedItems(db, id, normalized);
    const row = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
    return mapSuspendedHeader(row, { replayed: false });
  });
}

export async function listSuspendedSalesForShift(db, shiftId, cashierId = null) {
  const params = [shiftId];
  let cashierSql = "";
  if (cashierId != null) {
    cashierSql = " AND s.cashier_id = ?";
    params.push(cashierId);
  }
  const rows = await db.all(
    `SELECT s.id, s.cashier_id, s.shift_id, s.note, s.subtotal, s.discount, s.tax, s.total,
            s.status, s.created_at, s.updated_at, s.version, s.customer_id, s.employee_id,
            u.username AS cashier_name,
            COALESCE(SUM(si.quantity), 0) AS item_count
     FROM suspended_sales s
     JOIN users u ON u.id = s.cashier_id
     LEFT JOIN suspended_sale_items si ON si.suspended_sale_id = s.id
     WHERE s.shift_id = ? AND s.status = 'suspended'${cashierSql}
     GROUP BY s.id
     ORDER BY datetime(s.created_at) DESC, s.id DESC`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    cashier_id: r.cashier_id,
    cashier_name: r.cashier_name,
    shift_id: r.shift_id,
    note: r.note,
    customer_id: r.customer_id ? Number(r.customer_id) : null,
    employee_id: r.employee_id ? Number(r.employee_id) : null,
    subtotal: round2(Number(r.subtotal)),
    discount: round2(Number(r.discount)),
    tax: round2(Number(r.tax)),
    total: round2(Number(r.total)),
    item_count: round2(Number(r.item_count)),
    version: Number(r.version || 1),
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
    customer_id: sale.customer_id ? Number(sale.customer_id) : null,
    employee_id: sale.employee_id ? Number(sale.employee_id) : null,
    version: Number(sale.version || 1),
    created_at: sale.created_at,
    updated_at: sale.updated_at,
    items,
    stock_warnings: [],
  };
}

export async function deleteSuspendedSale(db, id, cashierId) {
  const sale = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
  assertSuspendedMutable(sale);
  assertSuspendedOwner(sale, cashierId);

  const { shift } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift || Number(shift.id) !== Number(sale.shift_id)) {
    throw new HttpError(403, "لا يمكن حذف فاتورة من وردية أخرى", "SUSPENDED_SHIFT_MISMATCH");
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
  const info = await db.run(
    `UPDATE suspended_sales SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'suspended'`,
    [suspendedSaleId]
  );
  if (!info.changes) {
    throw new HttpError(
      409,
      "الفاتورة المعلقة مكتملة أو غير موجودة",
      "SUSPENDED_ALREADY_COMPLETED"
    );
  }
}
