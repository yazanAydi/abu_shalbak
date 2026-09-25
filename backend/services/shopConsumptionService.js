import { createHash } from "node:crypto";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { withTransaction } from "../utils/dbTx.js";
import { HttpError, badRequest, conflict } from "../utils/httpError.js";
import { recordMovement } from "../utils/inventory.js";
import { round2, sumMoney } from "../utils/money.js";
import {
  getDefaultUnit,
  isKgUnit,
  isProductCostKnown,
  resolveSoldUnitCost,
  toBaseQuantity,
} from "../utils/productUnits.js";
import { applyOutboundBatches } from "./stockBatchService.js";
import { shopTodayYmd, shopYmdFromTimestamp } from "../utils/shopTime.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { enqueueOperationPrint, shopConsumptionPrintSnapshot } from "./operationPrintService.js";

const SOURCE = "shop_consumption";

export function unknownCostBlockMessage(names) {
  const listed = names.join("، ");
  return (
    `لا يمكن ترحيل مصاريف المحل قبل تسجيل تكلفة الشراء من المكتب ` +
    `(بطاقة الصنف أو فاتورة شراء مرحّلة) لهذه الأصناف: ${listed}`
  );
}

export function fingerprintShopConsumption(lines, reason) {
  const payload = {
    reason: reason || null,
    items: lines.map((line) => ({
      product_id: line.product_id,
      product_unit_id: line.product_unit_id,
      quantity: line.quantity,
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
    `SELECT id, name, barcode, sku, price, cost, cost_known, stock, is_active, is_weighed
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

    const qty = parseQuantity(product, unit, Number(raw.quantity));
    const conversion = Math.max(0.0001, Number(unit.conversion_to_base) || 1);
    const baseQuantity = toBaseQuantity(qty, conversion);
    if (!(baseQuantity > 0)) throw badRequest("الكمية غير صالحة", "INVALID_QTY");

    lines.push({
      product_id: productId,
      product_unit_id: unitId,
      barcode: unit.barcode || product.barcode || null,
      name: product.name,
      quantity: qty,
      unit_name: unit.unit_name,
      conversion_to_base: conversion,
      base_quantity: baseQuantity,
      stock: Number(product.stock) || 0,
      product,
    });
  }

  const unknown = [];
  for (const line of lines) {
    if (!isProductCostKnown(line.product)) {
      if (!unknown.includes(line.name)) unknown.push(line.name);
      continue;
    }
    const unitCost = resolveSoldUnitCost(
      { conversion_to_base: line.conversion_to_base },
      line.product
    );
    line.unit_cost = unitCost;
    line.line_cost = round2(unitCost * line.quantity);
  }
  if (unknown.length) {
    throw badRequest(unknownCostBlockMessage(unknown), "UNKNOWN_COST");
  }

  const published = lines.map(({ product, ...line }) => line);
  return { lines: published, total_cost: sumMoney(published.map((line) => line.line_cost)) };
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
    unit_cost: line.unit_cost,
    line_cost: line.line_cost,
  }));
}

export async function previewShopConsumption(db, { cashierId, items }) {
  const { shift, error } = await requireOpenShiftForCashier(db, cashierId);
  if (!shift) throw conflict(error, "SHIFT_REQUIRED");
  const resolved = await resolveLines(db, items);
  assertStockAvailable(resolved.lines);
  return {
    business_day: businessDayForShift(shift),
    shift_id: shift.id,
    lines: publicLines(resolved.lines),
    total_cost: resolved.total_cost,
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
    `SELECT product_id, name, quantity, unit_name, unit_cost, line_cost
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
    operating_expense_id: row.operating_expense_id,
    payment_method: row.payment_method,
    created_at: row.created_at,
    lines: items.map((item) => ({
      ...item,
      unit_cost: round2(Number(item.unit_cost) || 0),
      line_cost: round2(Number(item.line_cost) || 0),
    })),
  };
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

async function postShopConsumptionInTx(db, { cashierId, items, reason, idempotencyKey, req }) {
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  const note = reason != null && String(reason).trim() !== "" ? String(reason).trim().slice(0, 500) : null;

  const { shift, error } = await requireOpenShiftForCashier(db, cashierId);
    if (!shift) throw conflict(error, "SHIFT_REQUIRED");
    const resolved = await resolveLines(db, items);
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
         (shift_id, user_id, business_day, reason, total_cost, operating_expense_id, idempotency_key, payload_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [shift.id, cashierId, businessDay, note, resolved.total_cost, exp.lastID, key, fingerprint]
    );
    const consumptionId = ins.lastID;
    await db.run("UPDATE operating_expenses SET source_id = ? WHERE id = ?", [consumptionId, exp.lastID]);

    for (const line of resolved.lines) {
      await db.run(
        `INSERT INTO shop_consumption_items
           (consumption_id, product_id, product_unit_id, barcode, name, quantity, unit_name,
            conversion_to_base, base_quantity, unit_cost, line_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        unitCost: line.unit_cost,
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

async function displayLines(db, row) {
  if (row.consumption_id) {
    const items = await db.all(
      `SELECT name, quantity, unit_name, line_cost
         FROM shop_consumption_items WHERE consumption_id = ? ORDER BY id`,
      [row.consumption_id]
    );
    const head = await db.get("SELECT total_cost FROM shop_consumptions WHERE id = ?", [row.consumption_id]);
    return {
      items: items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit_name: item.unit_name,
        line_cost: round2(Number(item.line_cost) || 0),
      })),
      amount: round2(Number(head?.total_cost) || 0),
    };
  }

  let raw = [];
  try {
    raw = JSON.parse(row.items_json || "[]");
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  const ids = [...new Set(raw.map((item) => Number(item.product_id)).filter((id) => id > 0))];
  const placeholders = ids.map(() => "?").join(",");
  const products = ids.length
    ? await db.all(`SELECT id, name, cost, cost_known FROM products WHERE id IN (${placeholders})`, ids)
    : [];
  const units = ids.length
    ? await db.all(
        `SELECT id, product_id, unit_name, conversion_to_base, is_default
           FROM product_units WHERE product_id IN (${placeholders})
          ORDER BY is_default DESC, id ASC`,
        ids
      )
    : [];
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const unitsByProduct = new Map();
  for (const unit of units) {
    const pid = Number(unit.product_id);
    if (!unitsByProduct.has(pid)) unitsByProduct.set(pid, []);
    unitsByProduct.get(pid).push(unit);
  }

  const items = [];
  let amount = 0;
  let complete = raw.length > 0;
  for (const item of raw) {
    const productId = Number(item.product_id);
    const product = productById.get(productId);
    const unitId =
      item.unit_id != null ? Number(item.unit_id) : item.product_unit_id != null ? Number(item.product_unit_id) : null;
    const productUnits = unitsByProduct.get(productId) || [];
    const unit = (unitId && productUnits.find((entry) => Number(entry.id) === unitId)) || productUnits[0] || null;
    const quantity = Number(item.quantity);
    let lineCost = null;
    if (product && unit && isProductCostKnown(product) && Number.isFinite(quantity)) {
      const unitCost = resolveSoldUnitCost({ conversion_to_base: unit.conversion_to_base }, product);
      lineCost = round2(unitCost * quantity);
      amount = sumMoney([amount, lineCost]);
    } else {
      complete = false;
    }
    items.push({
      name: product?.name || `صنف #${productId || "?"}`,
      quantity: Number.isFinite(quantity) ? quantity : item.quantity,
      unit_name: unit?.unit_name || null,
      line_cost: lineCost,
    });
  }
  return { items, amount: complete ? amount : null };
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
  const resolved = await resolveLines(db, params.items);
  assertStockAvailable(resolved.lines);
  const fingerprint = fingerprintShopConsumption(resolved.lines, note);
  const stockBefore = await db.get("SELECT stock FROM products WHERE id = ?", [resolved.lines[0].product_id]);

  const created = await withTransaction(db, async () => {
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
      [params.cashierId, shift.id, JSON.stringify(params.items), note, key, fingerprint]
    );
    if (Number(expenses.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)) {
      throw new Error("pending consumption must not post an expense");
    }
    if (Number(ledger.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n)) {
      throw new Error("pending consumption must not move stock");
    }
    return { request: await db.get("SELECT * FROM shop_consumption_requests WHERE id = ?", [ins.lastID]), replayed: false };
  });

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

  return {
    request_id: created.request.id,
    status: created.request.status,
    pending_approval: created.request.status === "pending",
    replayed: created.replayed,
    shift_id: created.request.shift_id,
    total_cost: resolved.total_cost,
    lines: publicLines(resolved.lines),
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
    const created = await postShopConsumptionInTx(db, {
      cashierId: request.cashier_id,
      items: JSON.parse(request.items_json),
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
