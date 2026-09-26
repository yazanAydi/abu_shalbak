import { createHash } from "node:crypto";
import { parseItemsJson } from "../utils/cogs.js";
import { requireOpenShiftForCashier, getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals } from "../utils/tax.js";
import { allocatePosRefundPayable, round2 } from "../utils/money.js";
import { recordMovement } from "../utils/inventory.js";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import {
  isRefundTelegramConfigured,
  sendRefundApprovalMessage,
  editRefundRequestMessage,
  sendRefundDecisionStatusMessage,
} from "../utils/telegram.js";
import { withTransaction } from "../utils/dbTx.js";
import { computeExpectedBaseCash, loadSalePayments } from "../utils/salePayments.js";
import { restoreSaleBatches } from "./stockBatchService.js";
import { businessDayFromTimestamp } from "../utils/businessDay.js";
import {
  lockOriginatingShift,
  rejectHandoverFields,
  updateOutstandingHandover,
} from "./originatingShiftDecision.js";

export function assertRefundPaymentMethod(salePayments, paymentMethod) {
  const hasOnAccount = (salePayments || []).some((l) => l.method === "on_account");
  if (hasOnAccount) {
    if (paymentMethod !== "on_account") {
      const err = new Error("بيع على الذمة يُسترجع على حساب العميل فقط");
      err.status = 400;
      err.code = "REFUND_METHOD_MISMATCH";
      throw err;
    }
    return;
  }
  if (paymentMethod !== "cash" && paymentMethod !== "visa") {
    const err = new Error("طريقة الدفع يجب أن تكون نقداً أو بطاقة");
    err.status = 400;
    err.code = "REFUND_METHOD_MISMATCH";
    throw err;
  }
}

/** True when transaction_items.line_net already equals the amount the customer paid. */
function saleMerchandiseBasis(tx) {
  if (tx?.amount_before_rounding != null && tx.amount_before_rounding !== "") {
    return round2(Number(tx.amount_before_rounding));
  }
  return round2(Number(tx?.total) || 0);
}

function postedLineNetMatchesSaleTotal(tx, storedItems) {
  if (!storedItems?.length) return false;
  const net = round2(storedItems.reduce((sum, row) => sum + (Number(row.line_net) || 0), 0));
  return Math.abs(net - saleMerchandiseBasis(tx)) <= 0.02;
}

function refundedUnitPrice(orig, tx, origItems) {
  const qty = Number(orig.quantity) || 0;
  if (qty <= 0) return orig.price;
  if (orig.posted_unit_price != null && Number.isFinite(Number(orig.posted_unit_price))) {
    return round2(Number(orig.posted_unit_price));
  }
  const lineDiscount = Number(orig.discount_at_sale ?? orig.discount ?? 0);
  if (lineDiscount > 0) {
    return round2((orig.price * qty - lineDiscount) / qty);
  }
  const orderDiscount = round2(Number(tx.discount) || 0);
  if (orderDiscount <= 0) return orig.price;
  const gross = (origItems || []).reduce(
    (s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0),
    0
  );
  if (gross <= 0) return orig.price;
  const share = (qty * orig.price) / gross;
  return round2(orig.price - (orderDiscount * share) / qty);
}

function lineKey(it) {
  const pid = Number(it.product_id);
  const uid = Number(it.unit_id ?? it.product_unit_id ?? 0);
  return `${pid}:${uid}`;
}

export function refundLineKey(it) {
  return lineKey(it);
}

function mergeItemsIntoMap(map, itemsJson) {
  const arr = parseItemsJson(itemsJson);
  if (!Array.isArray(arr)) return;
  for (const it of arr) {
    const pid = Number(it.product_id);
    const q = Number(it.quantity) || 0;
    if (!pid || q <= 0) continue;
    const key = lineKey(it);
    map.set(key, (map.get(key) || 0) + q);
  }
}

/** Sum returned quantities: completed refunds plus still-pending requests. */
export async function refundedQtyByProduct(db, transactionId, excludeRequestId = null) {
  const maps = await refundedQtyByTransactions(db, [transactionId], excludeRequestId);
  return maps.get(Number(transactionId)) || new Map();
}

