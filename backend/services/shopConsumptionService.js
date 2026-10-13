import { createHash } from "node:crypto";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { withTransaction } from "../utils/dbTx.js";
import { HttpError, badRequest, conflict } from "../utils/httpError.js";
import { recordMovement } from "../utils/inventory.js";
import { allocateProportionalMoney, round2, roundPosPayable, sumMoney } from "../utils/money.js";
import { computeSaleTotals } from "../utils/tax.js";
import { computeCartDiscount, getActivePromotions } from "../utils/promotions.js";
import {
  getDefaultUnit,
  isKgUnit,
  isProductCostKnown,
  resolveSoldUnitCost,
  toBaseQuantity,
} from "../utils/productUnits.js";
import { applyOutboundBatches } from "./stockBatchService.js";
import { sellableQuantity } from "./warehouseBatchStock.js";
import { shopTodayYmd, shopYmdFromTimestamp } from "../utils/shopTime.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { enqueueOperationPrint, shopConsumptionPrintSnapshot } from "./operationPrintService.js";

const SOURCE = "shop_consumption";

export function missingSellingPriceMessage(name) {
  return `سعر البيع غير مسجّل للصنف: ${name}`;
}

export function fingerprintShopConsumption(lines, reason) {
  const payload = {
    reason: reason || null,
    items: (lines || []).map((line) => ({
      product_id: Number(line.product_id) || 0,
      unit_id:
        line.unit_id != null
          ? Number(line.unit_id)
          : line.product_unit_id != null
            ? Number(line.product_unit_id)
            : null,
      quantity: Number(line.quantity),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function businessDayForShift(shift) {
  if (shift?.business_day && /^\d{4}-\d{2}-\d{2}$/.test(String(shift.business_day))) {
    return String(shift.business_day);
  }
  return shopYmdFromTimestamp(shift?.start_time) || shopTodayYmd();
}

function parseQuantity(product, unit, rawQty) {
  const isWeighed = Number(product.is_weighed) === 1;
  const isKgSale = isKgUnit(unit);
  if (isKgSale) {
    if (!Number.isFinite(rawQty) || rawQty <= 0) {
      throw badRequest("كمية الوزن غير صالحة", "INVALID_WEIGHT_QTY");
    }
    return rawQty;
  }
  if (!Number.isFinite(rawQty) || rawQty < 1 || Math.abs(rawQty - Math.round(rawQty)) > 1e-9) {
    throw badRequest(
      isWeighed ? "كمية الحبة غير صالحة" : "كمية الحبة يجب أن تكون عدداً صحيحاً",
      isWeighed ? "INVALID_PACKAGE_QTY" : "INVALID_PIECE_QTY"
    );
  }
  return Math.round(rawQty);
}

async function resolveLines(db, rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw badRequest("السلة فارغة", "EMPTY_CART");

  const productIds = [...new Set(items.map((line) => Number(line.product_id)).filter((id) => id > 0))];
  if (productIds.length !== items.filter((line) => Number(line.product_id) > 0).length && items.some((line) => !(Number(line.product_id) > 0))) {
    throw badRequest("صنف غير صالح", "INVALID_PRODUCT");
  }
  const placeholders = productIds.map(() => "?").join(",");
  const products = await db.all(
    `SELECT id, name, barcode, sku, price, cost, cost_known, stock, is_active, is_weighed, category
       FROM products WHERE id IN (${placeholders})`,
    productIds
  );
  const productById = new Map(products.map((row) => [Number(row.id), row]));
  const unitRows = productIds.length
    ? await db.all(
        `SELECT * FROM product_units WHERE product_id IN (${placeholders}) ORDER BY is_default DESC, id ASC`,
        productIds
      )
    : [];
  const unitsByProduct = new Map();
  for (const unit of unitRows) {
    const pid = Number(unit.product_id);
    if (!unitsByProduct.has(pid)) unitsByProduct.set(pid, []);
    unitsByProduct.get(pid).push(unit);
  }

  const lines = [];
  for (const raw of items) {
    const productId = Number(raw.product_id);
    const product = productById.get(productId);
    if (!product) throw new HttpError(404, `المنتج غير موجود: ${productId}`, "NOT_FOUND");
    if (Number(product.is_active) === 0) {
      throw conflict(`المنتج غير نشط: ${product.name}`, "PRODUCT_INACTIVE");
    }

    let unitId =
      raw.unit_id != null
        ? Number(raw.unit_id)
        : raw.product_unit_id != null
          ? Number(raw.product_unit_id)
          : null;
    const units = unitsByProduct.get(productId) || [];
    let unit = unitId ? units.find((row) => Number(row.id) === unitId) || null : units[0] || null;
    if (unitId && !unit) {
      throw badRequest("معرّف الوحدة لا يطابق المنتج", "UNIT_PRODUCT_MISMATCH");
    }
    if (!unit) {
      unit = await getDefaultUnit(db, productId);
    }
    if (!unit) throw conflict(`لا توجد وحدة للمنتج: ${product.name}`, "NO_UNIT");
    unitId = Number(unit.id);

    const explicitUnit = raw.unit_id != null || raw.product_unit_id != null;
    const qty = parseQuantity(product, unit, Number(raw.quantity));
    const conversion = Math.max(0.0001, Number(unit.conversion_to_base) || 1);
    const baseQuantity = toBaseQuantity(qty, conversion);
    if (!(baseQuantity > 0)) throw badRequest("الكمية غير صالحة", "INVALID_QTY");
    const unitPrice = authorizedSellingPrice(product, unit, explicitUnit);
    if (raw.price != null && raw.price !== "") {
      const submitted = Number(raw.price);
      if (!Number.isFinite(submitted) || submitted < 0) {
        throw badRequest(`سعر البيع غير صالح للصنف: ${product.name}`, "INVALID_SELLING_PRICE");
      }
      if (Math.abs(round2(submitted) - unitPrice) > 0.009) {
        throw conflict(
          `عدم تطابق السعر مع أحدث سعر في النظام للصنف: ${product.name}`,
          "PRICE_MISMATCH"
        );
      }
    }
    const acquisition = acquisitionAmounts(product, conversion, qty);

    lines.push({
      product_id: productId,
      product_unit_id: unitId,
      barcode: unit.barcode || product.barcode || null,
      name: product.name,
      category: product.category || null,
      quantity: qty,
      unit_name: unit.unit_name,
      conversion_to_base: conversion,
      base_quantity: baseQuantity,
      stock: await sellableQuantity(db, product.id),
      unit_price: unitPrice,
      unit_cost: acquisition.unit_cost,
      line_cost: acquisition.line_cost,
    });
  }

  return priceExpenseDocument(db, lines);
}

/**
 * Shelf price for this action. A default unit without an explicit id follows
 * products.price when the unit cache has drifted, the same rule as checkout.
 * Explicit zero is a real price. Null or non-finite is not turned into zero.
 */
function authorizedSellingPrice(product, unit, explicitUnit) {
  let raw = unit?.price;
  if (!explicitUnit && Number(unit?.is_default) === 1 && product?.price != null && product.price !== "") {
    const live = Number(product.price);
    const cached = Number(unit?.price);
    if (Number.isFinite(live) && (!Number.isFinite(cached) || Math.abs(round2(live) - round2(cached)) > 0.009)) {
      raw = product.price;
    }
  }
  if (raw == null || raw === "") {
    throw badRequest(missingSellingPriceMessage(product.name), "MISSING_SELLING_PRICE");
  }
  const price = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(price)) {
    throw badRequest(missingSellingPriceMessage(product.name), "MISSING_SELLING_PRICE");
  }
  if (price < 0) {
    throw badRequest(`سعر البيع غير صالح للصنف: ${product.name}`, "INVALID_SELLING_PRICE");
  }
  return round2(price);
}

function acquisitionAmounts(product, conversion, quantity) {
  if (!isProductCostKnown(product)) return { unit_cost: null, line_cost: null };
  const unitCost = resolveSoldUnitCost({ conversion_to_base: conversion }, product);
  return { unit_cost: unitCost, line_cost: round2(unitCost * quantity) };
}

async function priceExpenseDocument(db, lines) {
  const totals = computeSaleTotals(
    lines.map((line) => ({ quantity: line.quantity, unitPrice: line.unit_price, taxRate: 0 })),
    {}
  );
  lines.forEach((line, index) => {
    line.line_gross = totals.lines[index].lineGross;
  });
  let discount = 0;
  try {
    const promos = await getActivePromotions(db);
    if (promos.length) {
      const promo = computeCartDiscount(
        promos,
        lines.map((line) => ({
          product_id: line.product_id,
          product_unit_id: line.product_unit_id,
          category: line.category,
          quantity: line.quantity,
          unitPrice: line.unit_price,
        }))
      );
      discount = Math.min(promo.discount, totals.total);
    }
  } catch (err) {
    const wrapped = new Error(err?.message || "فشل احتساب العرض");
    wrapped.status = 409;
    wrapped.code = "PROMO_FAILED";
    throw wrapped;
  }
  const shares = allocateProportionalMoney(
    lines.map((line) => line.line_gross),
    discount
  );
  lines.forEach((line, index) => {
    line.line_discount = shares[index] || 0;
    line.line_amount = round2(line.line_gross - line.line_discount);
  });
  const before = sumMoney(lines.map((line) => line.line_amount));
  const payable = roundPosPayable(before);
  return {
    lines,
    subtotal: totals.subtotal,
    tax: 0,
    discount: round2(discount),
    amount_before_rounding: payable.calculated,
    rounding_adjustment: payable.adjustment,
    total_cost: payable.payable,
  };
}

function assertStockAvailable(lines) {
  const needed = new Map();
  for (const line of lines) {
    const prev = needed.get(line.product_id) || { name: line.name, qty: 0, stock: Number(line.stock) || 0 };
    prev.qty += line.base_quantity;
    needed.set(line.product_id, prev);
  }
  for (const entry of needed.values()) {
    if (entry.qty > entry.stock + 1e-6) {
      throw conflict(
        `الكمية غير متوفرة في المخزون: ${entry.name} (المتاح ${entry.stock})`,
        "INSUFFICIENT_STOCK"
      );
    }
  }
}

function publicLines(lines) {
  return lines.map((line) => ({
    product_id: line.product_id,
    name: line.name,
    quantity: line.quantity,
    unit_name: line.unit_name,
    unit_price: line.unit_price == null ? null : round2(Number(line.unit_price)),
    line_amount: line.line_amount == null ? null : round2(Number(line.line_amount)),
    line_gross: line.line_gross == null ? null : round2(Number(line.line_gross)),
    line_discount: round2(Number(line.line_discount) || 0),
    unit_cost: line.unit_cost == null ? null : round2(Number(line.unit_cost)),
    line_cost: line.line_cost == null ? null : round2(Number(line.line_cost)),
  }));
}

function expenseSummary(resolved) {
  return {
    lines: publicLines(resolved.lines),
    subtotal: resolved.subtotal,
    tax: 0,
    discount: resolved.discount,
    amount_before_rounding: resolved.amount_before_rounding,
    rounding_adjustment: resolved.rounding_adjustment,
    total_cost: resolved.total_cost,
  };
}

export async function previewShopConsumption(db, { cashierId, items }) {
  const { shift, error } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift) throw conflict(error, "SHIFT_REQUIRED");
  const resolved = await resolveLines(db, items);
  assertStockAvailable(resolved.lines);
  return {
    business_day: businessDayForShift(shift),
    shift_id: shift.id,
    ...expenseSummary(resolved),
  };
}

async function ensureCategory(db) {
  let cat = await db.get("SELECT id, name FROM expense_categories WHERE name = 'shop_consumption'");
  if (!cat) {
    const ins = await db.run(
      "INSERT INTO expense_categories (name, name_ar, active) VALUES ('shop_consumption', 'مصاريف محل', 1)"
    );
    cat = { id: ins.lastID, name: "shop_consumption" };
  }
  return cat;
}

async function loadResult(db, id, replayed) {
  const row = await db.get(
    `SELECT c.*, o.amount AS expense_amount, o.paid_on, o.payment_method, o.category
       FROM shop_consumptions c
       LEFT JOIN operating_expenses o ON o.id = c.operating_expense_id
      WHERE c.id = ?`,
    [id]
  );
  const items = await db.all(
    `SELECT product_id, name, quantity, unit_name, unit_cost, line_cost, unit_price, line_amount
       FROM shop_consumption_items WHERE consumption_id = ? ORDER BY id`,
    [id]
  );
  return {
    id: row.id,
    replayed,
    shift_id: row.shift_id,
    user_id: row.user_id,
    business_day: row.business_day,
    reason: row.reason,
    total_cost: round2(Number(row.total_cost) || 0),
    discount: round2(Number(row.discount) || 0),
    rounding_adjustment: round2(Number(row.rounding_adjustment) || 0),
    operating_expense_id: row.operating_expense_id,
    payment_method: row.payment_method,
    created_at: row.created_at,
    lines: items.map((item) => ({
      ...item,
      unit_price: item.unit_price == null ? null : round2(Number(item.unit_price)),
      line_amount: item.line_amount == null ? null : round2(Number(item.line_amount)),
      unit_cost: item.unit_cost == null ? null : round2(Number(item.unit_cost)),
      line_cost: item.line_cost == null ? null : round2(Number(item.line_cost)),
    })),
  };
}

export function parseStoredConsumption(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw || "null");
  } catch {
    parsed = null;
  }
  if (parsed && parsed.v === 2 && Array.isArray(parsed.lines)) {
    return {
      v: 2,
      lines: parsed.lines,
      total_cost: round2(Number(parsed.total_cost) || 0),
      discount: round2(Number(parsed.discount) || 0),
      rounding_adjustment: round2(Number(parsed.rounding_adjustment) || 0),
      amount_before_rounding: round2(Number(parsed.amount_before_rounding) || 0),
      subtotal: round2(Number(parsed.subtotal) || 0),
    };
  }
  const lines = Array.isArray(parsed) ? parsed : [];
  return { v: 1, lines, total_cost: null, discount: 0, rounding_adjustment: 0 };
}

function assertSnapshotMoney(stored) {
  if (!Array.isArray(stored.lines) || !stored.lines.length) {
    throw badRequest("السلة فارغة", "EMPTY_CART");
  }
  if (!Number.isFinite(Number(stored.total_cost)) || Number(stored.total_cost) < 0) {
    throw badRequest("مبلغ المصروف المحفوظ غير صالح", "INVALID_SELLING_PRICE");
  }
  for (const line of stored.lines) {
    const price = Number(line.unit_price);
    const amount = Number(line.line_amount);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(amount) || amount < 0) {
      throw badRequest(`سعر البيع المحفوظ غير صالح للصنف: ${line.name || ""}`.trim(), "INVALID_SELLING_PRICE");
    }
  }
}

