import {
  isRefundTelegramConfigured,
  isZimmaTelegramConfigured,
  isSulafTelegramConfigured,
  isApprovalsTelegramConfigured,
  sendRefundApprovalMessage,
  sendOnAccountApprovalMessage,
  sendCashDebtApprovalMessage,
  sendAdvanceApprovalMessage,
  sendExpenseApprovalMessage,
  sendSupplierPaymentApprovalMessage,
  sendShopConsumptionApprovalMessage,
  onAccountTelegramItems,
} from "../utils/telegram.js";
import { resumeTelegramRetryScheduler, sendPendingTelegram } from "./telegramDelivery.js";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function resendRefunds(db) {
  if (!isRefundTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT rr.*, u.username AS cashier_username
     FROM refund_requests rr
     JOIN users u ON u.id = rr.cashier_id
     WHERE rr.status = 'pending' AND (rr.telegram_message_id IS NULL OR rr.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "refund_requests", row.id, () =>
        sendRefundApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          transactionId: row.transaction_id,
          total: row.total_amount,
          reason: row.reason || "",
          items: parseJson(row.items_json, []),
        })
      );
      if (stored) sent += 1;
    } catch {
      /* failure is persisted for a later retry */
    }
  }
  return sent;
}

async function resendOnAccount(db) {
  if (!isZimmaTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT oar.*, u.username AS cashier_username, c.name AS customer_name, e.name AS employee_name
     FROM on_account_requests oar
     JOIN users u ON u.id = oar.cashier_id
     LEFT JOIN customers c ON c.id = oar.customer_id
     LEFT JOIN employees e ON e.id = oar.employee_id
     WHERE oar.status = 'pending' AND (oar.telegram_message_id IS NULL OR oar.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "on_account_requests", row.id, () =>
        sendOnAccountApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          customerName: row.customer_name || null,
          employeeName: row.employee_name || null,
          onAccountAmount: row.on_account_amount,
          total: row.total_amount,
          notes: row.notes || null,
          items: onAccountTelegramItems(row.sale_snapshot_json),
        })
      );
      if (stored) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

async function resendCashDebt(db) {
  if (!isZimmaTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT r.*, u.username AS cashier_username
     FROM customer_cash_debt_requests r
     JOIN users u ON u.id = r.cashier_id
     WHERE r.status = 'pending' AND (r.telegram_message_id IS NULL OR r.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "customer_cash_debt_requests", row.id, () =>
        sendCashDebtApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          shiftId: row.shift_id,
          customerName: row.customer_name,
          amount: row.amount,
          debtBefore: row.debt_before,
          projectedDebt: null,
          notes: row.notes,
        })
      );
      if (stored) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

async function resendAdvances(db) {
  if (!isSulafTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT ar.*, u.username AS cashier_username
     FROM advance_requests ar
     JOIN users u ON u.id = ar.cashier_id
     WHERE ar.status = 'pending' AND (ar.telegram_message_id IS NULL OR ar.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "advance_requests", row.id, () =>
        sendAdvanceApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          employeeName: row.employee_name,
          amount: row.amount,
          notes: row.notes || "",
        })
      );
      if (stored) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