/** Batch refunded qty maps keyed by transaction id. */
export async function refundedQtyByTransactions(db, transactionIds, excludeRequestId = null) {
  const ids = [...new Set((transactionIds || []).map(Number).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const refundRows = await db.all(
    `SELECT original_transaction_id, items_json FROM refunds
     WHERE original_transaction_id IN (${ph}) AND status != 'rejected'`,
    ids
  );
  for (const row of refundRows) {
    mergeItemsIntoMap(out.get(Number(row.original_transaction_id)), row.items_json);
  }
  // Approved requests already have a refund row. Counting both would
  // consume the quantity twice and block a later partial return.
  const requestRows = await db.all(
    `SELECT id, transaction_id, items_json FROM refund_requests
     WHERE transaction_id IN (${ph}) AND status = 'pending'`,
    ids
  );
  for (const row of requestRows) {
    if (excludeRequestId && Number(row.id) === Number(excludeRequestId)) continue;
    mergeItemsIntoMap(out.get(Number(row.transaction_id)), row.items_json);
  }
  return out;
}

/** Apply stock + cash movement (call only when approving) */
export async function applyApprovedRefundEffects(db, refund) {
  const items = parseItemsJson(refund.items_json);
  if (!Array.isArray(items)) throw new Error("بيانات الاسترجاع غير صالحة");
  for (const L of items) {
    const q = Number(L.quantity) || 0;
    const pid = Number(L.product_id);
    if (pid && q > 0) {
      const conversion = Math.max(0.0001, Number(L.conversion_to_base) || 1);
      let refundDay = refund.business_day || null;
      if (!refundDay && refund.shift_id) {
        const shiftDay = await db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [refund.shift_id]);
        refundDay = shiftDay?.business_day || null;
      }
      const itemRef = L.transaction_item_id ? ` بند #${L.transaction_item_id}` : "";
      await recordMovement(db, {
        productId: pid,
        movementType: "refund",
        quantity: q * conversion,
        refType: "refund",
        refId: refund.id,
        notes: `استرجاع #${refund.id} من فاتورة #${refund.original_transaction_id}${itemRef}`,
        userId: refund.cashier_id || refund.approved_by_id || null,
        applyStock: true,
        businessDay: refundDay,
      });
      await restoreSaleBatches(db, {
        transactionId: refund.original_transaction_id,
        productId: pid,
        quantity: q * conversion,
        refundId: refund.id,
      });
    }
  }
  if (refund.payment_method === "on_account") {
    const tx = await db.get(
      "SELECT customer_id, total FROM transactions WHERE id = ?",
      [refund.original_transaction_id]
    );
    const custId = Number(tx?.customer_id);
    if (!custId) {
      const err = new Error("لا يمكن استرجاع بيع الذمة: العميل غير موجود");
      err.status = 400;
      err.code = "CUSTOMER_REQUIRED";
      throw err;
    }
    const payments = await loadSalePayments(db, refund.original_transaction_id);
    const onAccountPaid = round2(
      payments
        .filter((l) => l.method === "on_account")
        .reduce((s, l) => s + Number(l.nis_equivalent || 0), 0)
    );
    const saleTotal = round2(Number(tx.total) || 0);
    const refundTotal = round2(Number(refund.total));
    const credit =
      saleTotal > 0 ? round2(refundTotal * (onAccountPaid / saleTotal)) : refundTotal;
    await db.run("UPDATE customers SET balance = balance - ? WHERE id = ?", [credit, custId]);
    return;
  }
  if (refund.payment_method === "cash" && refund.shift_id) {
    const total = round2(Number(refund.total));
    const shift = await db.get("SELECT opening_cash FROM cashier_shifts WHERE id = ?", [refund.shift_id]);
    if (shift) {
      const available = await computeExpectedBaseCash(db, refund.shift_id, shift.opening_cash);
      // approveRefundRequest inserts the row as approved before this runs, so the
      // drawer query has already subtracted this refund. Add it back for the check.
      const alreadyCounted =
        String(refund.status || "").toLowerCase() === "approved" ? total : 0;
      if (available + alreadyCounted + 0.005 < total) {
        const err = new Error(
          `النقد بالشيكل في الدرج غير كافٍ للاسترجاع (المتاح: ₪${available.toFixed(2)})`
        );
        err.status = 400;
        err.code = "INSUFFICIENT_CASH";
        throw err;
      }
    }
    await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, refund_id)
       VALUES (?, 'refund', ?, ?, ?)`,
      [refund.shift_id, -total, `استرجاع نقدي #${refund.id}`, refund.id]
    );
  }
}