async function resolveIdempotency(db, { key, fingerprint, userId }) {
  const row = await db.get(
    "SELECT id, user_id, payload_fingerprint FROM shop_consumptions WHERE idempotency_key = ?",
    [key]
  );
  if (!row) return null;
  if (Number(row.user_id) !== Number(userId)) {
    throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
  }
  if (row.payload_fingerprint && fingerprint && row.payload_fingerprint !== fingerprint) {
    throw new HttpError(
      409,
      "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
      "IDEMPOTENCY_KEY_REUSE"
    );
  }
  return loadResult(db, row.id, true);
}

async function attachLiveInventory(db, lines) {
  const ids = [...new Set(lines.map((line) => Number(line.product_id)).filter((id) => id > 0))];
  const placeholders = ids.map(() => "?").join(",");
  const products = ids.length
    ? await db.all(
        `SELECT id, name, cost, cost_known, is_active FROM products WHERE id IN (${placeholders})`,
        ids
      )
    : [];
  const byId = new Map(products.map((row) => [Number(row.id), row]));
  const stockById = new Map();
  for (const id of ids) stockById.set(id, await sellableQuantity(db, id));
  return lines.map((line) => {
    const product = byId.get(Number(line.product_id));
    if (!product) throw new HttpError(404, `المنتج غير موجود: ${line.product_id}`, "NOT_FOUND");
    if (Number(product.is_active) === 0) {
      throw conflict(`المنتج غير نشط: ${product.name}`, "PRODUCT_INACTIVE");
    }
    const acquisition = acquisitionAmounts(product, line.conversion_to_base, line.quantity);
    return {
      ...line,
      name: line.name || product.name,
      unit_cost: acquisition.unit_cost,
      line_cost: acquisition.line_cost,
      stock: stockById.get(Number(line.product_id)) || 0,
    };
  });
}

