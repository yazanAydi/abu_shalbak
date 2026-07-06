import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { buildReceiptText } from "../utils/receipt.js";
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

    const lines = (Array.isArray(items) ? items : []).map((it) => ({
      name: it.name || `صنف ${it.product_id}`,
      quantity: Number(it.quantity) || 0,
      price: Number(it.price) || 0,
      lineTotal:
        (Number(it.quantity) || 0) * (Number(it.price) || 0),
    }));

    const receipt_text = buildReceiptText({
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
      transaction_id: tid,
    });
  });

  return router;
}
