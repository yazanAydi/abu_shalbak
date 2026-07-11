import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { getTelegramManagerUser } from "./refundRequestService.js";
import {
  isSulafTelegramConfigured,
  sendAdvanceApprovalMessage,
  editAdvanceRequestMessage,
  sendAdvanceDecisionStatusMessage,
} from "../utils/telegram.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export { getTelegramManagerUser };

async function computeShiftExpectedCash(db, shiftId, openingCash) {
  const sid = Number(shiftId);
  const open = round2(Number(openingCash) || 0);
  const cashSalesRow = await db.get(
    `SELECT COALESCE(SUM(sp.nis_equivalent), 0) AS s
     FROM sale_payments sp
     JOIN transactions t ON t.id = sp.transaction_id
     WHERE t.shift_id = ? AND sp.payment_method = 'cash'`,
    [sid]
  );
  const cashRefundsRow = await db.get(
    `SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE shift_id = ? AND payment_method = 'cash' AND status = 'approved'`,
    [sid]
  );
  const adjRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'adjustment'`,
    [sid]
  );
  const advanceRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'advance'`,
    [sid]
  );
  return round2(
    open +
      round2(Number(cashSalesRow?.s) || 0) -
      round2(Number(cashRefundsRow?.s) || 0) +
      round2(Number(adjRow?.s) || 0) +
      round2(Number(advanceRow?.s) || 0)
  );
}

