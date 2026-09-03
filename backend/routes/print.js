import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { SilentPrintError, silentPrintReceiptHtml } from "../services/windowsSilentPrint.js";
import { buildReceiptPayload, mapSaleItemsToReceiptLines } from "../utils/receipt.js";
import { loadSalePayments } from "../utils/salePayments.js";
import { getAppSettings } from "../utils/settings.js";

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
  const payments = await loadSalePayments(db, tid);
  const settings = await getAppSettings(db);

  const storedItems = await db.all(
    `SELECT line_gross, unit_name, quantity, unit_price
     FROM transaction_items WHERE transaction_id = ? ORDER BY id`,
    [tid]
  );
  const lines = mapSaleItemsToReceiptLines(items, storedItems);

  const { receipt_text, receipt_html } = buildReceiptPayload({
    transactionId: tid,
    timestamp: tx.created_at,
    cashierName: cashier?.username || "",
    lines,
    subtotal: Number(tx.subtotal),
    tax: Number(tx.tax),
    total: Number(tx.total),
    paymentMethod: tx.payment_method,
    payments,
    changeNis: tx.change_amount,
    settings,
  });

  return {
    receipt_text,
    receipt_html,
    transaction_id: tid,
  };
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
        return res.status(500).json({ error: e.message });
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
        return res.status(500).json({ error: e.message });
      }
      next(e);
    }
  });

  return router;
}
