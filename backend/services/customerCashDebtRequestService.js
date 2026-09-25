import { createHash } from "node:crypto";
import { insertPostedCustomerCashDebtVoucher } from "../routes/vouchers.js";
import { withTransaction } from "../utils/dbTx.js";
import { getEmployeeLinkedToCustomer } from "../utils/employeeCustomer.js";
import { HttpError, badRequest } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { creditLimitPreview, throwCreditError, validateCustomerCredit } from "../utils/customerCredit.js";
import {
  editCashDebtRequestMessage,
  isZimmaTelegramConfigured,
  sendCashDebtApprovalMessage,
  sendCashDebtDecisionStatusMessage,
} from "../utils/telegram.js";
import { parsePosCustomerAmount } from "./posCustomerCollectionService.js";
import { enqueueOperationPrint } from "./operationPrintService.js";
import {
  lockOriginatingShift,
  rejectHandoverFields,
  updateOutstandingHandover,
} from "./originatingShiftDecision.js";

export const CUSTOMER_CASH_DEBT_MOVEMENT = "customer_cash_debt";
const SHIFT_CLOSED_MESSAGE = "أُغلقت وردية الطلب قبل الموافقة. لم يُخصم النقد ولم تُزاد الذمة.";

export function fingerprintCustomerCashDebt({ customerId, amount, notes }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        customer_id: Number(customerId) || 0,
        amount: round2(amount),
        notes: notes ? String(notes) : null,
      })
    )
    .digest("hex");
}

function httpError(status, message, code) {
  const err = new HttpError(status, message, code);
  return err;
}

export async function getCustomerCashDebtRequestById(db, id) {
  return db.get(
    `SELECT r.*, u.username AS cashier_username, m.username AS manager_username,
            s.status AS shift_status
     FROM customer_cash_debt_requests r
     JOIN users u ON u.id = r.cashier_id
     LEFT JOIN users m ON m.id = r.manager_id
     LEFT JOIN cashier_shifts s ON s.id = r.shift_id
     WHERE r.id = ?`,
    [id]
  );
}

function publicRequest(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    request_id: row.id,
    request_kind: "cash_debt",
    status: row.status,
    cashier_id: row.cashier_id,
    cashier_username: row.cashier_username || null,
    manager_id: row.manager_id,
    manager_username: row.manager_username || null,
    shift_id: row.shift_id,
    shift_status: row.shift_status ?? null,
    handover_disposition: row.handover_disposition ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    amount: round2(Number(row.amount) || 0),
    on_account_amount: round2(Number(row.amount) || 0),
    debt_before: row.debt_before == null ? null : round2(Number(row.debt_before) || 0),
    notes: row.notes,
    review_notes: row.review_notes,
    decision_source: row.decision_source,
    voucher_id: row.voucher_id,
    created_at: row.created_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    cashier_acknowledged_at: row.cashier_acknowledged_at,
    ...extra,
  };
}

async function assertOrdinaryCustomer(db, customerId) {
  const linked = await getEmployeeLinkedToCustomer(db, customerId);
  if (linked) {
    throw badRequest("هذا حساب ذمة موظف ولا يُصرف له نقد من ذمم العملاء", "EMPLOYEE_ACCOUNT");
  }
  const customer = await db.get(
    "SELECT id, name, balance, credit_limit, no_credit FROM customers WHERE id = ?",
    [customerId]
  );
  if (!customer) throw badRequest("عميل غير صالح", "INVALID_CUSTOMER");
  if (Number(customer.no_credit) === 1) {
    throw httpError(400, "هذا العميل ممنوع الدين", "CREDIT_BLOCKED");
  }
  return customer;
}

function parseCreateInput(input) {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw badRequest("عميل غير صالح", "INVALID_CUSTOMER");
  }
  const amount = parsePosCustomerAmount(input.amount);
  const notes =
    input.notes != null && String(input.notes).trim() !== "" ? String(input.notes).trim() : null;
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  return {
    cashierId: Number(input.cashierId),
    customerId,
    amount,
    notes,
    key,
    fingerprint: fingerprintCustomerCashDebt({ customerId, amount, notes }),
  };
}