async function postShopConsumptionInTx(db, { cashierId, items, priced, reason, idempotencyKey, req }) {
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  const note = reason != null && String(reason).trim() !== "" ? String(reason).trim().slice(0, 500) : null;

  const { shift, error } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift) throw conflict(error, "SHIFT_REQUIRED");
  let resolved = priced;
  if (!resolved) {
    resolved = await resolveLines(db, items);
  } else {
    assertSnapshotMoney(resolved);
    resolved = { ...resolved, lines: await attachLiveInventory(db, resolved.lines) };
  }
  const fingerprint = fingerprintShopConsumption(resolved.lines, note);
  const existing = await resolveIdempotency(db, { key, fingerprint, userId: cashierId });
  if (existing) return existing;
  assertStockAvailable(resolved.lines);

  const businessDay = businessDayForShift(shift);
  const cat = await ensureCategory(db);
  const reference = note ? `استهلاك محل — ${note}` : "استهلاك محل";

  const exp = await db.run(
    `INSERT INTO operating_expenses
       (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id, source)
     VALUES (?, ?, ?, ?, 'other', ?, ?, ?)`,
    [cat.name, cat.id, resolved.total_cost, businessDay, reference, cashierId, SOURCE]
  );

  const ins = await db.run(
    `INSERT INTO shop_consumptions
       (shift_id, user_id, business_day, reason, total_cost, discount, rounding_adjustment,
        operating_expense_id, idempotency_key, payload_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shift.id,
      cashierId,
      businessDay,
      note,
      resolved.total_cost,
      resolved.discount || 0,
      resolved.rounding_adjustment || 0,
      exp.lastID,
      key,
      fingerprint,
    ]
  );
  const consumptionId = ins.lastID;
  await db.run("UPDATE operating_expenses SET source_id = ? WHERE id = ?", [consumptionId, exp.lastID]);

  for (const line of resolved.lines) {
    await db.run(
      `INSERT INTO shop_consumption_items
         (consumption_id, product_id, product_unit_id, barcode, name, quantity, unit_name,
          conversion_to_base, base_quantity, unit_cost, line_cost, unit_price, line_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        consumptionId,
        line.product_id,
        line.product_unit_id,
        line.barcode,
        line.name,
        line.quantity,
        line.unit_name,
        line.conversion_to_base,
        line.base_quantity,
        line.unit_cost,
        line.line_cost,
        line.unit_price,
        line.line_amount,
      ]
    );
    await applyOutboundBatches(db, {
      productId: line.product_id,
      quantity: line.base_quantity,
      referenceType: SOURCE,
      referenceId: consumptionId,
    });
    await recordMovement(db, {
      productId: line.product_id,
      movementType: "consumption",
      quantity: -line.base_quantity,
      refType: SOURCE,
      refId: consumptionId,
      notes: `مصاريف محل #${consumptionId}`,
      userId: cashierId,
      applyStock: true,
      businessDay,
    });
  }

    const saved = await loadResult(db, consumptionId, false);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [cashierId]);
    await enqueueOperationPrint(db, {
      kind: "shop_consumption",
      referenceId: consumptionId,
      cashierId,
      shiftId: shift.id,
      documentNo: `EXP-${consumptionId}`,
      snapshot: shopConsumptionPrintSnapshot({
        consumption: saved,
        cashierName: cashier?.username || "",
        lines: resolved.lines,
      }),
    });

    if (req) {
      await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "shop_consumptions", consumptionId, null, {
        total_cost: resolved.total_cost,
        expense_id: exp.lastID,
        shift_id: shift.id,
        business_day: businessDay,
        lines: resolved.lines.length,
      });
    }

    return loadResult(db, consumptionId, false);
}