async function loadRefundSaleContext(db, transactionId) {
  const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
  if (!tx) {
    const err = new Error("البيع الأصلي غير موجود");
    err.status = 404;
    throw err;
  }
  let origItems;
  try {
    origItems = JSON.parse(tx.items_json);
  } catch {
    const err = new Error("البيع الأصلي غير صالح");
    err.status = 500;
    throw err;
  }
  if (!Array.isArray(origItems)) {
    const err = new Error("الأصناف غير صالحة");
    err.status = 500;
    throw err;
  }
  const storedItems = await db.all(
    `SELECT id, product_id, product_unit_id, quantity, line_net, discount_at_sale
       FROM transaction_items WHERE transaction_id = ? ORDER BY id`,
    [transactionId]
  );
  const usePostedNet = postedLineNetMatchesSaleTotal(tx, storedItems);
  const postedByKey = new Map();
  const storedById = new Map();
  for (const row of storedItems) {
    storedById.set(Number(row.id), row);
    const key = `${Number(row.product_id)}:${Number(row.product_unit_id) || 0}`;
    const prev = postedByKey.get(key) || { quantity: 0, line_net: 0, discount_at_sale: 0, ids: [] };
    prev.quantity += Number(row.quantity) || 0;
    prev.line_net = round2(prev.line_net + (Number(row.line_net) || 0));
    prev.discount_at_sale = round2(prev.discount_at_sale + (Number(row.discount_at_sale) || 0));
    prev.ids.push(Number(row.id));
    postedByKey.set(key, prev);
  }
  const origMap = new Map();
  for (const it of origItems) {
    const pid = Number(it.product_id);
    if (!pid) continue;
    const key = lineKey(it);
    const posted = postedByKey.get(key);
    const postedUnit =
      usePostedNet && posted && posted.quantity > 0 && Number.isFinite(posted.line_net)
        ? round2(posted.line_net / posted.quantity)
        : null;
    origMap.set(key, {
      ...it,
      quantity: Number(it.quantity) || 0,
      price: round2(Number(it.price) || 0),
      posted_unit_price: postedUnit,
      discount_at_sale: posted?.discount_at_sale ?? Number(it.discount_at_sale || it.discount || 0),
      conversion_to_base: Math.max(0.0001, Number(it.conversion_to_base) || 1),
      transaction_item_ids: posted?.ids || [],
    });
  }
  return { tx, origItems, origMap, storedById };
}

function storedRowForLine(ctx, pid, key, requestedItemId) {
  if (requestedItemId) {
    const row = ctx.storedById.get(Number(requestedItemId));
    if (!row || Number(row.product_id) !== Number(pid)) {
      const err = new Error("البند المطلوب ليس في البيع الأصلي");
      err.status = 400;
      throw err;
    }
    return row;
  }
  const ids = ctx.origMap.get(key)?.transaction_item_ids || [];
  if (ids.length === 1) return ctx.storedById.get(ids[0]) || null;
  return null;
}

function normalizeIdempotencyKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  return key || null;
}

function refundPayloadFingerprint({ transactionId, lines, paymentMethod }) {
  const norm = (lines || [])
    .map((line) => ({
      product_id: Number(line.product_id) || 0,
      unit_id: Number(line.unit_id ?? line.product_unit_id ?? 0) || 0,
      transaction_item_id: Number(line.transaction_item_id) || 0,
      quantity: round2(Number(line.quantity) || 0),
    }))
    .sort(
      (a, b) =>
        a.transaction_item_id - b.transaction_item_id ||
        a.product_id - b.product_id ||
        a.unit_id - b.unit_id ||
        a.quantity - b.quantity
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        transactionId: Number(transactionId),
        paymentMethod,
        lines: norm,
      })
    )
    .digest("hex");
}

async function processingBusinessDay(db, shiftId, nowIso) {
  if (shiftId) {
    const shift = await db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (shift?.business_day) return shift.business_day;
  }
  const settings = await getAppSettings(db);
  return businessDayFromTimestamp(nowIso, settings.business_day_cutoff_hour);
}