async function notifyTelegram(db, row) {
  if (!isZimmaTelegramConfigured() || !row) return null;
  const preview = await creditLimitPreview(db, row.customer_id, row.amount);
  const cashier = await db.get("SELECT username FROM users WHERE id = ?", [row.cashier_id]);
  try {
    const messageId = await sendCashDebtApprovalMessage({
      requestId: row.id,
      cashierName: cashier?.username || String(row.cashier_id),
      shiftId: row.shift_id,
      customerName: row.customer_name,
      amount: row.amount,
      debtBefore: preview?.current_balance ?? row.debt_before,
      projectedDebt: preview?.projected_balance,
      notes: row.notes,
    });
    await db.run("UPDATE customer_cash_debt_requests SET telegram_message_id = ? WHERE id = ?", [
      messageId,
      row.id,
    ]);
    return messageId;
  } catch (e) {
    console.error("Telegram cash debt send failed:", e.message);
    return null;
  }
}

export async function createCustomerCashDebtRequest(db, input) {
  const parsed = parseCreateInput(input);
  const created = await withTransaction(db, async () => {
    const existing = await db.get(
      "SELECT * FROM customer_cash_debt_requests WHERE idempotency_key = ?",
      [parsed.key]
    );
    if (existing) {
      if (Number(existing.cashier_id) !== parsed.cashierId) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (existing.payload_fingerprint && existing.payload_fingerprint !== parsed.fingerprint) {
        throw new HttpError(
          409,
          "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
          "IDEMPOTENCY_KEY_REUSE"
        );
      }
      return { row: existing, replayed: true };
    }

    const locked = await db.run(
      `UPDATE cashier_shifts SET status = status WHERE cashier_id = ? AND status = 'open'`,
      [parsed.cashierId]
    );
    const shift = await db.get(
      `SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
      [parsed.cashierId]
    );
    if (!shift || !locked.changes) {
      throw httpError(400, "لا توجد وردية مفتوحة", "NO_OPEN_SHIFT");
    }

    const customer = await assertOrdinaryCustomer(db, parsed.customerId);
    const debtBefore = round2(Number(customer.balance) || 0);
    const ins = await db.run(
      `INSERT INTO customer_cash_debt_requests (
         cashier_id, shift_id, customer_id, customer_name, amount, debt_before, notes, status,
         idempotency_key, payload_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        parsed.cashierId,
        shift.id,
        customer.id,
        customer.name,
        parsed.amount,
        debtBefore,
        parsed.notes,
        parsed.key,
        parsed.fingerprint,
      ]
    );
    if (input.req?.user) {
      await logAuditUser(
        db,
        input.req.user,
        AUDIT_ACTIONS.CUSTOMER_CASH_DEBT_REQUEST_CREATE,
        "customer_cash_debt_requests",
        ins.lastID,
        null,
        { customer_id: customer.id, amount: parsed.amount, shift_id: shift.id }
      );
    }
    const row = await getCustomerCashDebtRequestById(db, ins.lastID);
    return { row, replayed: false };
  });

  if (!created.replayed) await notifyTelegram(db, created.row);
  const fresh = await getCustomerCashDebtRequestById(db, created.row.id);
  return {
    ...publicRequest(fresh),
    replayed: created.replayed,
    pending_approval: fresh.status === "pending",
    message: "سُجّل طلب صرف النقد على الذمة. لا تسلّم المبلغ قبل الموافقة.",
  };
}

async function lockOpenRequestShift(db, request) {
  const locked = await db.run(
    `UPDATE cashier_shifts SET status = status WHERE id = ? AND cashier_id = ? AND status = 'open'`,
    [request.shift_id, request.cashier_id]
  );
  if (!locked.changes) {
    throw httpError(400, SHIFT_CLOSED_MESSAGE, "SHIFT_CLOSED");
  }
}