async function postCore(db, params) {
  return withTransaction(db, () => postShopConsumptionInTx(db, params));
}

export async function postShopConsumption(db, params) {
  return postCore(db, params);
}

const SHOP_REQUEST_SELECT = `
  SELECT r.*,
         cashier.username AS cashier_username,
         manager.username AS manager_username
    FROM shop_consumption_requests r
    JOIN users cashier ON cashier.id = r.cashier_id
    LEFT JOIN users manager ON manager.id = r.manager_id
`;

function queueFilter(status) {
  const value = String(status || "pending").toLowerCase();
  if (!["pending", "approved", "rejected", "all"].includes(value)) {
    throw badRequest("حالة غير صالحة", "VALIDATION_ERROR");
  }
  return value;
}

function presentedLine(line) {
  const selling = line.line_amount == null ? null : round2(Number(line.line_amount));
  const historical = line.line_cost == null ? null : round2(Number(line.line_cost));
  return {
    name: line.name,
    quantity: line.quantity,
    unit_name: line.unit_name || null,
    unit_price: line.unit_price == null ? null : round2(Number(line.unit_price)),
    line_amount: selling,
    line_cost: selling != null ? selling : historical,
  };
}

async function displayLines(db, row) {
  if (row.consumption_id) {
    const items = await db.all(
      `SELECT name, quantity, unit_name, line_cost, unit_price, line_amount
         FROM shop_consumption_items WHERE consumption_id = ? ORDER BY id`,
      [row.consumption_id]
    );
    const head = await db.get("SELECT total_cost FROM shop_consumptions WHERE id = ?", [row.consumption_id]);
    return {
      items: items.map(presentedLine),
      amount: round2(Number(head?.total_cost) || 0),
    };
  }

  const stored = parseStoredConsumption(row.items_json);
  if (stored.v === 2) {
    return {
      items: stored.lines.map(presentedLine),
      amount: stored.total_cost,
    };
  }
  if (!stored.lines.length) return { items: [], amount: null };
  try {
    const resolved = await resolveLines(db, stored.lines);
    return {
      items: publicLines(resolved.lines).map(presentedLine),
      amount: resolved.total_cost,
    };
  } catch {
    return {
      items: stored.lines.map((item) => ({
        name: item.name || `صنف #${item.product_id || "?"}`,
        quantity: item.quantity,
        unit_name: item.unit_name || null,
        unit_price: null,
        line_amount: null,
        line_cost: null,
      })),
      amount: null,
    };
  }
}

