import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { buildReceiptPayload, mapSaleItemsToReceiptLines } from "../utils/receipt.js";
import { getAppSettings } from "../utils/settings.js";
import { loadSalePayments } from "../utils/salePayments.js";

export function createPrintRouter(db) {
  const router = Router();

  router.post("/print-receipt", requireAuth, requirePosAccess, async (req, res) => {
    const { transaction_id } = req.body || {};
    const tid = Number(transaction_id);
    if (!tid) {
      return res.status(400).json({ error: "رقم العملية (transaction_id) مطلوب" });
    }
    const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [tid]);
    if (!tx) {
      return res.status(404).json({ error: "العملية غير موجودة" });
    }

    let items;
    try {
      items = JSON.parse(tx.items_json);
    } catch {
      return res.status(500).json({ error: "بيانات العملية غير صالحة" });
    }

    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [
      tx.cashier_id,
    ]);
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

    res.json({
      success: true,
      receipt_text,
      receipt_html,
      transaction_id: tid,
    });
  });

  return router;
}