export async function approveCustomerCashDebtRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin",
  options = {}
) {
  const updated = await withTransaction(db, async () => {
    const request = await getCustomerCashDebtRequestById(db, requestId);
    if (!request) throw httpError(404, "طلب الذمة النقدية غير موجود", "NOT_FOUND");
    if (request.status === "approved") {
      return { row: request, replayed: true };
    }
    const claimed = await db.run(
      `UPDATE customer_cash_debt_requests SET status = status WHERE id = ? AND status = 'pending'`,
      [requestId]
    );
    if (!claimed.changes) {
      const current = await getCustomerCashDebtRequestById(db, requestId);
      if (current?.status === "approved") return { row: current, replayed: true };
      throw httpError(400, "الطلب ليس قيد المراجعة", "NOT_PENDING");
    }

    const locked = await lockOriginatingShift(db, request.shift_id);
    if (locked.mode === "open") await lockOpenRequestShift(db, request);
    await assertOrdinaryCustomer(db, request.customer_id);
    const overrideCreditLimit = options?.overrideCreditLimit === true && decisionSource !== "telegram";
    const creditErr = await validateCustomerCredit(db, request.customer_id, request.amount, {
      allowOverLimit: overrideCreditLimit,
    });
    if (creditErr) throwCreditError(creditErr);

    const amount = round2(Number(request.amount));
    const note = request.notes
      ? `ذمة نقدية — ${request.customer_name} #${requestId} — ${request.notes}`
      : `ذمة نقدية — ${request.customer_name} #${requestId}`;
    const voucher = await insertPostedCustomerCashDebtVoucher(db, {
      customerId: request.customer_id,
      amount,
      paidOn: locked.mode === "pending_count" ? locked.shift.business_day || shopTodayYmd() : shopTodayYmd(),
      note,
      userId: decisionSource === "telegram" ? null : managerUser?.id ?? null,
      shiftId: request.shift_id,
      idempotencyKey: `cash-debt-request-${requestId}`,
      payloadFingerprint: request.payload_fingerprint,
    });
    await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, voucher_id)
       VALUES (?, 'customer_cash_debt', ?, ?, ?)`,
      [request.shift_id, -amount, note, voucher.id]
    );
    if (managerUser?.failAfterPost) {
      const err = new Error("forced");
      err.code = "FORCED_ROLLBACK";
      throw err;
    }
    const now = new Date().toISOString();
    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const decided = await db.run(
      `UPDATE customer_cash_debt_requests SET
         status = 'approved', manager_id = ?, approved_at = ?, voucher_id = ?,
         review_notes = COALESCE(?, review_notes), decision_source = ?, rejected_at = NULL,
         telegram_actor_id = ?, telegram_actor_name = ?
       WHERE id = ? AND status = 'pending'`,
      [managerId, now, voucher.id, reviewNotes || null, decisionSource, actorId, actorName, requestId]
    );
    if (!decided.changes) throw httpError(400, "الطلب ليس قيد المراجعة", "NOT_PENDING");
    const auditUser = req?.user || managerUser;
    await logAuditUser(
      db,
      auditUser,
      AUDIT_ACTIONS.CUSTOMER_CASH_DEBT_REQUEST_APPROVE,
      "customer_cash_debt_requests",
      requestId,
      { status: "pending" },
      {
        manager_id: decisionSource === "telegram" ? null : managerUser?.id ?? null,
        telegram_user_id: decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null,
        telegram_actor_name: decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null,
        customer_id: request.customer_id,
        amount,
        voucher_id: voucher.id,
        shift_id: request.shift_id,
        decision_source: decisionSource,
      }
    );
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [request.cashier_id]);
    const shift = await db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [request.shift_id]);
    await enqueueOperationPrint(db, {
      kind: "cash_debt",
      referenceId: requestId,
      cashierId: request.cashier_id,
      shiftId: request.shift_id,
      documentNo: String(voucher.voucher_no || voucher.id),
      snapshot: {
        title: "صرف نقدي على ذمة العميل",
        documentNo: String(voucher.voucher_no || voucher.id),
        timestamp: now,
        businessDay: shift?.business_day || voucher.voucher_date,
        cashierName: cashier?.username || "",
        shiftId: request.shift_id,
        partyLabel: `العميل: ${request.customer_name || ""}`,
        lines: ["صرف نقدي على ذمة العميل", "هذا الصرف يزيد ذمة العميل. ليس تحصيلاً ولا سداداً."],
        note: request.notes || null,
        amountLabel: `المبلغ المسلّم ${amount.toFixed(2)} شيقل`,
        footer: "يزيد الذمة — ليس تحصيلاً",
        managerName: managerUser.username || "",
        requestRef: `#${requestId}`,
      },
    });
    return { row: await getCustomerCashDebtRequestById(db, requestId), replayed: false };
  });

  if (!updated.replayed) {
    await notifyDecision(updated.row, managerUser, "approved", decisionSource);
  }
  return { request: publicRequest(updated.row), replayed: updated.replayed };
}

export async function rejectCustomerCashDebtRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin",
  options = {}
) {
  const updated = await withTransaction(db, async () => {
    const request = await getCustomerCashDebtRequestById(db, requestId);
    if (!request) throw httpError(404, "طلب الذمة النقدية غير موجود", "NOT_FOUND");
    if (request.status === "rejected") return { row: request, replayed: true };
    const claimed = await db.run(
      `UPDATE customer_cash_debt_requests SET status = status WHERE id = ? AND status = 'pending'`,
      [requestId]
    );
    if (!claimed.changes) {
      throw httpError(400, "الطلب ليس قيد المراجعة", "NOT_PENDING");
    }
    const locked = await lockOriginatingShift(db, request.shift_id);
    const now = new Date().toISOString();
    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const handover = rejectHandoverFields(locked.mode, options?.handoverDisposition, managerId);
    const decided = await db.run(
      `UPDATE customer_cash_debt_requests SET
         status = 'rejected', manager_id = ?, rejected_at = ?,
         review_notes = COALESCE(?, review_notes), decision_source = ?, approved_at = NULL,
         telegram_actor_id = ?, telegram_actor_name = ?,
         handover_disposition = ?, handover_recorded_at = ?, handover_recorded_by = ?
       WHERE id = ? AND status = 'pending'`,
      [
        managerId,
        now,
        reviewNotes || null,
        decisionSource,
        actorId,
        actorName,
        handover.disposition,
        handover.recordedAt,
        handover.recordedBy,
        requestId,
      ]
    );
    if (!decided.changes) throw httpError(400, "الطلب ليس قيد المراجعة", "NOT_PENDING");
    const auditUser = req?.user || managerUser;
    await logAuditUser(
      db,
      auditUser,
      AUDIT_ACTIONS.CUSTOMER_CASH_DEBT_REQUEST_REJECT,
      "customer_cash_debt_requests",
      requestId,
      { status: "pending" },
      {
        manager_id: managerId,
        telegram_user_id: actorId,
        telegram_actor_name: actorName,
        decision_source: decisionSource,
      }
    );
    return { row: await getCustomerCashDebtRequestById(db, requestId), replayed: false };
  });
  if (!updated.replayed) {
    await notifyDecision(updated.row, managerUser, "rejected", decisionSource);
  }
  return { request: publicRequest(updated.row), replayed: updated.replayed };
}

async function notifyDecision(row, managerUser, status, decisionSource) {
  if (!row) return;
  const payload = {
    requestId: row.id,
    status,
    customerName: row.customer_name,
    amount: row.amount,
    approverName: managerUser?.username || null,
    decisionSource,
    notes: row.notes,
  };
  if (row.telegram_message_id) {
    try {
      await editCashDebtRequestMessage({ messageId: row.telegram_message_id, ...payload });
    } catch (e) {
      console.error("Telegram cash debt edit failed:", e.message);
    }
  }
  if (decisionSource === "admin") {
    try {
      await sendCashDebtDecisionStatusMessage(payload);
    } catch (e) {
      console.error("Telegram cash debt status failed:", e.message);
    }
  }
}