async function buildRefundLines(db, transactionId, lines, excludeRequestId = null) {
  const ctx = await loadRefundSaleContext(db, transactionId);
  const { tx, origItems, origMap, storedById } = ctx;
  const refundedSoFar = await refundedQtyByProduct(db, transactionId, excludeRequestId);
  const refundLines = [];
  for (const L of lines) {
    const pid = Number(L.product_id);
    let unitId = Number(L.unit_id ?? L.product_unit_id ?? 0);
    const requestedItemId = Number(L.transaction_item_id) || 0;
    const want = Math.max(0, Number(L.quantity) || 0);
    if (!pid || want <= 0) {
      const err = new Error("سطر إرجاع غير صالح");
      err.status = 400;
      throw err;
    }
    if (requestedItemId) {
      const pinned = storedById.get(requestedItemId);
      if (!pinned || Number(pinned.product_id) !== pid) {
        const err = new Error("البند المطلوب ليس في البيع الأصلي");
        err.status = 400;
        throw err;
      }
      if (!unitId) unitId = Number(pinned.product_unit_id) || 0;
    }
    const key = `${pid}:${unitId}`;
    const orig = origMap.get(key) || (unitId === 0 ? origMap.get(`${pid}:0`) : null);
    if (!orig && unitId === 0) {
      const productKeys = [...origMap.keys()].filter((k) => k.startsWith(`${pid}:`));
      if (productKeys.length !== 1) {
        const err = new Error(`حدد الوحدة للمنتج ${pid}`);
        err.status = 400;
        err.code = "UNIT_REQUIRED";
        throw err;
      }
      const onlyKey = productKeys[0];
      const v = origMap.get(onlyKey);
      const cap = v.quantity - (refundedSoFar.get(onlyKey) || 0);
      if (want > cap) {
        const err = new Error(`الكمية كبيرة جداً للمنتج ${pid}`);
        err.status = 400;
        err.max_returnable = cap;
        throw err;
      }
      const unitPrice = refundedUnitPrice(v, tx, origItems);
      const stored = storedRowForLine(ctx, pid, onlyKey, requestedItemId);
      refundLines.push({
        product_id: pid,
        transaction_item_id: stored?.id ?? null,
        unit_id: Number(onlyKey.split(":")[1]) || null,
        barcode: v.barcode,
        name: v.name,
        unit_name: v.unit_name,
        quantity: want,
        price: unitPrice,
        tax_rate: v.tax_rate,
        conversion_to_base: v.conversion_to_base,
        lineTotal: round2(want * unitPrice),
      });
      refundedSoFar.set(onlyKey, (refundedSoFar.get(onlyKey) || 0) + want);
      continue;
    }
    if (!orig) {
      const err = new Error(`المنتج ${pid} ليس في البيع الأصلي`);
      err.status = 400;
      throw err;
    }
    const cap = orig.quantity - (refundedSoFar.get(key) || 0);
    if (want > cap) {
      const err = new Error(`الكمية كبيرة جداً للمنتج ${pid}`);
      err.status = 400;
      err.max_returnable = cap;
      throw err;
    }
    const unitPrice = refundedUnitPrice(orig, tx, origItems);
    const stored = storedRowForLine(ctx, pid, key, requestedItemId);
    refundLines.push({
      product_id: pid,
      transaction_item_id: stored?.id ?? null,
      unit_id: unitId || null,
      barcode: orig.barcode,
      name: orig.name,
      unit_name: orig.unit_name,
      quantity: want,
      price: unitPrice,
      tax_rate: orig.tax_rate,
      conversion_to_base: orig.conversion_to_base,
      lineTotal: round2(want * unitPrice),
    });
    refundedSoFar.set(key, (refundedSoFar.get(key) || 0) + want);
  }
  if (refundLines.length === 0) {
    const err = new Error("لا توجد أسطر إرجاع صالحة");
    err.status = 400;
    throw err;
  }
  const settings = await getAppSettings(db);
  const taxLines = refundLines.map((L) => ({
    quantity: L.quantity,
    unitPrice: L.price,
    taxRate: Number(L.tax_rate ?? 0),
  }));
  const { subtotal, tax, total: merchandise } = computeSaleTotals(taxLines, settings);
  const prior = await db.get(
    `SELECT COALESCE(SUM(total_amount), 0) AS paid
       FROM refund_requests
      WHERE transaction_id = ? AND status IN ('pending', 'approved')
        AND (? IS NULL OR id != ?)`,
    [tx.id, excludeRequestId, excludeRequestId]
  );
  let exhaustsSale = origMap.size > 0;
  for (const [key, orig] of origMap) {
    const done = refundedSoFar.get(key) || 0;
    if (done + 1e-6 < Number(orig.quantity)) {
      exhaustsSale = false;
      break;
    }
  }
  const allocated = allocatePosRefundPayable({
    merchandise,
    saleMerchandise: saleMerchandiseBasis(tx),
    saleAdjustment:
      tx.rounding_adjustment != null && tx.rounding_adjustment !== ""
        ? Number(tx.rounding_adjustment)
        : 0,
    salePayable: Number(tx.total) || 0,
    alreadyRefunded: Number(prior?.paid) || 0,
    exhaustsSale,
  });
  const total = allocated.payable;
  const roundingAdjustment = allocated.adjustment;
  return {
    tx,
    refundLines,
    subtotal,
    tax,
    total,
    roundingAdjustment,
    itemsJson: JSON.stringify(
      refundLines.map((x) => ({
        product_id: x.product_id,
        transaction_item_id: x.transaction_item_id || null,
        unit_id: x.unit_id,
        barcode: x.barcode,
        name: x.name,
        unit_name: x.unit_name,
        quantity: x.quantity,
        price: x.price,
        conversion_to_base: x.conversion_to_base,
      }))
    ),
  };
}

export async function getTelegramManagerUser(db) {
  const settings = await getAppSettings(db);
  const uid = Number(settings.refund_telegram_manager_user_id);
  if (!uid) return null;
  const user = await db.get(
    "SELECT id, username, role, permissions_json FROM users WHERE id = ?",
    [uid]
  );
  if (!user) return null;
  if (user.role !== "admin" && user.role !== "accountant") return null;
  return user;
}