async function resendExpenses(db) {
  if (!isApprovalsTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT r.*, u.username AS requester_username
     FROM expense_approval_requests r
     JOIN users u ON u.id = r.requester_id
     WHERE r.status = 'pending' AND (r.telegram_message_id IS NULL OR r.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "expense_approval_requests", row.id, () =>
        sendExpenseApprovalMessage({
          requestId: row.id,
          requesterName: row.requester_username || String(row.requester_id),
          categoryName: row.category_name,
          amount: row.amount,
          paidOn: row.paid_on,
          paymentMethod: row.payment_method,
          note: row.reference_note,
        })
      );
      if (stored) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

async function resendSupplierPayments(db) {
  if (!isApprovalsTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT r.*, u.username AS cashier_username
     FROM supplier_payment_approval_requests r
     JOIN users u ON u.id = r.cashier_id
     WHERE r.status = 'pending' AND (r.telegram_message_id IS NULL OR r.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    try {
      const stored = await sendPendingTelegram(db, "supplier_payment_approval_requests", row.id, () =>
        sendSupplierPaymentApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          supplierName: row.supplier_name,
          amount: row.amount,
          shiftId: row.shift_id,
          notes: row.notes,
          forgotten: Number(row.forgotten) === 1,
        })
      );
      if (stored) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

async function resendConsumption(db) {
  if (!isApprovalsTelegramConfigured()) return 0;
  const rows = await db.all(
    `SELECT r.*, u.username AS cashier_username
     FROM shop_consumption_requests r
     JOIN users u ON u.id = r.cashier_id
     WHERE r.status = 'pending' AND (r.telegram_message_id IS NULL OR r.telegram_message_id = '')`
  );
  let sent = 0;
  for (const row of rows) {
    const stored = parseJson(row.items_json, []);
    const lines = Array.isArray(stored) ? stored : Array.isArray(stored?.lines) ? stored.lines : [];
    const storedTotal = !Array.isArray(stored) && stored?.total_cost != null ? Number(stored.total_cost) : null;
    try {
      const storedId = await sendPendingTelegram(db, "shop_consumption_requests", row.id, () =>
        sendShopConsumptionApprovalMessage({
          requestId: row.id,
          cashierName: row.cashier_username || String(row.cashier_id),
          totalCost: Number.isFinite(storedTotal)
            ? storedTotal
            : lines.reduce((sum, line) => sum + (Number(line.line_amount ?? line.line_cost) || 0), 0),
          lineCount: lines.length,
          reason: row.reason,
        })
      );
      if (storedId) sent += 1;
    } catch {
      /* persisted for retry */
    }
  }
  return sent;
}

/** Retry one saved request. Used by the timer and the manual retry route. */
export async function deliverOnePending(db, table, requestId) {
  if (table === "refund_requests") {
    const row = await db.get(
      `SELECT rr.*, u.username AS cashier_username FROM refund_requests rr JOIN users u ON u.id = rr.cashier_id WHERE rr.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendRefundApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        transactionId: row.transaction_id,
        total: row.total_amount,
        reason: row.reason || "",
        items: parseJson(row.items_json, []),
      })
    );
  }
  if (table === "on_account_requests") {
    const row = await db.get(
      `SELECT oar.*, u.username AS cashier_username, c.name AS customer_name, e.name AS employee_name
       FROM on_account_requests oar
       JOIN users u ON u.id = oar.cashier_id
       LEFT JOIN customers c ON c.id = oar.customer_id
       LEFT JOIN employees e ON e.id = oar.employee_id
       WHERE oar.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendOnAccountApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        customerName: row.customer_name || null,
        employeeName: row.employee_name || null,
        onAccountAmount: row.on_account_amount,
        total: row.total_amount,
        notes: row.notes || null,
        items: onAccountTelegramItems(row.sale_snapshot_json),
      })
    );
  }
  if (table === "customer_cash_debt_requests") {
    const row = await db.get(
      `SELECT r.*, u.username AS cashier_username FROM customer_cash_debt_requests r JOIN users u ON u.id = r.cashier_id WHERE r.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendCashDebtApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        shiftId: row.shift_id,
        customerName: row.customer_name,
        amount: row.amount,
        debtBefore: row.debt_before,
        projectedDebt: null,
        notes: row.notes,
      })
    );
  }
  if (table === "advance_requests") {
    const row = await db.get(
      `SELECT ar.*, u.username AS cashier_username FROM advance_requests ar JOIN users u ON u.id = ar.cashier_id WHERE ar.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendAdvanceApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        employeeName: row.employee_name,
        amount: row.amount,
        notes: row.notes || "",
      })
    );
  }
  if (table === "expense_approval_requests") {
    const row = await db.get(
      `SELECT r.*, u.username AS requester_username FROM expense_approval_requests r JOIN users u ON u.id = r.requester_id WHERE r.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendExpenseApprovalMessage({
        requestId: row.id,
        requesterName: row.requester_username || String(row.requester_id),
        categoryName: row.category_name,
        amount: row.amount,
        paidOn: row.paid_on,
        paymentMethod: row.payment_method,
        note: row.reference_note,
      })
    );
  }
  if (table === "supplier_payment_approval_requests") {
    const row = await db.get(
      `SELECT r.*, u.username AS cashier_username FROM supplier_payment_approval_requests r JOIN users u ON u.id = r.cashier_id WHERE r.id = ?`,
      [requestId]
    );
    if (!row) return false;
    return sendPendingTelegram(db, table, requestId, () =>
      sendSupplierPaymentApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        supplierName: row.supplier_name,
        amount: row.amount,
        shiftId: row.shift_id,
        notes: row.notes,
        forgotten: Number(row.forgotten) === 1,
      })
    );
  }
  if (table === "shop_consumption_requests") {
    const row = await db.get(
      `SELECT r.*, u.username AS cashier_username FROM shop_consumption_requests r JOIN users u ON u.id = r.cashier_id WHERE r.id = ?`,
      [requestId]
    );
    if (!row) return false;
    const stored = parseJson(row.items_json, []);
    const lines = Array.isArray(stored) ? stored : Array.isArray(stored?.lines) ? stored.lines : [];
    const storedTotal = !Array.isArray(stored) && stored?.total_cost != null ? Number(stored.total_cost) : null;
    return sendPendingTelegram(db, table, requestId, () =>
      sendShopConsumptionApprovalMessage({
        requestId: row.id,
        cashierName: row.cashier_username || String(row.cashier_id),
        totalCost: Number.isFinite(storedTotal)
          ? storedTotal
          : lines.reduce((sum, line) => sum + (Number(line.line_amount ?? line.line_cost) || 0), 0),
        lineCount: lines.length,
        reason: row.reason,
      })
    );
  }
  return false;
}

/** Send a new button only for pending requests that never stored a Telegram message id. */
export async function resendPendingTelegramApprovals(db) {
  const counts = {};
  const jobs = [
    ["refund", resendRefunds],
    ["zimma", resendOnAccount],
    ["cashdebt", resendCashDebt],
    ["sulaf", resendAdvances],
    ["expense", resendExpenses],
    ["supplier", resendSupplierPayments],
    ["consumption", resendConsumption],
  ];
  for (const [kind, run] of jobs) {
    try {
      counts[kind] = await run(db);
    } catch (err) {
      counts[kind] = 0;
      console.error(`[telegram-resend] ${kind} failed:`, err?.message || err);
    }
  }
  await resumeTelegramRetryScheduler(db);
  return counts;
}