export async function presentShopConsumptionRequest(db, row) {
  const lines = await displayLines(db, row);
  const fromTelegram = row.decision_source === "telegram";
  return {
    id: row.id,
    request_id: row.id,
    created_at: row.created_at,
    cashier_id: row.cashier_id,
    cashier_username: row.cashier_username || null,
    shift_id: row.shift_id,
    reason: row.reason || null,
    notes: row.reason || null,
    status: row.status,
    items: lines.items,
    amount: lines.amount,
    consumption_id: row.consumption_id || null,
    manager_id: row.manager_id || null,
    manager_username: row.manager_username || null,
    telegram_actor_id: row.telegram_actor_id || null,
    telegram_actor_username: row.telegram_actor_username || null,
    telegram_message_id: row.telegram_message_id || null,
    decision_source: row.decision_source || null,
    decision_actor: fromTelegram
      ? row.telegram_actor_username || (row.telegram_actor_id ? String(row.telegram_actor_id) : null)
      : row.manager_username || null,
    decision_at: row.approved_at || row.rejected_at || null,
    can_reprint: row.status === "approved" && row.consumption_id != null,
  };
}

export async function listUnreadShopConsumptionDecisions(db, cashierId) {
  return db.all(
    `SELECT r.id, r.status, r.reason, r.shift_id, r.consumption_id,
            r.created_at, r.approved_at, r.rejected_at, r.decision_source
     FROM shop_consumption_requests r
     WHERE r.cashier_id = ?
       AND r.status IN ('approved', 'rejected')
       AND r.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(r.approved_at, r.rejected_at) ASC, r.id ASC`,
    [Number(cashierId)]
  );
}