export async function createAdvanceRequest(db, params) {
  const { cashierId, employeeName, amount, notes, req } = params;
  const trimmedName = String(employeeName || "").trim();
  const amt = round2(Number(amount));
  if (!trimmedName) {
    const err = new Error("اسم الموظف مطلوب");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error("المبلغ يجب أن يكون أكبر من صفر");
    err.status = 400;
    throw err;
  }

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    const err = new Error(shiftErr || "لا توجد وردية مفتوحة");
    err.status = 400;
    throw err;
  }

  await db.run("BEGIN IMMEDIATE");
  try {
    const ins = await db.run(
      `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, notes, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [cashierId, shift.id, trimmedName, amt, notes != null ? String(notes).trim() || null : null]
    );
    const requestId = ins.lastID;
    const row = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [cashierId]);

    if (req?.user) {
      await logAuditUser(db, req.user, AUDIT_ACTIONS.ADVANCE_REQUEST_CREATE, "advance_requests", requestId, null, {
        employee_name: trimmedName,
        amount: amt,
      });
    }

    let telegramMessageId = null;
    if (isSulafTelegramConfigured()) {
      try {
        telegramMessageId = await sendAdvanceApprovalMessage({
          requestId,
          cashierName: cashier?.username || String(cashierId),
          employeeName: trimmedName,
          amount: amt,
          notes: notes || "",
        });
        await db.run("UPDATE advance_requests SET telegram_message_id = ? WHERE id = ?", [
          telegramMessageId,
          requestId,
        ]);
        row.telegram_message_id = telegramMessageId;
      } catch (e) {
        console.error("Telegram sulaf send failed:", e.message);
      }
    }

    await db.run("COMMIT");
    return {
      request: row,
      request_id: requestId,
      telegram: isSulafTelegramConfigured() && !!telegramMessageId,
      message: "سُجّل طلب السلف قيد المراجعة. لن يُصرف النقد حتى موافقة المسؤول.",
    };
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

export async function getAdvanceRequestById(db, id) {
  return db.get(
    `SELECT ar.*, u.username AS cashier_username, m.username AS manager_username
     FROM advance_requests ar
     JOIN users u ON u.id = ar.cashier_id
     LEFT JOIN users m ON m.id = ar.manager_id
     WHERE ar.id = ?`,
    [id]
  );
}

export async function listPendingAdvanceRequests(db) {
  return db.all(
    `SELECT ar.*, u.username AS cashier_username
     FROM advance_requests ar
     JOIN users u ON u.id = ar.cashier_id
     WHERE ar.status = 'pending'
     ORDER BY ar.created_at ASC, ar.id ASC`
  );
}

export async function listAdvanceRequestHistory(db, status = "all", limit = 200) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  let sql = `SELECT ar.*, u.username AS cashier_username, m.username AS manager_username
             FROM advance_requests ar
             JOIN users u ON u.id = ar.cashier_id
             LEFT JOIN users m ON m.id = ar.manager_id
             WHERE ar.status != 'pending'`;
  const params = [];
  if (status === "approved" || status === "rejected") {
    sql += " AND ar.status = ?";
    params.push(status);
  }
  sql += " ORDER BY COALESCE(ar.approved_at, ar.rejected_at, ar.created_at) DESC, ar.id DESC LIMIT ?";
  params.push(lim);
  return db.all(sql, params);
}

export async function listMyAdvanceRequests(db, cashierId, limit = 100) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.all(
    `SELECT ar.*, m.username AS manager_username
     FROM advance_requests ar
     LEFT JOIN users m ON m.id = ar.manager_id
     WHERE ar.cashier_id = ?
     ORDER BY ar.created_at DESC, ar.id DESC
     LIMIT ?`,
    [Number(cashierId), lim]
  );
}

export async function listUnreadAdvanceDecisions(db, cashierId) {
  return db.all(
    `SELECT ar.*, m.username AS manager_username
     FROM advance_requests ar
     LEFT JOIN users m ON m.id = ar.manager_id
     WHERE ar.cashier_id = ?
       AND ar.status IN ('approved', 'rejected')
       AND ar.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(ar.approved_at, ar.rejected_at) ASC, ar.id ASC`,
    [Number(cashierId)]
  );
}

export async function acknowledgeAdvanceDecision(db, requestId, cashierId) {
  const row = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
  if (!row) {
    const err = new Error("طلب السلف غير موجود");
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
    `UPDATE advance_requests SET
       cashier_acknowledged_at = ?,
       cashier_notified_at = COALESCE(cashier_notified_at, ?)
     WHERE id = ?`,
    [now, now, requestId]
  );
  return getAdvanceRequestById(db, requestId);
}

async function notifyTelegramAfterDecision(request, managerUser, status, decisionSource) {
  if (!isSulafTelegramConfigured()) return;
  const payload = {
    requestId: request.id,
    status,
    employeeName: request.employee_name,
    amount: request.amount,
    approverName: managerUser?.username || null,
    decisionSource,
  };
  if (request.telegram_message_id) {
    try {
      await editAdvanceRequestMessage({
        messageId: request.telegram_message_id,
        ...payload,
      });
    } catch (e) {
      console.error("Telegram sulaf edit failed:", e.message);
    }
  }
  if (decisionSource === "admin") {
    try {
      await sendAdvanceDecisionStatusMessage(payload);
    } catch (e) {
      console.error("Telegram sulaf status failed:", e.message);
    }
  }
}

export async function approveAdvanceRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin"
) {
  await db.run("BEGIN IMMEDIATE");
  try {
    const request = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب السلف غير موجود");
      err.status = 404;
      throw err;
    }
    if (request.status !== "pending") {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [request.shift_id]);
    if (!shift || shift.status !== "open") {
      const err = new Error("لا توجد وردية مفتوحة لصرف السلف");
      err.status = 400;
      err.code = "NO_OPEN_SHIFT";
      throw err;
    }

    const expectedCash = await computeShiftExpectedCash(db, shift.id, shift.opening_cash);
    const amount = round2(Number(request.amount));
    if (expectedCash < amount) {
      const err = new Error(`النقد في الدرج غير كافٍ (المتاح: ₪${expectedCash.toFixed(2)})`);
      err.status = 400;
      err.code = "INSUFFICIENT_CASH";
      throw err;
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, advance_request_id)
       VALUES (?, 'advance', ?, ?, ?)`,
      [shift.id, -amount, `سلف — ${request.employee_name} #${requestId}`, requestId]
    );

    await db.run(
      `UPDATE advance_requests SET
        status = 'approved', manager_id = ?, approved_at = ?,
        review_notes = COALESCE(?, review_notes), rejected_at = NULL,
        decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ADVANCE_REQUEST_APPROVE, "advance_requests", requestId, { status: "pending" }, {
      manager_id: managerUser.id,
      amount,
    });

    await db.run("COMMIT");

    const updated = await getAdvanceRequestById(db, requestId);
    await notifyTelegramAfterDecision(updated, managerUser, "approved", decisionSource);
    return { request: updated };
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

export async function rejectAdvanceRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin"
) {
  await db.run("BEGIN IMMEDIATE");
  try {
    const request = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب السلف غير موجود");
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
      `UPDATE advance_requests SET
        status = 'rejected', manager_id = ?, rejected_at = ?,
        review_notes = COALESCE(?, review_notes), approved_at = NULL,
        decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ADVANCE_REQUEST_REJECT, "advance_requests", requestId, { status: "pending" }, {
      manager_id: managerUser.id,
    });

    await db.run("COMMIT");

    const updated = await getAdvanceRequestById(db, requestId);
    await notifyTelegramAfterDecision(updated, managerUser, "rejected", decisionSource);
    return { request: updated };
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}