export async function recordCustomerCashDebtHandover(db, requestId, userId, disposition) {
  return updateOutstandingHandover(db, "customer_cash_debt_requests", requestId, userId, disposition);
}

export async function listPendingCustomerCashDebtRequests(db) {
  const rows = await db.all(
    `SELECT r.*, u.username AS cashier_username, s.status AS shift_status
     FROM customer_cash_debt_requests r
     JOIN users u ON u.id = r.cashier_id
     LEFT JOIN cashier_shifts s ON s.id = r.shift_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at ASC, r.id ASC`
  );
  return rows.map((row) => publicRequest(row));
}

export async function listCustomerCashDebtRequestHistory(db, status = "all") {
  const params = [];
  let sql = `SELECT r.*, u.username AS cashier_username, m.username AS manager_username
     FROM customer_cash_debt_requests r
     JOIN users u ON u.id = r.cashier_id
     LEFT JOIN users m ON m.id = r.manager_id`;
  if (status && status !== "all") {
    sql += " WHERE r.status = ?";
    params.push(status);
  }
  sql += " ORDER BY r.created_at DESC, r.id DESC LIMIT 200";
  const rows = await db.all(sql, params);
  return rows.map((row) => publicRequest(row));
}

export async function listUnreadCustomerCashDebtDecisions(db, cashierId) {
  const rows = await db.all(
    `SELECT r.*, m.username AS manager_username
     FROM customer_cash_debt_requests r
     LEFT JOIN users m ON m.id = r.manager_id
     WHERE r.cashier_id = ?
       AND r.status IN ('approved', 'rejected')
       AND r.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(r.approved_at, r.rejected_at) ASC, r.id ASC`,
    [Number(cashierId)]
  );
  return rows.map((row) => publicRequest(row));
}

export async function acknowledgeCustomerCashDebtDecision(db, requestId, cashierId) {
  const row = await db.get("SELECT * FROM customer_cash_debt_requests WHERE id = ?", [requestId]);
  if (!row) throw httpError(404, "طلب الذمة النقدية غير موجود", "NOT_FOUND");
  if (Number(row.cashier_id) !== Number(cashierId)) throw httpError(403, "ممنوع", "FORBIDDEN");
  if (row.status !== "approved" && row.status !== "rejected") {
    throw httpError(400, "الطلب ما زال قيد المراجعة", "NOT_TERMINAL");
  }
  await db.run(
    "UPDATE customer_cash_debt_requests SET cashier_acknowledged_at = datetime('now') WHERE id = ?",
    [requestId]
  );
  return publicRequest(await getCustomerCashDebtRequestById(db, requestId));
}

export async function listShiftCustomerCashDebts(db, shiftId) {
  const rows = await db.all(
    `SELECT r.id AS request_id, r.customer_id, r.customer_name, r.amount, r.notes,
            r.approved_at, r.manager_id, r.voucher_id, v.voucher_no,
            m.id AS movement_id, u.username AS cashier_name, mu.username AS manager_username
     FROM customer_cash_debt_requests r
     LEFT JOIN vouchers v ON v.id = r.voucher_id
     LEFT JOIN shift_cash_movements m ON m.voucher_id = r.voucher_id AND m.movement_type = 'customer_cash_debt'
     LEFT JOIN users u ON u.id = r.cashier_id
     LEFT JOIN users mu ON mu.id = r.manager_id
     WHERE r.shift_id = ? AND r.status = 'approved'
     ORDER BY r.approved_at ASC, r.id ASC`,
    [shiftId]
  );
  const total = round2(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  return { rows, total };
}

export async function buildCustomerCashDebtStatusPayload(db, row) {
  const credit = row?.status === "pending"
    ? await creditLimitPreview(db, row.customer_id, row.amount)
    : null;
  return { ...publicRequest(row), credit };
}
