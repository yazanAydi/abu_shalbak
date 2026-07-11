import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { buildReceiptPayload } from "../utils/receipt.js";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { executeCheckoutSale } from "./checkoutSaleService.js";
import { getTelegramManagerUser } from "./refundRequestService.js";
import { withTransaction } from "../utils/dbTx.js";
import {
  isZimmaTelegramConfigured,
  sendOnAccountApprovalMessage,
  editOnAccountRequestMessage,
  sendOnAccountDecisionStatusMessage,
} from "../utils/telegram.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export { getTelegramManagerUser };

export async function createOnAccountRequest(db, params) {
  const { cashierId, shiftId, custId, saleSnapshot, totals, req } = params;

  await db.run("BEGIN IMMEDIATE");
  try {
    const ins = await db.run(
      `INSERT INTO on_account_requests (
        cashier_id, shift_id, customer_id, sale_snapshot_json,
        subtotal, tax, total_amount, on_account_amount, payment_method, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        cashierId,
        shiftId,
        custId,
        JSON.stringify(saleSnapshot),
        totals.subtotal,
        totals.tax,
        totals.total,
        totals.onAccountTotal,
        totals.summaryMethod,
      ]
    );
    const requestId = ins.lastID;
    const row = await db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [cashierId]);
    const customer = await db.get("SELECT name FROM customers WHERE id = ?", [custId]);

    if (req?.user) {
      await logAuditUser(db, req.user, AUDIT_ACTIONS.ON_ACCOUNT_REQUEST_CREATE, "on_account_requests", requestId, null, {
        customer_id: custId,
        on_account_amount: totals.onAccountTotal,
        total: totals.total,
      });
    }

    let telegramMessageId = null;
    if (isZimmaTelegramConfigured()) {
      try {
        telegramMessageId = await sendOnAccountApprovalMessage({
          requestId,
          cashierName: cashier?.username || String(cashierId),
          customerName: customer?.name || String(custId),
          onAccountAmount: totals.onAccountTotal,
          total: totals.total,
        });
        await db.run("UPDATE on_account_requests SET telegram_message_id = ? WHERE id = ?", [
          telegramMessageId,
          requestId,
        ]);
        row.telegram_message_id = telegramMessageId;
      } catch (e) {
        console.error("Telegram zimma send failed:", e.message);
      }
    }

    await db.run("COMMIT");
    return {
      request: row,
      request_id: requestId,
      pending_approval: true,
      telegram: isZimmaTelegramConfigured() && !!telegramMessageId,
      message: "سُجّل طلب البيع على الذمة قيد المراجعة. لن يُكمَل البيع حتى موافقة المسؤول.",
    };
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}

export async function getOnAccountRequestById(db, id) {
  return db.get(
    `SELECT oar.*, u.username AS cashier_username, m.username AS manager_username, c.name AS customer_name
     FROM on_account_requests oar
     JOIN users u ON u.id = oar.cashier_id
     LEFT JOIN users m ON m.id = oar.manager_id
     JOIN customers c ON c.id = oar.customer_id
     WHERE oar.id = ?`,
    [id]
  );
}

export async function listPendingOnAccountRequests(db) {
  return db.all(
    `SELECT oar.*, u.username AS cashier_username, c.name AS customer_name
     FROM on_account_requests oar
     JOIN users u ON u.id = oar.cashier_id
     JOIN customers c ON c.id = oar.customer_id
     WHERE oar.status = 'pending'
     ORDER BY oar.created_at ASC, oar.id ASC`
  );
}

export async function listOnAccountRequestHistory(db, status = "all", limit = 200) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  let sql = `SELECT oar.*, u.username AS cashier_username, m.username AS manager_username, c.name AS customer_name
             FROM on_account_requests oar
             JOIN users u ON u.id = oar.cashier_id
     LEFT JOIN users m ON m.id = oar.manager_id
     JOIN customers c ON c.id = oar.customer_id
     WHERE oar.status != 'pending'`;
  const params = [];
  if (status === "approved" || status === "rejected") {
    sql += " AND oar.status = ?";
    params.push(status);
  }
  sql += " ORDER BY COALESCE(oar.approved_at, oar.rejected_at, oar.created_at) DESC, oar.id DESC LIMIT ?";
  params.push(lim);
  return db.all(sql, params);
}

export async function listMyOnAccountRequests(db, cashierId, limit = 100) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.all(
    `SELECT oar.*, m.username AS manager_username, c.name AS customer_name
     FROM on_account_requests oar
     LEFT JOIN users m ON m.id = oar.manager_id
     JOIN customers c ON c.id = oar.customer_id
     WHERE oar.cashier_id = ?
     ORDER BY oar.created_at DESC, oar.id DESC
     LIMIT ?`,
    [Number(cashierId), lim]
  );
}

export async function listUnreadOnAccountDecisions(db, cashierId) {
  return db.all(
    `SELECT oar.*, m.username AS manager_username, c.name AS customer_name
     FROM on_account_requests oar
     LEFT JOIN users m ON m.id = oar.manager_id
     JOIN customers c ON c.id = oar.customer_id
     WHERE oar.cashier_id = ?
       AND oar.status IN ('approved', 'rejected')
       AND oar.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(oar.approved_at, oar.rejected_at) ASC, oar.id ASC`,
    [Number(cashierId)]
  );
}

export async function acknowledgeOnAccountDecision(db, requestId, cashierId) {
  const row = await db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
  if (!row) {
    const err = new Error("طلب الذمة غير موجود");
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
    `UPDATE on_account_requests SET
       cashier_acknowledged_at = ?,
       cashier_notified_at = COALESCE(cashier_notified_at, ?)
     WHERE id = ?`,
    [now, now, requestId]
  );
  return getOnAccountRequestById(db, requestId);
}

async function notifyTelegramAfterDecision(request, managerUser, status, decisionSource) {
  if (!isZimmaTelegramConfigured()) return;
  const payload = {
    requestId: request.id,
    status,
    customerName: request.customer_name,
    onAccountAmount: request.on_account_amount,
    total: request.total_amount,
    transactionId: request.transaction_id,
    approverName: managerUser?.username || null,
    decisionSource,
  };
  if (request.telegram_message_id) {
    try {
      await editOnAccountRequestMessage({
        messageId: request.telegram_message_id,
        ...payload,
      });
    } catch (e) {
      console.error("Telegram zimma edit failed:", e.message);
    }
  }
  if (decisionSource === "admin") {
    try {
      await sendOnAccountDecisionStatusMessage(payload);
    } catch (e) {
      console.error("Telegram zimma status failed:", e.message);
    }
  }
}

export async function buildOnAccountRequestStatusPayload(db, row) {
  const payload = {
    request_id: row.id,
    status: row.status,
    total_amount: row.total_amount,
    on_account_amount: row.on_account_amount,
    customer_name: row.customer_name,
    transaction_id: row.transaction_id,
    created_at: row.created_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    review_notes: row.review_notes,
    decision_source: row.decision_source ?? null,
    cashier_notified_at: row.cashier_notified_at ?? null,
    cashier_acknowledged_at: row.cashier_acknowledged_at ?? null,
    cashier_username: row.cashier_username,
    manager_username: row.manager_username,
    checkout: null,
  };

  if (row.status === "approved" && row.transaction_id) {
    const settings = await getAppSettings(db);
    let snapshot;
    try {
      snapshot = JSON.parse(row.sale_snapshot_json);
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const txRow = await db.get("SELECT * FROM transactions WHERE id = ?", [row.transaction_id]);
      const tiRows = await db.all(
        "SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id",
        [row.transaction_id]
      );
      const cashier = await db.get("SELECT username FROM users WHERE id = ?", [txRow.cashier_id]);
      const receiptLines = tiRows.map((t) => ({
        name: t.unit_name ? `${t.name} (${t.unit_name})` : t.name,
        quantity: t.quantity,
        price: t.unit_price,
        lineTotal: t.line_gross,
        weighed: t.unit_name === "كغم",
      }));
      const { receipt_text, receipt_html } = buildReceiptPayload({
        transactionId: row.transaction_id,
        receiptNumber: txRow.receipt_number,
        timestamp: txRow.created_at,
        cashierName: cashier?.username || "",
        lines: receiptLines,
        subtotal: txRow.subtotal,
        tax: txRow.tax,
        total: txRow.total,
        paymentMethod: txRow.payment_method,
        payments: snapshot.paymentLines,
        cashTendered: snapshot.cashTendered,
        changeNis: snapshot.changeNis,
        settings,
      });
      payload.checkout = {
        success: true,
        transaction_id: row.transaction_id,
        receipt_number: txRow.receipt_number,
        items: snapshot.itemsForJson,
        subtotal: txRow.subtotal,
        tax: txRow.tax,
        discount: txRow.discount,
        total: txRow.total,
        payment_method: txRow.payment_method,
        payments: snapshot.paymentLines,
        timestamp: txRow.created_at,
        cashier: cashier?.username || "",
        receipt_text,
        receipt_html,
      };
    }
  }

  return payload;
}

export async function approveOnAccountRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin"
) {
  const request = await db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
  if (!request) {
    const err = new Error("طلب الذمة غير موجود");
    err.status = 404;
    throw err;
  }
  if (request.status !== "pending") {
    const err = new Error("الطلب ليس قيد المراجعة");
    err.status = 400;
    err.code = "NOT_PENDING";
    throw err;
  }

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, request.cashier_id);
  if (shiftErr || !shift) {
    const err = new Error("لا توجد وردية مفتوحة للكاشير");
    err.status = 400;
    err.code = "NO_OPEN_SHIFT";
    throw err;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(request.sale_snapshot_json);
  } catch {
    const err = new Error("بيانات البيع غير صالحة");
    err.status = 500;
    throw err;
  }

  const result = await withTransaction(db, async () => {
    const saleResult = await executeCheckoutSale(
      db,
      {
        cashierId: request.cashier_id,
        shiftId: shift.id,
        custId: request.customer_id,
        itemsForJson: snapshot.itemsForJson,
        normalized: snapshot.normalized,
        detailed: snapshot.detailed,
        subtotal: snapshot.subtotal,
        tax: snapshot.tax,
        total: snapshot.total,
        discount: snapshot.discount,
        paymentLines: snapshot.paymentLines,
        summaryMethod: snapshot.summaryMethod,
        onAccountTotal: snapshot.onAccountTotal,
        cashTotal: snapshot.cashTotal,
        changeNis: snapshot.changeNis,
        idempotencyKey: snapshot.idempotencyKey,
        suspendedSaleId: snapshot.suspendedSaleId,
        promoBreakdown: snapshot.promoBreakdown || [],
      },
      { inTransaction: true }
    );

    const txId = saleResult.replayTxId || saleResult.transactionId;
    const now = new Date().toISOString();
    await db.run(
      `UPDATE on_account_requests SET
        status = 'approved', manager_id = ?, approved_at = ?, transaction_id = ?,
        review_notes = COALESCE(?, review_notes), rejected_at = NULL, decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, txId, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ON_ACCOUNT_REQUEST_APPROVE, "on_account_requests", requestId, { status: "pending" }, {
      transaction_id: txId,
      manager_id: managerUser.id,
    });

    return { txId, saleResult };
  });

  const updated = await getOnAccountRequestById(db, requestId);
  await notifyTelegramAfterDecision(updated, managerUser, "approved", decisionSource);
  const statusPayload = await buildOnAccountRequestStatusPayload(db, updated);
  return { request: updated, checkout: statusPayload.checkout };
}

export async function rejectOnAccountRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin"
) {
  await db.run("BEGIN IMMEDIATE");
  try {
    const request = await db.get("SELECT * FROM on_account_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب الذمة غير موجود");
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
      `UPDATE on_account_requests SET
        status = 'rejected', manager_id = ?, rejected_at = ?,
        review_notes = COALESCE(?, review_notes), approved_at = NULL, transaction_id = NULL,
        decision_source = ?
       WHERE id = ?`,
      [managerUser.id, now, reviewNotes, decisionSource, requestId]
    );

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ON_ACCOUNT_REQUEST_REJECT, "on_account_requests", requestId, { status: "pending" }, {
      manager_id: managerUser.id,
    });

    await db.run("COMMIT");

    const updated = await getOnAccountRequestById(db, requestId);
    await notifyTelegramAfterDecision(updated, managerUser, "rejected", decisionSource);
    return { request: updated };
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }
}