/**
 * Resolve which shift should receive refund cash / reporting attribution at approval time.
 * Cash refunds require an open shift for the requesting cashier.
 */
export async function resolveRefundTargetShift(db, { cashierId, paymentMethod, fallbackShiftId }) {
  const openShift = await getOpenShiftForCashier(db, cashierId);
  if (paymentMethod === "cash") {
    if (!openShift) {
      const err = new Error("لا يمكن صرف الاسترجاع النقدي: لا توجد وردية مفتوحة للكاشير");
      err.status = 400;
      err.code = "NO_OPEN_SHIFT_FOR_REFUND";
      throw err;
    }
    return openShift.id;
  }
  return openShift?.id ?? fallbackShiftId ?? null;
}

export async function createRefundRequest(db, params) {
  const { cashierId, transactionId, lines, paymentMethod, reason, req } = params;
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
  const fingerprint = idempotencyKey
    ? refundPayloadFingerprint({ transactionId, lines, paymentMethod })
    : null;

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    const err = new Error(shiftErr || "لا توجد وردية مفتوحة");
    err.status = 400;
    throw err;
  }

  const payments = await loadSalePayments(db, transactionId);
  assertRefundPaymentMethod(payments, paymentMethod);

  const created = await withTransaction(db, async () => {
    if (idempotencyKey) {
      const existing = await db.get("SELECT * FROM refund_requests WHERE idempotency_key = ?", [
        idempotencyKey,
      ]);
      if (existing) {
        if (Number(existing.cashier_id) !== Number(cashierId)) {
          const err = new Error("مفتاح التكرار لا يخص هذا الصندوق");
          err.status = 403;
          err.code = "IDEMPOTENCY_OWNER_MISMATCH";
          throw err;
        }
        if (existing.payload_fingerprint && existing.payload_fingerprint !== fingerprint) {
          const err = new Error("تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.");
          err.status = 409;
          err.code = "IDEMPOTENCY_KEY_REUSE";
          throw err;
        }
        return {
          replay: true,
          request: existing,
          request_id: existing.id,
          total: existing.total_amount,
          transactionId,
          reason,
        };
      }
    }

    const { subtotal, tax, total, roundingAdjustment, itemsJson } = await buildRefundLines(
      db,
      transactionId,
      lines
    );
    const ins = await db.run(
      `INSERT INTO refund_requests (
        transaction_id, cashier_id, shift_id, items_json, subtotal, tax, total_amount,
        rounding_adjustment, payment_method, reason, status, idempotency_key, payload_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        transactionId,
        cashierId,
        shift.id,
        itemsJson,
        subtotal,
        tax,
        total,
        roundingAdjustment,
        paymentMethod,
        reason != null ? String(reason) : null,
        idempotencyKey,
        fingerprint,
      ]
    );
    const requestId = ins.lastID;
    const row = await db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [cashierId]);

    if (req?.user) {
      await logAuditUser(db, req.user, AUDIT_ACTIONS.REFUND_REQUEST_CREATE, "refund_requests", requestId, null, {
        transaction_id: transactionId,
        total_amount: total,
      });
    }

    return {
      request: row,
      request_id: requestId,
      total,
      cashier,
      transactionId,
      reason,
    };
  });

  if (created.replay) {
    return {
      request: created.request,
      request_id: created.request_id,
      replayed: true,
      telegram: false,
      message: "طلب الاسترجاع مسجّل مسبقاً بهذا المفتاح.",
    };
  }

  let telegramMessageId = null;
  if (isRefundTelegramConfigured()) {
    try {
      telegramMessageId = await sendRefundApprovalMessage({
        requestId: created.request_id,
        cashierName: created.cashier?.username || String(cashierId),
        transactionId: created.transactionId,
        total: created.total,
        reason: created.reason || "",
        items: parseItemsJson(created.request.items_json),
      });
      await db.run("UPDATE refund_requests SET telegram_message_id = ? WHERE id = ?", [
        telegramMessageId,
        created.request_id,
      ]);
      created.request.telegram_message_id = telegramMessageId;
    } catch (e) {
      console.error("Telegram send failed:", e.message);
    }
  }

  return {
    request: created.request,
    request_id: created.request_id,
    telegram: isRefundTelegramConfigured() && !!telegramMessageId,
    message:
      "سُجّل طلب الاسترجاع قيد المراجعة. لن يُحدَّث المخزون أو النقد حتى موافقة المسؤول.",
  };
}

function returnHistoryLines(itemsJson) {
  const arr = parseItemsJson(itemsJson);
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => ({
    product_id: Number(it.product_id) || null,
    transaction_item_id: Number(it.transaction_item_id) || null,
    name: it.name || "",
    quantity: Number(it.quantity) || 0,
    unit_price: round2(Number(it.price) || 0),
  }));
}

/** Completed sale by internal id or receipt number (INV-…). */
export async function findCompletedSale(db, rawKey) {
  const key = String(rawKey ?? "").trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    const byId = await db.get(
      `SELECT * FROM transactions WHERE id = ? AND COALESCE(status, 'completed') = 'completed'`,
      [Number(key)]
    );
    if (byId) return byId;
  }
  return db.get(
    `SELECT * FROM transactions WHERE receipt_number = ? AND COALESCE(status, 'completed') = 'completed'`,
    [key]
  );
}

/**
 * Cashier-safe view of a sale for a return.
 * Prices are the amounts actually charged. Cost, profit, and supplier fields are omitted.
 */
export async function describeReturnableSale(db, tx) {
  const ctx = await loadRefundSaleContext(db, tx.id);
  const already = await refundedQtyByProduct(db, tx.id);
  const lines = ctx.origItems.map((it) => {
    const pid = Number(it.product_id);
    const key = lineKey(it);
    const orig = ctx.origMap.get(key);
    const sold = Number(it.quantity) || 0;
    const ref = already.get(key) || 0;
    const ids = orig?.transaction_item_ids || [];
    return {
      transaction_item_id: ids.length === 1 ? ids[0] : null,
      product_id: pid,
      unit_id: Number(it.unit_id ?? it.product_unit_id) || null,
      unit_name: it.unit_name ?? null,
      name: it.name,
      price: orig ? refundedUnitPrice(orig, tx, ctx.origItems) : round2(Number(it.price) || 0),
      list_price: round2(Number(it.price) || 0),
      line_discount: round2(Number(orig?.discount_at_sale) || 0),
      quantity_sold: sold,
      quantity_already_refunded: ref,
      quantity_returnable: Math.max(0, sold - ref),
    };
  });
  const cashier = await db.get("SELECT username FROM users WHERE id = ?", [tx.cashier_id]);
  const shift = tx.shift_id
    ? await db.get("SELECT id, business_day, cashier_id FROM cashier_shifts WHERE id = ?", [tx.shift_id])
    : null;
  const payments = await loadSalePayments(db, tx.id);
  const refundRows = await db.all(
    `SELECT r.id, r.total, r.payment_method, r.items_json, r.created_at, r.business_day, r.shift_id,
            r.cashier_id, u.username AS cashier_username
       FROM refunds r
       LEFT JOIN users u ON u.id = r.cashier_id
      WHERE r.original_transaction_id = ? AND r.status = 'approved'
      ORDER BY r.id`,
    [tx.id]
  );
  const pendingRows = await db.all(
    `SELECT rr.id, rr.total_amount, rr.payment_method, rr.items_json, rr.created_at, rr.shift_id,
            rr.cashier_id, u.username AS cashier_username, s.business_day
       FROM refund_requests rr
       LEFT JOIN users u ON u.id = rr.cashier_id
       LEFT JOIN cashier_shifts s ON s.id = rr.shift_id
      WHERE rr.transaction_id = ? AND rr.status = 'pending'
      ORDER BY rr.id`,
    [tx.id]
  );
  const returns = [
    ...refundRows.map((row) => ({
      kind: "refund",
      id: row.id,
      amount: round2(Number(row.total) || 0),
      refund_method: row.payment_method,
      created_at: row.created_at,
      business_day: row.business_day || null,
      shift_id: row.shift_id ?? null,
      cashier_username: row.cashier_username || "",
      lines: returnHistoryLines(row.items_json),
    })),
    ...pendingRows.map((row) => ({
      kind: "pending",
      id: row.id,
      amount: round2(Number(row.total_amount) || 0),
      refund_method: row.payment_method,
      created_at: row.created_at,
      business_day: row.business_day || null,
      shift_id: row.shift_id ?? null,
      cashier_username: row.cashier_username || "",
      lines: returnHistoryLines(row.items_json),
    })),
  ];
  return {
    transaction_id: tx.id,
    receipt_number: tx.receipt_number || null,
    created_at: tx.created_at,
    business_day: tx.business_day || shift?.business_day || null,
    shift_id: tx.shift_id ?? null,
    cashier_username: cashier?.username || "",
    payment_method: tx.payment_method,
    payments: payments.map((p) => ({
      method: p.method,
      amount: round2(Number(p.amount) || 0),
    })),
    has_on_account: payments.some((p) => p.method === "on_account"),
    discount: round2(Number(tx.discount) || 0),
    subtotal: tx.subtotal,
    total: tx.total,
    rounding_adjustment:
      tx.rounding_adjustment != null && tx.rounding_adjustment !== ""
        ? round2(Number(tx.rounding_adjustment) || 0)
        : 0,
    lines,
    returns,
  };
}

/** Quote the refund payable without writing a request. */
export async function previewRefundRequest(db, params) {
  const { cashierId, transactionId, lines, paymentMethod } = params;
  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    const err = new Error(shiftErr || "لا توجد وردية مفتوحة");
    err.status = 400;
    throw err;
  }
  const payments = await loadSalePayments(db, transactionId);
  assertRefundPaymentMethod(payments, paymentMethod);
  const built = await buildRefundLines(db, transactionId, lines);
  return {
    transaction_id: Number(transactionId),
    subtotal: built.subtotal,
    tax: built.tax,
    total: built.total,
    rounding_adjustment: built.roundingAdjustment,
    lines: built.refundLines.map((line) => ({
      product_id: line.product_id,
      transaction_item_id: line.transaction_item_id || null,
      unit_id: line.unit_id,
      name: line.name,
      quantity: line.quantity,
      price: line.price,
      line_total: line.lineTotal,
    })),
  };
}

export async function getRefundRequestById(db, id) {
  return db.get(
    `SELECT rr.*, u.username AS cashier_username, m.username AS manager_username,
            s.status AS shift_status
     FROM refund_requests rr
     JOIN users u ON u.id = rr.cashier_id
     LEFT JOIN users m ON m.id = rr.manager_id
     LEFT JOIN cashier_shifts s ON s.id = rr.shift_id
     WHERE rr.id = ?`,
    [id]
  );
}

export async function listPendingRefundRequests(db) {
  return db.all(
    `SELECT rr.*, u.username AS cashier_username, s.status AS shift_status
     FROM refund_requests rr
     JOIN users u ON u.id = rr.cashier_id
     LEFT JOIN cashier_shifts s ON s.id = rr.shift_id
     WHERE rr.status = 'pending'
     ORDER BY rr.created_at ASC, rr.id ASC`
  );
}

export async function recordRefundHandover(db, requestId, userId, disposition) {
  return updateOutstandingHandover(db, "refund_requests", requestId, userId, disposition);
}

export async function listRefundRequestHistory(db, status = "all", limit = 200) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  let sql = `SELECT rr.*, u.username AS cashier_username, m.username AS manager_username
             FROM refund_requests rr
             JOIN users u ON u.id = rr.cashier_id
             LEFT JOIN users m ON m.id = rr.manager_id
             WHERE rr.status != 'pending'`;
  const params = [];
  if (status === "approved" || status === "rejected") {
    sql += " AND rr.status = ?";
    params.push(status);
  }
  sql += " ORDER BY COALESCE(rr.approved_at, rr.rejected_at, rr.created_at) DESC, rr.id DESC LIMIT ?";
  params.push(lim);
  return db.all(sql, params);
}

export async function listMyRefundRequests(db, cashierId, limit = 100) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.all(
    `SELECT rr.*, m.username AS manager_username
     FROM refund_requests rr
     LEFT JOIN users m ON m.id = rr.manager_id
     WHERE rr.cashier_id = ?
     ORDER BY rr.created_at DESC, rr.id DESC
     LIMIT ?`,
    [Number(cashierId), lim]
  );
}

export async function listUnreadRefundDecisions(db, cashierId) {
  return db.all(
    `SELECT rr.*, m.username AS manager_username
     FROM refund_requests rr
     LEFT JOIN users m ON m.id = rr.manager_id
     WHERE rr.cashier_id = ?
       AND rr.status IN ('approved', 'rejected')
       AND rr.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(rr.approved_at, rr.rejected_at) ASC, rr.id ASC`,
    [Number(cashierId)]
  );
}

export async function acknowledgeRefundDecision(db, requestId, cashierId) {
  const row = await db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
  if (!row) {
    const err = new Error("طلب الاسترجاع غير موجود");
    err.status = 404;
    throw err;
  }
  if (Number(row.cashier_id) !== Number(cashierId)) {
    const err = new Error("ممنوع");
    err.status = 403;
    throw err;
  }
  if (!["approved", "rejected"].includes(row.status)) {
    const err = new Error("الطلب لم يُبت فيه بعد");
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  await db.run(
    `UPDATE refund_requests SET
       cashier_acknowledged_at = ?,
       cashier_notified_at = COALESCE(cashier_notified_at, ?)
     WHERE id = ?`,
    [now, now, requestId]
  );
  return getRefundRequestById(db, requestId);
}

async function notifyTelegramAfterDecision(request, managerUser, status, decisionSource) {
  if (!isRefundTelegramConfigured()) return;
  const payload = {
    requestId: request.id,
    status,
    transactionId: request.transaction_id,
    total: request.total_amount,
    approverName: managerUser?.username || null,
    decisionSource,
    items: parseItemsJson(request.items_json),
  };
  if (request.telegram_message_id) {
    try {
      await editRefundRequestMessage({
        messageId: request.telegram_message_id,
        ...payload,
      });
    } catch (e) {
      console.error("Telegram edit failed:", e.message);
    }
  }
  if (decisionSource === "admin") {
    try {
      await sendRefundDecisionStatusMessage(payload);
    } catch (e) {
      console.error("Telegram status message failed:", e.message);
    }
  }
}

export async function approveRefundRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin"
) {
  const { refund } = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب الاسترجاع غير موجود");
      err.status = 404;
      throw err;
    }
    if (request.status !== "pending") {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const pendingLines = parseItemsJson(request.items_json) || [];
    await buildRefundLines(db, request.transaction_id, pendingLines, requestId);

    const locked = await lockOriginatingShift(db, request.shift_id);
    let targetShiftId;
    const now = new Date().toISOString();
    if (locked.mode === "pending_count") {
      targetShiftId = locked.shift.id;
    } else {
      targetShiftId = await resolveRefundTargetShift(db, {
        cashierId: request.cashier_id,
        paymentMethod: request.payment_method,
        fallbackShiftId: request.shift_id,
      });
    }
    const refundBusinessDay = await processingBusinessDay(db, targetShiftId, now);
    const origTx = await db.get(
      "SELECT customer_id FROM transactions WHERE id = ?",
      [request.transaction_id]
    );
    const ins = await db.run(
      `INSERT INTO refunds (
        original_transaction_id, items_json, subtotal, tax, total, rounding_adjustment, payment_method,
        reason, cashier_id, shift_id, status, approved_at, approved_by_id, review_notes, customer_id,
        business_day
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
      [
        request.transaction_id,
        request.items_json,
        request.subtotal,
        request.tax,
        request.total_amount,
        request.rounding_adjustment,
        request.payment_method,
        request.reason,
        request.cashier_id,
        targetShiftId,
        now,
        decisionSource === "telegram" ? null : managerUser?.id ?? null,
        reviewNotes ?? request.review_notes,
        origTx?.customer_id ?? null,
        refundBusinessDay,
      ]
    );
    const refundId = ins.lastID;
    const refund = await db.get("SELECT * FROM refunds WHERE id = ?", [refundId]);
    await applyApprovedRefundEffects(db, refund);
    if (managerUser?.failAfterPost) {
      const err = new Error("forced");
      err.code = "FORCED_ROLLBACK";
      throw err;
    }

    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const decided = await db.run(
      `UPDATE refund_requests SET
        status = 'approved', manager_id = ?, approved_at = ?, refund_id = ?,
        review_notes = COALESCE(?, review_notes), rejected_at = NULL,
        decision_source = ?, telegram_actor_id = ?, telegram_actor_name = ?
       WHERE id = ? AND status = 'pending'`,
      [managerId, now, refundId, reviewNotes, decisionSource, actorId, actorName, requestId]
    );
    if (!decided.changes) {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.REFUND_REQUEST_APPROVE, "refund_requests", requestId, { status: "pending" }, {
      refund_id: refundId,
      manager_id: managerId,
      telegram_user_id: actorId,
      telegram_actor_name: actorName,
    });

    return { refund };
  });

  const updated = await getRefundRequestById(db, requestId);
  await notifyTelegramAfterDecision(updated, managerUser, "approved", decisionSource);
  return { request: updated, refund };
}

