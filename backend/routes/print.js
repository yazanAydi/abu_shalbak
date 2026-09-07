import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { canViewReports } from "../utils/roles.js";
import { getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { SilentPrintError, silentPrintReceiptHtml } from "../services/windowsSilentPrint.js";
import { buildReceiptPayload, mapSaleItemsToReceiptLines, RECEIPT_STORED_ITEMS_SQL } from "../utils/receipt.js";
import { loadSalePayments } from "../utils/salePayments.js";
import { getAppSettings } from "../utils/settings.js";
import { partyBalanceForSale } from "../utils/partyBalanceAroundMove.js";

export async function loadSaleReceipt(db, tid) {
  const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [tid]);
  if (!tx) return null;

  let items;
  try {
    items = JSON.parse(tx.items_json);
  } catch {
    const err = new Error("بيانات العملية غير صالحة");
    err.code = "BAD_ITEMS";
    throw err;
  }

  const cashier = await db.get("SELECT username FROM users WHERE id = ?", [tx.cashier_id]);
  const customer = tx.customer_id
    ? await db.get("SELECT name FROM customers WHERE id = ?", [tx.customer_id])
    : null;
  const payments = await loadSalePayments(db, tid);
  const settings = await getAppSettings(db);

  const storedItems = await db.all(RECEIPT_STORED_ITEMS_SQL, [tid]);
  const lines = mapSaleItemsToReceiptLines(items, storedItems);

  const partyBalance = await partyBalanceForSale(db, {
    customerId: tx.customer_id,
    payments,
    transactionId: tid,
    status: "posted",
  });

  const { receipt_text, receipt_html } = buildReceiptPayload({
    transactionId: tid,
    receiptNumber: tx.receipt_number,
    timestamp: tx.created_at,
    cashierName: cashier?.username || "",
    customerName: customer?.name || "",
    lines,
    subtotal: Number(tx.subtotal),
    tax: Number(tx.tax),
    total: Number(tx.total),
    paymentMethod: tx.payment_method,
    payments,
    changeNis: tx.change_amount,
    settings,
    partyBalance,
  });

  return {
    receipt_text,
    receipt_html,
    transaction_id: tid,
  };
}

async function canAccessSaleReceipt(db, user, tx) {
  if (!user || !tx) return false;
  if (canViewReports(user.role)) return true;
  if (Number(tx.cashier_id) === Number(user.id)) return true;
  const open = await getOpenShiftForCashier(db, user.id);
  return Boolean(open && Number(tx.shift_id) === Number(open.id));
}

function silentPrintHttpStatus(code) {
  if (code === "SILENT_PRINT_UNSUPPORTED") return 501;
  if (code === "VIRTUAL_PRINTER" || code === "NO_PRINTER") return 409;
  if (code === "NO_HTML" || code === "BAD_ITEMS") return 400;
  return 500;
}

export function createPrintRouter(db) {
  const router = Router();

  router.post("/print-receipt/silent", requireAuth, requirePosAccess, async (req, res, next) => {
    const tid = Number((req.body || {}).transaction_id);
    if (!tid) {
      return res.status(400).json({ error: "رقم العملية (transaction_id) مطلوب" });
    }
    try {
      const tx = await db.get("SELECT cashier_id, shift_id FROM transactions WHERE id = ?", [tid]);
      if (!tx) {
        return res.status(404).json({ error: "العملية غير موجودة" });
      }
      if (!(await canAccessSaleReceipt(db, req.user, tx))) {
        return res.status(403).json({ error: "غير مسموح بطباعة هذه الفاتورة", code: "FORBIDDEN" });
      }
      const receipt = await loadSaleReceipt(db, tid);
      if (!receipt) {
        return res.status(404).json({ error: "العملية غير موجودة" });
      }
      const result = await silentPrintReceiptHtml(receipt.receipt_html);
      res.json({
        success: true,
        printed: true,
        transaction_id: tid,
        printer: result.printer || null,
        dry_run: Boolean(result.dryRun),
      });
    } catch (e) {
      if (e.code === "BAD_ITEMS") {
        return next(e);
      }
      if (e instanceof SilentPrintError) {
        return res.status(silentPrintHttpStatus(e.code)).json({
          error: e.message,
          code: e.code,
        });
      }
      next(e);
    }
  });

  router.post("/print-receipt", requireAuth, requirePosAccess, async (req, res, next) => {
    const tid = Number((req.body || {}).transaction_id);
    if (!tid) {
      return res.status(400).json({ error: "رقم العملية (transaction_id) مطلوب" });
    }
    try {
      const tx = await db.get("SELECT cashier_id, shift_id FROM transactions WHERE id = ?", [tid]);
      if (!tx) {
        return res.status(404).json({ error: "العملية غير موجودة" });
      }
      if (!(await canAccessSaleReceipt(db, req.user, tx))) {
        return res.status(403).json({ error: "غير مسموح بطباعة هذه الفاتورة", code: "FORBIDDEN" });
      }
      const receipt = await loadSaleReceipt(db, tid);
      if (!receipt) {
        return res.status(404).json({ error: "العملية غير موجودة" });
      }
      res.json({
        success: true,
        ...receipt,
      });
    } catch (e) {
      if (e.code === "BAD_ITEMS") {
        return next(e);
      }
      next(e);
    }
  });

  return router;
}
