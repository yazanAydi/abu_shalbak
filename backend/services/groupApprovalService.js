import { createHash } from "node:crypto";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { withTransaction } from "../utils/dbTx.js";
import { HttpError, badRequest } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { shopTodayYmd, shopYmdFromTimestamp } from "../utils/shopTime.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import {
  isApprovalsTelegramConfigured,
  sendExpenseApprovalMessage,
  sendSupplierPaymentApprovalMessage,
  editGroupApprovalMessage,
  logApprovalStage,
  telegramFailureLog,
} from "../utils/telegram.js";
import { enqueueOperationPrint } from "./operationPrintService.js";
import {
  fingerprintPosSupplierPayment,
  parsePosSupplierAmount,
  postLinkedSupplierPayment,
  requirePendingCountShift,
} from "./posSupplierPaymentService.js";

const PAY_METHODS = ["cash", "transfer", "check", "other"];

function fingerprintExpense({ categoryId, amount, paidOn, paymentMethod, note }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        category_id: Number(categoryId) || 0,
        amount: round2(amount),
        paid_on: paidOn,
        payment_method: paymentMethod,
        note: note || null,
      })
    )
    .digest("hex");
}

function assertIdempotencyKey(key) {
  const value = String(key || "").trim();
  if (value.length < 8 || value.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  return value;
}

async function assertApprover(db, user, permissionKey) {
  if (!user?.id) {
    throw new HttpError(403, "حساب الموافق غير صالح", "FORBIDDEN");
  }
  const permitted = await userHasAccountantPermission(db, user, permissionKey);
  if (!permitted) {
    const err = new HttpError(403, "حساب الموافق لا يملك صلاحية الموافقة", "FORBIDDEN");
    throw err;
  }
  return user;
}

export async function createExpenseApprovalRequest(db, input) {
  const categoryId = Number(input.categoryId);
  const cat = await db.get("SELECT * FROM expense_categories WHERE id = ? AND active = 1", [categoryId]);
  if (!cat) throw badRequest("فئة غير صالحة", "VALIDATION_ERROR");
  if (cat.name === "salary_advance" || cat.name === "shop_consumption") {
    throw badRequest("هذه الفئة لا تُرسل لموافقة المجموعة", "VALIDATION_ERROR");
  }
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest("مبلغ غير صالح", "VALIDATION_ERROR");
  const paidOn = String(input.paidOn || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw badRequest("تاريخ غير صالح", "VALIDATION_ERROR");
  const paymentMethod = PAY_METHODS.includes(input.paymentMethod) ? input.paymentMethod : "cash";
  const note =
    input.referenceNote != null && String(input.referenceNote).trim() !== ""
      ? String(input.referenceNote).trim()
      : null;
  const key = assertIdempotencyKey(input.idempotencyKey);
  const fingerprint = fingerprintExpense({
    categoryId,
    amount,
    paidOn,
    paymentMethod,
    note,
  });

  const created = await withTransaction(db, async () => {
    const existing = await db.get(
      "SELECT * FROM expense_approval_requests WHERE idempotency_key = ?",
      [key]
    );
    if (existing) {
      if (Number(existing.requester_id) !== Number(input.requesterId)) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا المستخدم", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (existing.payload_fingerprint !== fingerprint) {
        throw new HttpError(409, "تم استخدام مفتاح التكرار مع محتوى مختلف", "IDEMPOTENCY_KEY_REUSE");
      }
      return { request: existing, replayed: true };
    }
    const expenses = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const ins = await db.run(
      `INSERT INTO expense_approval_requests
         (requester_id, category_id, category_name, amount, paid_on, payment_method, reference_note, idempotency_key, payload_fingerprint, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [input.requesterId, cat.id, cat.name, amount, paidOn, paymentMethod, note, key, fingerprint]
    );
    const request = await db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [ins.lastID]);
    if (Number(expenses.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n)) {
      throw new Error("expense request must not post an operating expense");
    }
    return { request, replayed: false };
  });

  let telegramMessageId = created.request.telegram_message_id || null;
  if (!created.replayed && isApprovalsTelegramConfigured()) {
    try {
      const requester = await db.get("SELECT username FROM users WHERE id = ?", [input.requesterId]);
      telegramMessageId = await sendExpenseApprovalMessage({
        requestId: created.request.id,
        requesterName: requester?.username || String(input.requesterId),
        categoryName: cat.name_ar || cat.name,
        amount,
        paidOn,
        paymentMethod,
        note,
      });
      await db.run("UPDATE expense_approval_requests SET telegram_message_id = ? WHERE id = ?", [
        telegramMessageId,
        created.request.id,
      ]);
      logApprovalStage("sent", { request: created.request.id, kind: "expense", message: telegramMessageId });
    } catch (e) {
      logApprovalStage("send_failed", { request: created.request.id, kind: "expense", detail: telegramFailureLog(e) });
      telegramMessageId = null;
    }
  }

  return {
    request_id: created.request.id,
    status: created.request.status,
    pending_approval: created.request.status === "pending",
    replayed: created.replayed,
    amount,
    category_name: cat.name_ar || cat.name,
    telegram: isApprovalsTelegramConfigured() && !!telegramMessageId,
    operating_expense_id: created.request.operating_expense_id || null,
  };
}

function voucherDateForShift(shift) {
  if (shift?.business_day && /^\d{4}-\d{2}-\d{2}$/.test(String(shift.business_day))) {
    return String(shift.business_day);
  }
  return shopYmdFromTimestamp(shift?.start_time) || shopTodayYmd();
}

export async function listShiftSupplierPaymentRequests(db, shiftId) {
  const rows = await db.all(
    `SELECT id AS request_id, supplier_id, supplier_name, amount, notes, status, forgotten, created_at
       FROM supplier_payment_approval_requests
      WHERE shift_id = ? AND status = 'pending'
      ORDER BY created_at ASC, id ASC`,
    [shiftId]
  );
  return rows.map((row) => ({ ...row, amount: round2(Number(row.amount) || 0) }));
}

export async function createSupplierPaymentApprovalRequest(db, input) {
  const supplierId = Number(input.supplierId);
  if (!Number.isInteger(supplierId) || supplierId <= 0) throw badRequest("مورد غير صالح", "INVALID_SUPPLIER");
  const amount = parsePosSupplierAmount(input.amount);
  const notes =
    input.notes != null && String(input.notes).trim() !== "" ? String(input.notes).trim() : null;
  const key = assertIdempotencyKey(input.idempotencyKey);
  const fingerprint = fingerprintPosSupplierPayment({ supplierId, amount, notes });
  const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
  if (!supplier) throw badRequest("مورد غير صالح", "INVALID_SUPPLIER");
  const forgotten = Boolean(input.forgotten);

  const created = await withTransaction(db, async () => {
    const existing = await db.get(
      "SELECT * FROM supplier_payment_approval_requests WHERE idempotency_key = ?",
      [key]
    );
    if (existing) {
      const ownerId = forgotten ? existing.recorded_by_id : existing.cashier_id;
      const actorId = forgotten ? input.recordedById : input.cashierId;
      if (Number(ownerId) !== Number(actorId)) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (existing.payload_fingerprint !== fingerprint) {
        throw new HttpError(409, "تم استخدام مفتاح التكرار مع محتوى مختلف", "IDEMPOTENCY_KEY_REUSE");
      }
      return { request: existing, replayed: true, supplier };
    }
    const shift = forgotten
      ? await requirePendingCountShift(db, input.shiftId)
      : await db.get(
          `SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
          [input.cashierId]
        );
    if (!shift) {
      const err = new Error("لا توجد وردية مفتوحة");
      err.status = 400;
      err.code = "NO_OPEN_SHIFT";
      throw err;
    }
    const cashierId = forgotten ? shift.cashier_id : input.cashierId;
    const recordedById = input.recordedById || input.cashierId;
    const voucherCount = await db.get("SELECT COUNT(*) AS n FROM vouchers");
    const ins = await db.run(
      `INSERT INTO supplier_payment_approval_requests
         (cashier_id, shift_id, supplier_id, supplier_name, amount, notes, idempotency_key, payload_fingerprint, status, forgotten, recorded_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [cashierId, shift.id, supplier.id, supplier.name, amount, notes, key, fingerprint, forgotten ? 1 : 0, recordedById]
    );
    const request = await db.get("SELECT * FROM supplier_payment_approval_requests WHERE id = ?", [ins.lastID]);
    if (Number(voucherCount.n) !== Number((await db.get("SELECT COUNT(*) AS n FROM vouchers")).n)) {
      throw new Error("supplier request must not post a voucher");
    }
    return { request, replayed: false, supplier };
  });

  let telegramMessageId = created.request.telegram_message_id || null;
  if (!created.replayed && isApprovalsTelegramConfigured()) {
    try {
      const cashier = await db.get("SELECT username FROM users WHERE id = ?", [created.request.cashier_id]);
      telegramMessageId = await sendSupplierPaymentApprovalMessage({
        requestId: created.request.id,
        cashierName: cashier?.username || String(created.request.cashier_id),
        supplierName: created.supplier.name,
        amount,
        shiftId: created.request.shift_id,
        notes,
        forgotten,
      });
      await db.run(
        "UPDATE supplier_payment_approval_requests SET telegram_message_id = ? WHERE id = ?",
        [telegramMessageId, created.request.id]
      );
      logApprovalStage("sent", { request: created.request.id, kind: "supplier", message: telegramMessageId });
    } catch (e) {
      logApprovalStage("send_failed", {
        request: created.request.id,
        kind: "supplier",
        detail: telegramFailureLog(e),
      });
      telegramMessageId = null;
    }
  } else if (!created.replayed) {
    logApprovalStage("send_skipped", {
      request: created.request.id,
      kind: "supplier",
      detail: "approvals bot not configured",
    });
  }

  return {
    request_id: created.request.id,
    status: created.request.status,
    pending_approval: created.request.status === "pending",
    replayed: created.replayed,
    amount,
    supplier_id: created.supplier.id,
    supplier_name: created.request.supplier_name,
    shift_id: created.request.shift_id,
    voucher_id: created.request.voucher_id || null,
    forgotten,
    telegram: isApprovalsTelegramConfigured() && !!telegramMessageId,
  };
}

async function editAfter(kind, request, status, approverName) {
  if (!request?.telegram_message_id || !isApprovalsTelegramConfigured()) return;
  try {
    await editGroupApprovalMessage({
      kind,
      messageId: request.telegram_message_id,
      requestId: request.id,
      status,
      approverName,
    });
  } catch (e) {
    console.error(`[telegram-approval] stage=edit_failed request=${request.id} kind=${kind} ${telegramFailureLog(e)}`);
  }
}

export async function approveExpenseApprovalRequest(db, requestId, managerUser, decisionSource = "admin", actor = {}) {
  if (decisionSource !== "telegram") await assertApprover(db, managerUser, "expenses");
  const updated = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [requestId]);
    if (!request) throw new HttpError(404, "الطلب غير موجود", "NOT_FOUND");
    if (request.status !== "pending") {
      const err = new HttpError(409, "تمت المعالجة مسبقاً", "ALREADY_HANDLED");
      err.action = "already_handled";
      throw err;
    }
    const ins = await db.run(
      `INSERT INTO operating_expenses (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id, source, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'expense_approval', ?)`,
      [
        request.category_name,
        request.category_id,
        request.amount,
        request.paid_on,
        request.payment_method,
        request.reference_note,
        decisionSource === "telegram" ? null : managerUser.id,
        request.id,
      ]
    );
    const info = await db.run(
      `UPDATE expense_approval_requests
         SET status = 'approved', manager_id = ?, operating_expense_id = ?, decision_source = ?,
             telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, approved_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        decisionSource === "telegram" ? null : managerUser?.id ?? null,
        ins.lastID,
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
    const requester = await db.get("SELECT username FROM users WHERE id = ?", [request.requester_id]);
    await enqueueOperationPrint(db, {
      kind: "expense_approval",
      referenceId: request.id,
      cashierId: request.requester_id,
      shiftId: null,
      documentNo: `EXP-${ins.lastID}`,
      snapshot: {
        title: "مصروف معتمد",
        documentNo: `EXP-${ins.lastID}`,
        timestamp: new Date().toISOString(),
        businessDay: request.paid_on,
        cashierName: requester?.username || "",
        partyLabel: `الفئة: ${request.category_name}`,
        lines: [`طريقة الدفع: ${request.payment_method}`],
        note: request.reference_note,
        amountLabel: `المبلغ ${Number(request.amount).toFixed(2)} شيقل`,
        footer: "اعتُمد بعد موافقة المجموعة",
        managerName: actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username || "",
      },
    });
    await logAuditUser(db, managerUser || { id: null, username: actor.telegramActor?.name || actor.telegramActor?.username || "telegram" }, AUDIT_ACTIONS.VOUCHER_POST, "expense_approval_requests", request.id, { status: "pending" }, {
      operating_expense_id: ins.lastID,
      decision_source: decisionSource,
      telegram_user_id: actor.telegramActor?.id || null,
      telegram_actor_name: actor.telegramActor?.name || null,
    });
    return db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [request.id]);
  });
  await editAfter("expense", updated, "approved", actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username);
  return updated;
}

export async function rejectExpenseApprovalRequest(db, requestId, managerUser, decisionSource = "admin", actor = {}) {
  if (decisionSource !== "telegram") await assertApprover(db, managerUser, "expenses");
  const updated = await withTransaction(db, async () => {
    const before = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    const info = await db.run(
      `UPDATE expense_approval_requests
         SET status = 'rejected', manager_id = ?, decision_source = ?,
             telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, rejected_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        decisionSource === "telegram" ? null : managerUser?.id ?? null,
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
    const after = await db.get("SELECT COUNT(*) AS n FROM operating_expenses");
    if (Number(before.n) !== Number(after.n)) throw new Error("reject must not post an expense");
    return db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [requestId]);
  });
  await editAfter("expense", updated, "rejected", actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username);
  return updated;
}

export async function approveSupplierPaymentApprovalRequest(db, requestId, managerUser, decisionSource = "admin", req = null, actor = {}) {
  if (decisionSource !== "telegram") await assertApprover(db, managerUser, "suppliers");
  const updated = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM supplier_payment_approval_requests WHERE id = ?", [requestId]);
    if (!request) throw new HttpError(404, "الطلب غير موجود", "NOT_FOUND");
    if (request.status !== "pending") {
      const err = new HttpError(409, "تمت المعالجة مسبقاً", "ALREADY_HANDLED");
      err.action = "already_handled";
      throw err;
    }
    const forgotten = Number(request.forgotten) === 1;
    const shift = forgotten
      ? await requirePendingCountShift(db, request.shift_id)
      : await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [request.shift_id]);
    if (!forgotten && (!shift || shift.status !== "open")) {
      const err = new Error("لا يمكن صرف الدفعة: الوردية لم تعد مفتوحة");
      err.status = 400;
      err.code = "NO_OPEN_SHIFT";
      throw err;
    }
    const posted = await postLinkedSupplierPayment(db, {
      shift,
      parsed: {
        actorId: request.recorded_by_id || request.cashier_id,
        supplierId: request.supplier_id,
        amount: Number(request.amount),
        notes: request.notes,
        key: `supplier-approval-${request.id}`,
        fingerprint: request.payload_fingerprint,
      },
      req,
      paidOn: forgotten ? voucherDateForShift(shift) : shopTodayYmd(),
      forgotten,
      managerName: actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username || "",
    });
    const info = await db.run(
      `UPDATE supplier_payment_approval_requests
         SET status = 'approved', manager_id = ?, voucher_id = ?, decision_source = ?,
             telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, approved_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        decisionSource === "telegram" ? null : managerUser?.id ?? null,
        posted.voucher_id,
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
    return { request: await db.get("SELECT * FROM supplier_payment_approval_requests WHERE id = ?", [request.id]), posted };
  });
  await editAfter("supplier", updated.request, "approved", actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username);
  return { ...updated.posted, request_id: updated.request.id, status: "approved", pending_approval: false };
}

export async function rejectSupplierPaymentApprovalRequest(db, requestId, managerUser, decisionSource = "admin", actor = {}) {
  if (decisionSource !== "telegram") await assertApprover(db, managerUser, "suppliers");
  const updated = await withTransaction(db, async () => {
    const before = await db.get("SELECT COUNT(*) AS n FROM vouchers");
    const info = await db.run(
      `UPDATE supplier_payment_approval_requests
         SET status = 'rejected', manager_id = ?, decision_source = ?, telegram_actor_id = ?, telegram_actor_username = ?, telegram_actor_name = ?, rejected_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [
        decisionSource === "telegram" ? null : managerUser?.id ?? null,
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
    const after = await db.get("SELECT COUNT(*) AS n FROM vouchers");
    if (Number(before.n) !== Number(after.n)) throw new Error("reject must not post a voucher");
    return db.get("SELECT * FROM supplier_payment_approval_requests WHERE id = ?", [requestId]);
  });
  await editAfter("supplier", updated, "rejected", actor.telegramActor?.name || actor.telegramActor?.username || managerUser?.username);
  return updated;
}

export async function getExpenseApprovalRequestById(db, id) {
  return db.get("SELECT * FROM expense_approval_requests WHERE id = ?", [id]);
}

const SUPPLIER_REQUEST_SELECT = `
  SELECT r.*,
         cashier.username AS cashier_username,
         manager.username AS manager_username,
         recorder.username AS recorded_by_username
    FROM supplier_payment_approval_requests r
    JOIN users cashier ON cashier.id = r.cashier_id
    LEFT JOIN users manager ON manager.id = r.manager_id
    LEFT JOIN users recorder ON recorder.id = r.recorded_by_id
`;

function decisionFields(row) {
  const fromTelegram = row.decision_source === "telegram";
  return {
    decision_source: row.decision_source || null,
    decision_actor: fromTelegram
      ? row.telegram_actor_username || (row.telegram_actor_id ? String(row.telegram_actor_id) : null)
      : row.manager_username || null,
    decision_at: row.approved_at || row.rejected_at || null,
  };
}

function queueFilter(status) {
  const value = String(status || "pending").toLowerCase();
  if (!["pending", "approved", "rejected", "all"].includes(value)) {
    throw badRequest("حالة غير صالحة", "VALIDATION_ERROR");
  }
  return value;
}

export function presentSupplierPaymentApproval(row) {
  const forgotten = Number(row.forgotten) === 1;
  return {
    id: row.id,
    request_id: row.id,
    created_at: row.created_at,
    cashier_id: row.cashier_id,
    cashier_username: row.cashier_username || null,
    shift_id: row.shift_id,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    amount: round2(Number(row.amount) || 0),
    notes: row.notes || null,
    status: row.status,
    forgotten: forgotten ? 1 : 0,
    already_paid: forgotten,
    origin: forgotten ? "shift_count" : "pos",
    origin_label: forgotten ? "عد الصندوق — دفعة سابقة" : "صندوق الكاشير",
    recorded_by_username: row.recorded_by_username || null,
    manager_id: row.manager_id || null,
    manager_username: row.manager_username || null,
    telegram_actor_id: row.telegram_actor_id || null,
    telegram_actor_username: row.telegram_actor_username || null,
    telegram_message_id: row.telegram_message_id || null,
    voucher_id: row.voucher_id || null,
    can_reprint: row.status === "approved" && row.voucher_id != null,
    ...decisionFields(row),
  };
}

export async function listUnreadSupplierPaymentDecisions(db, cashierId) {
  return db.all(
    `SELECT r.id, r.status, r.amount, r.supplier_name, r.notes, r.shift_id, r.voucher_id,
            r.created_at, r.approved_at, r.rejected_at, r.decision_source
     FROM supplier_payment_approval_requests r
     WHERE r.cashier_id = ?
       AND r.status IN ('approved', 'rejected')
       AND r.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(r.approved_at, r.rejected_at) ASC, r.id ASC`,
    [Number(cashierId)]
  );
}

export async function listSupplierPaymentApprovalRequests(db, status) {
  const filter = queueFilter(status);
  const where = filter === "all" ? "" : "WHERE r.status = ?";
  const params = filter === "all" ? [] : [filter];
  const order = filter === "pending" ? "r.created_at ASC, r.id ASC" : "r.created_at DESC, r.id DESC";
  const rows = await db.all(`${SUPPLIER_REQUEST_SELECT} ${where} ORDER BY ${order}`, params);
  return rows.map(presentSupplierPaymentApproval);
}

export async function getSupplierPaymentApprovalRequestById(db, id) {
  return db.get(`${SUPPLIER_REQUEST_SELECT} WHERE r.id = ?`, [id]);
}

export async function getPresentedSupplierPaymentApproval(db, id) {
  const row = await getSupplierPaymentApprovalRequestById(db, id);
  return row ? presentSupplierPaymentApproval(row) : null;
}