export async function listShopConsumptionRequests(db, status) {
  const filter = queueFilter(status);
  const where = filter === "all" ? "" : "WHERE r.status = ?";
  const params = filter === "all" ? [] : [filter];
  const order = filter === "pending" ? "r.created_at ASC, r.id ASC" : "r.created_at DESC, r.id DESC";
  const rows = await db.all(`${SHOP_REQUEST_SELECT} ${where} ORDER BY ${order}`, params);
  return Promise.all(rows.map((row) => presentShopConsumptionRequest(db, row)));
}

export async function getShopConsumptionRequestById(db, id) {
  return db.get("SELECT * FROM shop_consumption_requests WHERE id = ?", [id]);
}

export async function getPresentedShopConsumptionRequest(db, id) {
  const row = await db.get(`${SHOP_REQUEST_SELECT} WHERE r.id = ?`, [id]);
  return row ? presentShopConsumptionRequest(db, row) : null;
}

export async function createShopConsumptionRequest(db, params) {
  const key = String(params.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  const note = params.reason != null && String(params.reason).trim() !== "" ? String(params.reason).trim().slice(0, 500) : null;
  const { shift, error } = await requireOpenShiftForCashier(db, params.cashierId);
  if (!shift) throw conflict(error, "SHIFT_REQUIRED");
  const fingerprint = fingerprintShopConsumption(params.items, note);
  const already = await db.get("SELECT * FROM shop_consumption_requests WHERE idempotency_key = ?", [key]);
  if (already) {
    if (Number(already.cashier_id) !== Number(params.cashierId)) {
      throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
    }
    if (already.payload_fingerprint !== fingerprint) {
      throw new HttpError(409, "تم استخدام مفتاح التكرار مع محتوى مختلف", "IDEMPOTENCY_KEY_REUSE");
    }
    const stored = parseStoredConsumption(already.items_json);
    return {
      request_id: already.id,
      status: already.status,
      pending_approval: already.status === "pending",
      replayed: true,
      shift_id: already.shift_id,
      total_cost: stored.total_cost,
      discount: stored.discount,
      rounding_adjustment: stored.rounding_adjustment,
      amount_before_rounding: stored.amount_before_rounding,
      lines: publicLines(stored.lines),
      consumption_id: already.consumption_id || null,
      operating_expense_id: null,
      telegram: Boolean(already.telegram_message_id),
    };
  }
  const resolved = await resolveLines(db, params.items);
  assertStockAvailable(resolved.lines);
  const stockBefore = await db.get("SELECT stock FROM products WHERE id = ?", [resolved.lines[0].product_id]);

  let created;
  try {
    created = await withTransaction(db, async () => {
    const existing = await db.get("SELECT * FROM shop_consumption_requests WHERE idempotency_key = ?", [key]);
    if (existing) {
      if (Number(existing.cashier_id) !== Number(params.cashierId)) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (existing.payload_fingerprint !== fingerprint) {
        throw new HttpError(409, "تم استخدام مفتاح التكرار مع محتوى مختلف", "IDEMPOTENCY_KEY_REUSE");
      }
      return { request: existing, replayed: true };
    }
    const expenses = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const ledger = await db.get("SELECT COUNT(*) AS n FROM inventory_ledger");
    const ins = await db.run(
      `INSERT INTO shop_consumption_requests
         (cashier_id, shift_id, items_json, reason, idempotency_key, payload_fingerprint, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        params.cashierId,
        shift.id,
        JSON.stringify({
          v: 2,
          lines: resolved.lines,
          subtotal: resolved.subtotal,
          discount: resolved.discount,
          amount_before_rounding: resolved.amount_before_rounding,
          rounding_adjustment: resolved.rounding_adjustment,
          total_cost: resolved.total_cost,
        }),
        note,
        key,
        fingerprint,
      ]
    );
    if (Number(expenses.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)) {
      throw new Error("pending consumption must not post an expense");
    }
    if (Number(ledger.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n)) {
      throw new Error("pending consumption must not move stock");
    }
    return { request: await db.get("SELECT * FROM shop_consumption_requests WHERE id = ?", [ins.lastID]), replayed: false };
  });
  } catch (err) {
    const code = String(err?.code || "");
    const message = String(err?.message || "");
    if (code.startsWith("SQLITE_CONSTRAINT") && message.includes("idempotency_key")) {
      const existing = await db.get("SELECT * FROM shop_consumption_requests WHERE idempotency_key = ?", [key]);
      if (!existing) throw err;
      if (Number(existing.cashier_id) !== Number(params.cashierId)) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (existing.payload_fingerprint !== fingerprint) {
        throw new HttpError(409, "تم استخدام مفتاح التكرار مع محتوى مختلف", "IDEMPOTENCY_KEY_REUSE");
      }
      created = { request: existing, replayed: true };
    } else {
      throw err;
    }
  }

  if (stockBefore) {
    const stockAfter = await db.get("SELECT stock FROM products WHERE id = ?", [resolved.lines[0].product_id]);
    if (Number(stockAfter.stock) !== Number(stockBefore.stock) && !created.replayed) {
      throw new Error("pending consumption changed stock");
    }
  }

  const { logApprovalStage: logSaved } = await import("../utils/telegram.js");
  logSaved("saved", { request: created.request.id, kind: "consumption", shift: created.request.shift_id });
  let telegramMessageId = created.request.telegram_message_id || null;
  if (!created.replayed) {
    const { isApprovalsTelegramConfigured, sendShopConsumptionApprovalMessage } = await import("../utils/telegram.js");
    if (isApprovalsTelegramConfigured()) {
      try {
        const cashier = await db.get("SELECT username FROM users WHERE id = ?", [params.cashierId]);
        telegramMessageId = await sendShopConsumptionApprovalMessage({
          requestId: created.request.id,
          cashierName: cashier?.username || String(params.cashierId),
          totalCost: resolved.total_cost,
          lineCount: resolved.lines.length,
          reason: note,
        });
        await db.run("UPDATE shop_consumption_requests SET telegram_message_id = ? WHERE id = ?", [
          telegramMessageId,
          created.request.id,
        ]);
        const { logApprovalStage } = await import("../utils/telegram.js");
        logApprovalStage("sent", { request: created.request.id, kind: "consumption", message: telegramMessageId });
      } catch (e) {
        const { telegramFailureLog, logApprovalStage } = await import("../utils/telegram.js");
        logApprovalStage("send_failed", {
          request: created.request.id,
          kind: "consumption",
          detail: telegramFailureLog(e),
        });
        telegramMessageId = null;
      }
    } else if (!created.replayed) {
      const { logApprovalStage } = await import("../utils/telegram.js");
      logApprovalStage("send_skipped", {
        request: created.request.id,
        kind: "consumption",
        detail: "approvals bot not configured",
      });
    }
  }

  const shown = created.replayed ? parseStoredConsumption(created.request.items_json) : resolved;
  const shownLines = shown.v === 2 ? shown.lines : resolved.lines;
  const shownTotal = shown.v === 2 ? shown.total_cost : resolved.total_cost;
  return {
    request_id: created.request.id,
    status: created.request.status,
    pending_approval: created.request.status === "pending",
    replayed: created.replayed,
    shift_id: created.request.shift_id,
    total_cost: shownTotal,
    discount: shown.v === 2 ? shown.discount : resolved.discount,
    rounding_adjustment: shown.v === 2 ? shown.rounding_adjustment : resolved.rounding_adjustment,
    amount_before_rounding: shown.v === 2 ? shown.amount_before_rounding : resolved.amount_before_rounding,
    lines: publicLines(shownLines),
    consumption_id: created.request.consumption_id || null,
    operating_expense_id: null,
    telegram: Boolean(telegramMessageId),
  };
}

export async function approveShopConsumptionRequest(db, requestId, actor = {}) {
  const decisionSource = actor.decisionSource || "admin";
  if (decisionSource !== "telegram") {
    const { userHasAccountantPermission } = await import("../utils/accountantPermissions.js");
    const permitted = await userHasAccountantPermission(db, actor.officeUser, "expenses");
    if (!permitted) throw new HttpError(403, "حساب الموافق لا يملك صلاحية الموافقة", "FORBIDDEN");
  }
  const posted = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM shop_consumption_requests WHERE id = ?", [requestId]);
    if (!request) throw new HttpError(404, "الطلب غير موجود", "NOT_FOUND");
    if (request.status !== "pending") {
      const err = new HttpError(409, "تمت المعالجة مسبقاً", "ALREADY_HANDLED");
      err.action = "already_handled";
      throw err;
    }
    const cashBefore = await db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ?",
      [request.shift_id]
    );
    const stored = parseStoredConsumption(request.items_json);
    const priced = stored.v === 2 ? stored : await resolveLines(db, stored.lines);
    const created = await postShopConsumptionInTx(db, {
      cashierId: request.cashier_id,
      priced,
      reason: request.reason,
      idempotencyKey: `consumption-approval-${request.id}`,
      req: actor.req || null,
    });
    if (actor.failAfterPost) {
      const err = new Error("forced");
      err.code = "FORCED_ROLLBACK";
      throw err;
    }
    const info = await db.run(
      `UPDATE shop_consumption_requests
         SET status = 'approved', consumption_id = ?, manager_id = ?, decision_source = ?,
             telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, approved_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        created.id,
        decisionSource === "telegram" ? null : actor.officeUser?.id ?? null,
        decisionSource,
        actor.telegramActor?.id || null,
        actor.telegramActor?.username || null,
        actor.telegramActor?.name || null,
        request.id,
      ]
    );
    if (!info.changes) {
      const err = new HttpError(409, "تمت المعالجة مسبقاً", "ALREADY_HANDLED");
      err.action = "already_handled";
      throw err;
    }
    const cashAfter = await db.get(
      "SELECT COUNT(*) AS n FROM shift_cash_movements WHERE shift_id = ?",
      [request.shift_id]
    );
    if (Number(cashAfter.n) !== Number(cashBefore.n)) throw new Error("shop consumption must not move the drawer");
    return { created, request };
  });
  await editConsumptionTelegram(
    posted.request,
    "approved",
    actor.telegramActor?.name || actor.telegramActor?.username || actor.officeUser?.username || ""
  );
  return { ...posted.created, request_id: posted.request.id, pending_approval: false, status: "approved" };
}

async function editConsumptionTelegram(request, status, approverName) {
  if (!request?.telegram_message_id) return;
  const { isApprovalsTelegramConfigured, editGroupApprovalMessage, telegramFailureLog } = await import("../utils/telegram.js");
  if (!isApprovalsTelegramConfigured()) return;
  try {
    await editGroupApprovalMessage({
      kind: "consumption",
      messageId: request.telegram_message_id,
      requestId: request.id,
      status,
      approverName,
    });
  } catch (err) {
    console.error(
      `[telegram-approval] stage=edit_failed request=${request.id} kind=consumption ${telegramFailureLog(err)}`
    );
  }
}

export async function rejectShopConsumptionRequest(db, requestId, actor = {}) {
  const decisionSource = actor.decisionSource || "admin";
  if (decisionSource !== "telegram") {
    const { userHasAccountantPermission } = await import("../utils/accountantPermissions.js");
    const permitted = await userHasAccountantPermission(db, actor.officeUser, "expenses");
    if (!permitted) throw new HttpError(403, "حساب الموافق لا يملك صلاحية الموافقة", "FORBIDDEN");
  }
  const updated = await withTransaction(db, async () => {
    const beforeStock = await db.get("SELECT COUNT(*) AS n FROM inventory_ledger");
    const beforeExp = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const info = await db.run(
      `UPDATE shop_consumption_requests
         SET status = 'rejected', manager_id = ?, decision_source = ?,
             telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, rejected_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        decisionSource === "telegram" ? null : actor.officeUser?.id ?? null,
        decisionSource,
        actor.telegramActor?.id || null,
        actor.telegramActor?.username || null,
        actor.telegramActor?.name || null,
        requestId,
      ]
    );
    if (!info.changes) {
      const err = new HttpError(409, "تمت المعالجة مسبقاً", "ALREADY_HANDLED");
      err.action = "already_handled";
      throw err;
    }
    if (Number(beforeStock.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n)) {
      throw new Error("reject must not move stock");
    }
    if (Number(beforeExp.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)) {
      throw new Error("reject must not post an expense");
    }
    return db.get("SELECT * FROM shop_consumption_requests WHERE id = ?", [requestId]);
  });
  await editConsumptionTelegram(updated, "rejected", actor.telegramActor?.name || actor.telegramActor?.username || actor.officeUser?.username || "");
  return updated;
}
