import { parseItemsJson } from "../utils/cogs.js";
import { requireOpenShiftForCashier, getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals } from "../utils/tax.js";
import { round2 } from "../utils/money.js";
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

function refundedUnitPrice(orig, tx, origItems) {
  const qty = Number(orig.quantity) || 0;
  if (qty <= 0) return orig.price;
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

/** Sum returned quantities per product from requests + legacy refunds */
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
  const requestRows = await db.all(
    `SELECT id, transaction_id, items_json FROM refund_requests
     WHERE transaction_id IN (${ph}) AND status IN ('pending', 'approved')`,
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
      await recordMovement(db, {
        productId: pid,
        movementType: "refund",
        quantity: q * conversion,
        refType: "refund",
        refId: refund.id,
        notes: `استرجاع #${refund.id}`,
        userId: refund.approved_by_id || null,
        applyStock: true,
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

async function buildRefundLines(db, transactionId, lines, excludeRequestId = null) {
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
  const origMap = new Map();
  for (const it of origItems || []) {
    const pid = Number(it.product_id);
    if (!pid) continue;
    const key = lineKey(it);
    origMap.set(key, {
      ...it,
      quantity: Number(it.quantity) || 0,
      price: round2(Number(it.price) || 0),
      conversion_to_base: Math.max(0.0001, Number(it.conversion_to_base) || 1),
    });
  }
  const refundedSoFar = await refundedQtyByProduct(db, transactionId, excludeRequestId);
  const refundLines = [];
  for (const L of lines) {
    const pid = Number(L.product_id);
    const unitId = Number(L.unit_id ?? L.product_unit_id ?? 0);
    const want = Math.max(0, Number(L.quantity) || 0);
    if (!pid || want <= 0) {
      const err = new Error("سطر إرجاع غير صالح");
      err.status = 400;
      throw err;
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
      refundLines.push({
        product_id: pid,
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
    refundLines.push({
      product_id: pid,
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
  const { subtotal, tax, total } = computeSaleTotals(taxLines, settings);
  return {
    tx,
    refundLines,
    subtotal,
    tax,
    total,
    itemsJson: JSON.stringify(
      refundLines.map((x) => ({
        product_id: x.product_id,
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
  if (uid) {
    const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [uid]);
    if (user) return user;
  }
  return db.get("SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
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

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    const err = new Error(shiftErr || "لا توجد وردية مفتوحة");
    err.status = 400;
    throw err;
  }

  const payments = await loadSalePayments(db, transactionId);
  assertRefundPaymentMethod(payments, paymentMethod);

  const created = await withTransaction(db, async () => {
    const { subtotal, tax, total, itemsJson } = await buildRefundLines(db, transactionId, lines);
    const ins = await db.run(
      `INSERT INTO refund_requests (
        transaction_id, cashier_id, shift_id, items_json, subtotal, tax, total_amount,
        payment_method, reason, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        transactionId,
        cashierId,
        shift.id,
        itemsJson,
        subtotal,
        tax,
        total,
        paymentMethod,
        reason != null ? String(reason) : null,
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

export async function getRefundRequestById(db, id) {
  return db.get(
    `SELECT rr.*, u.username AS cashier_username, m.username AS manager_username
     FROM refund_requests rr
     JOIN users u ON u.id = rr.cashier_id
     LEFT JOIN users m ON m.id = rr.manager_id
     WHERE rr.id = ?`,
    [id]
  );
}

export async function listPendingRefundRequests(db) {
  return db.all(
    `SELECT rr.*, u.username AS cashier_username
     FROM refund_requests rr
     JOIN users u ON u.id = rr.cashier_id
     WHERE rr.status = 'pending'
     ORDER BY rr.created_at ASC, rr.id ASC`
  );
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

    const targetShiftId = await resolveRefundTargetShift(db, {
      cashierId: request.cashier_id,
      paymentMethod: request.payment_method,
      fallbackShiftId: request.shift_id,
    });

    const now = new Date().toISOString();
    const origTx = await db.get(
      "SELECT customer_id FROM transactions WHERE id = ?",
      [request.transaction_id]
    );
    const ins = await db.run(
      `INSERT INTO refunds (
        original_transaction_id, items_json, subtotal, tax, total, payment_method,
        reason, cashier_id, shift_id, status, approved_at, approved_by_id, review_notes, customer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
      [
        request.transaction_id,
        request.items_json,
        request.subtotal,
        request.tax,
        request.total_amount,
        request.payment_method,
        request.reason,
        request.cashier_id,
        targetShiftId,
        now,
        managerUser.id,
        reviewNotes ?? request.review_notes,
        origTx?.customer_id ?? null,
      ]
    );
    const refundId = ins.lastID;
    const refund = await db.get("SELECT * FROM refunds WHERE id = ?", [refundId]);
    await applyApprovedRefundEffects(db, refund);

    await db.run(
      `UPDATE refund_requests SET
        status = 'approved', manager_id = ?, approved_at = ?, refund_id = ?,
        review_notes = COALESCE(?, review_notes), rejected_at = NULL,
        decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, refundId, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.REFUND_REQUEST_APPROVE, "refund_requests", requestId, { status: "pending" }, {
      refund_id: refundId,
      manager_id: managerUser.id,
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
  decisionSource = "admin"
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

    const now = new Date().toISOString();
    await db.run(
      `UPDATE refund_requests SET
        status = 'rejected', manager_id = ?, rejected_at = ?,
        review_notes = COALESCE(?, review_notes), approved_at = NULL, refund_id = NULL,
        decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.REFUND_REQUEST_REJECT, "refund_requests", requestId, { status: "pending" }, {
      manager_id: managerUser.id,
    });
  });

  const updated = await getRefundRequestById(db, requestId);
  await notifyTelegramAfterDecision(updated, managerUser, "rejected", decisionSource);
  return { request: updated };
}
