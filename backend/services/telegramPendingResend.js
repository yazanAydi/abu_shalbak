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

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function storeMessageId(db, table, id, messageId) {
  if (!messageId) return false;
  const info = await db.run(
    `UPDATE ${table} SET telegram_message_id = ? WHERE id = ? AND status = 'pending' AND (telegram_message_id IS NULL OR telegram_message_id = '')`,
    [String(messageId), id]
  );
  return info.changes > 0;
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
    const messageId = await sendRefundApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      transactionId: row.transaction_id,
      total: row.total_amount,
      reason: row.reason || "",
      items: parseJson(row.items_json, []),
    });
    if (await storeMessageId(db, "refund_requests", row.id, messageId)) sent += 1;
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
    const messageId = await sendOnAccountApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      customerName: row.customer_name || null,
      employeeName: row.employee_name || null,
      onAccountAmount: row.on_account_amount,
      total: row.total_amount,
      notes: row.notes || null,
      items: onAccountTelegramItems(row.sale_snapshot_json),
    });
    if (await storeMessageId(db, "on_account_requests", row.id, messageId)) sent += 1;
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
    const messageId = await sendCashDebtApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      shiftId: row.shift_id,
      customerName: row.customer_name,
      amount: row.amount,
      debtBefore: row.debt_before,
      projectedDebt: null,
      notes: row.notes,
    });
    if (await storeMessageId(db, "customer_cash_debt_requests", row.id, messageId)) sent += 1;
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
    const messageId = await sendAdvanceApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      employeeName: row.employee_name,
      amount: row.amount,
      notes: row.notes || "",
    });
    if (await storeMessageId(db, "advance_requests", row.id, messageId)) sent += 1;
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
    const messageId = await sendExpenseApprovalMessage({
      requestId: row.id,
      requesterName: row.requester_username || String(row.requester_id),
      categoryName: row.category_name,
      amount: row.amount,
      paidOn: row.paid_on,
      paymentMethod: row.payment_method,
      note: row.reference_note,
    });
    if (await storeMessageId(db, "expense_approval_requests", row.id, messageId)) sent += 1;
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
    const messageId = await sendSupplierPaymentApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      supplierName: row.supplier_name,
      amount: row.amount,
      shiftId: row.shift_id,
      notes: row.notes,
      forgotten: Number(row.forgotten) === 1,
    });
    if (await storeMessageId(db, "supplier_payment_approval_requests", row.id, messageId)) sent += 1;
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
    const items = parseJson(row.items_json, []);
    const messageId = await sendShopConsumptionApprovalMessage({
      requestId: row.id,
      cashierName: row.cashier_username || String(row.cashier_id),
      totalCost: items.reduce((sum, line) => sum + (Number(line.line_cost) || 0), 0),
      lineCount: items.length,
      reason: row.reason,
    });
    if (await storeMessageId(db, "shop_consumption_requests", row.id, messageId)) sent += 1;
  }
  return sent;
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
  return counts;
}