export async function rejectRefundRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin",
  options = {}
) {
  await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM refund_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب الاسترجاع غير موجود");
      err.status = 404;
      throw err;
    }
    if (request.status !== "pending") {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const locked = await lockOriginatingShift(db, request.shift_id);
    const now = new Date().toISOString();
    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const handover = rejectHandoverFields(
      locked.mode,
      options?.handoverDisposition,
      managerId
    );
    const decided = await db.run(
      `UPDATE refund_requests SET
        status = 'rejected', manager_id = ?, rejected_at = ?,
        review_notes = COALESCE(?, review_notes), approved_at = NULL, refund_id = NULL,
        decision_source = ?, telegram_actor_id = ?, telegram_actor_name = ?,
        handover_disposition = ?, handover_recorded_at = ?, handover_recorded_by = ?
       WHERE id = ? AND status = 'pending'`,
      [
        managerId,
        now,
        reviewNotes,
        decisionSource,
        actorId,
        actorName,
        handover.disposition,
        handover.recordedAt,
        handover.recordedBy,
        requestId,
      ]
    );
    if (!decided.changes) {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.REFUND_REQUEST_REJECT, "refund_requests", requestId, { status: "pending" }, {
      manager_id: managerId,
      telegram_user_id: actorId,
      telegram_actor_name: actorName,
    });
  });

  const updated = await getRefundRequestById(db, requestId);
  await notifyTelegramAfterDecision(updated, managerUser, "rejected", decisionSource);
  return { request: updated };
}
