import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { buildReceiptText } from "../utils/receipt.js";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals, productTaxRate, round2 } from "../utils/tax.js";
import { recordMovement } from "../utils/inventory.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";
import { nextReceiptNumber } from "../utils/receiptNumber.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { validate } from "../middleware/validate.js";
import { checkoutSchema } from "../middleware/schemas.js";
import { withTransaction } from "../utils/dbTx.js";

function validateCheckoutBody(body) {
  const { items, payment_method } = body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return "قائمة الأصناف مطلوبة";
  }
  const allowed = ["cash", "visa", "on_account"];
  if (!allowed.includes(payment_method)) {
    return `طريقة الدفع يجب أن تكون: ${allowed.join(" أو ")}`;
  }
  for (const line of items) {
    const qty = Number(line.quantity);
    const price = Number(line.price);
    if (!Number.isInteger(Number(line.product_id)) || Number(line.product_id) <= 0) {
      return "product_id غير صالح في أحد الأصناف";
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return "الكمية يجب أن تكون رقماً موجباً";
    }
    if (!Number.isFinite(price) || price < 0) {
      return "السعر غير صالح في أحد الأصناف";
    }
  }
  return null;
}

export function createCheckoutRouter(db) {
  const router = Router();

  // Rebuild the exact sale response (incl. receipt) from a stored transaction,
  // used to replay the original invoice for a duplicate/idempotent request.
  async function buildResponseFromTransaction(txId, settings) {
    const row = await db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    const tiRows = await db.all(
      "SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [txId]
    );
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [row.cashier_id]);
    const itemsOut = tiRows.map((t) => ({
      product_id: t.product_id,
      barcode: t.barcode,
      name: t.name,
      quantity: t.quantity,
      price: t.unit_price,
      tax_rate: t.tax_rate,
    }));
    const receiptLines = tiRows.map((t) => ({
      name: t.name,
      quantity: t.quantity,
      price: t.unit_price,
      lineTotal: t.line_gross,
    }));
    const receipt_text = buildReceiptText({
      transactionId: txId,
      receiptNumber: row.receipt_number,
      timestamp: row.created_at,
      cashierName: cashier?.username || "",
      lines: receiptLines,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      paymentMethod: row.payment_method,
      settings,
    });
    return {
      success: true,
      transaction_id: txId,
      receipt_number: row.receipt_number,
      items: itemsOut,
      subtotal: row.subtotal,
      tax: row.tax,
      discount: row.discount,
      total: row.total,
      payment_method: row.payment_method,
      timestamp: row.created_at,
      cashier: cashier?.username || "",
      receipt_text,
      idempotent_replay: true,
    };
  }

  router.post("/", requireAuth, requirePosAccess, validate(checkoutSchema), async (req, res, next) => {
    const validationError = validateCheckoutBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    }

    const { items, payment_method, customer_id } = req.body;
    const idempotencyKey = req.body.idempotency_key
      ? String(req.body.idempotency_key).trim()
      : null;
    const settings = await getAppSettings(db);
    const custId = customer_id ? Number(customer_id) : null;

    // Fast path: a retry/duplicate with a previously-used key replays the
    // original invoice instead of creating a second sale.
    if (idempotencyKey) {
      const existing = await db.get(
        "SELECT id FROM transactions WHERE idempotency_key = ?",
        [idempotencyKey]
      );
      if (existing) {
        return res.status(200).json(await buildResponseFromTransaction(existing.id, settings));
      }
    }

    if (custId && payment_method === "on_account") {
      const cust = await db.get("SELECT * FROM customers WHERE id = ?", [custId]);
      if (!cust) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
      if (cust.no_credit) return res.status(400).json({ error: "هذا العميل ممنوع الدين", code: "CREDIT_BLOCKED" });
      if (cust.credit_limit > 0 && cust.balance >= cust.credit_limit) {
        return res.status(400).json({ error: "العميل تجاوز حد الائتمان", code: "CREDIT_LIMIT_EXCEEDED" });
      }
    }

    const normalized = [];
    for (const line of items) {
      const productId = Number(line.product_id);
      const qty = Math.max(1, Number(line.quantity) || 1);
      const price = Number(line.price);

      const p = await db.get("SELECT * FROM products WHERE id = ?", [productId]);
      if (!p) {
        return res.status(404).json({ error: `المنتج غير موجود: ${productId}`, code: "NOT_FOUND" });
      }
      if (Number(p.is_active) === 0) {
        return res.status(409).json({
          error: "المنتج غير نشط ولا يمكن بيعه",
          code: "PRODUCT_INACTIVE",
          product_id: productId,
          name: p.name,
        });
      }
      const dbPrice = round2(Number(p.price));
      const linePrice = round2(price);
      if (Math.abs(dbPrice - linePrice) > 0.009) {
        return res.status(409).json({
          error: "عدم تطابق السعر مع أحدث سعر في النظام",
          code: "PRICE_MISMATCH",
          product_id: productId,
          expected: dbPrice,
          received: linePrice,
        });
      }

      normalized.push({
        product_id: productId,
        barcode: p.barcode,
        name: p.name,
        category: p.category,
        quantity: qty,
        price: dbPrice,
        cost: round2(Number(p.cost) || 0),
        taxRate: productTaxRate(p, settings),
      });
    }

    const taxLines = normalized.map((L) => ({
      quantity: L.quantity,
      unitPrice: L.price,
      taxRate: L.taxRate,
    }));
    const { subtotal, tax } = computeSaleTotals(taxLines, settings);
    const grossTotal = round2(subtotal + tax);

    // Apply active promotions as an order-level discount (does not alter unit prices)
    let discount = 0;
    try {
      const activePromos = await getActivePromotions(db);
      if (activePromos.length > 0) {
        const promoLines = normalized.map((L) => ({
          product_id: L.product_id,
          category: L.category,
          quantity: L.quantity,
          unitPrice: L.price,
        }));
        discount = computeCartDiscount(activePromos, promoLines).discount;
        discount = Math.min(discount, grossTotal);
      }
    } catch (_) { discount = 0; }
    const total = round2(grossTotal - discount);

    const itemsForJson = normalized.map((L) => ({
      product_id: L.product_id,
      barcode: L.barcode,
      name: L.name,
      quantity: L.quantity,
      price: L.price,
      tax_rate: L.taxRate,
    }));

    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [req.user.id]);

    const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, req.user.id);
    if (shiftErr || !shift) {
      return res.status(400).json({ error: shiftErr || "لا توجد وردية مفتوحة", code: "NO_OPEN_SHIFT" });
    }

    const detailed = computeSaleTotals(taxLines, settings).lines;

    try {
      const result = await withTransaction(db, async () => {
        // Re-check inside the transaction so a duplicate that arrived after the
        // fast-path read still replays instead of double-charging.
        if (idempotencyKey) {
          const dup = await db.get(
            "SELECT id FROM transactions WHERE idempotency_key = ?",
            [idempotencyKey]
          );
          if (dup) return { replayTxId: dup.id };
        }

        const receiptNumber = await nextReceiptNumber(db, 1);

        const ins = await db.run(
          `INSERT INTO transactions (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, customer_id, receipt_number, status, store_id, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?)`,
          [req.user.id, JSON.stringify(itemsForJson), subtotal, tax, total, discount, payment_method, shift.id, custId, receiptNumber, idempotencyKey]
        );
        const transactionId = ins.lastID;

        // Insert relational line items for analytics (Phase 2 reports)
        for (let i = 0; i < normalized.length; i++) {
          const L = normalized[i];
          const d = detailed[i];
          const grossProfit = round2(d.lineNet - L.cost * L.quantity);
          await db.run(
            `INSERT INTO transaction_items
               (transaction_id, product_id, barcode, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
                unit_cost_at_sale, gross_profit, discount_at_sale)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              transactionId,
              L.product_id,
              L.barcode,
              L.name,
              L.quantity,
              L.price,
              d.lineNet,
              d.lineTax,
              d.lineGross,
              L.taxRate,
              L.cost,
              grossProfit,
              0,
            ]
          );
        }

        if (payment_method === "cash") {
          await db.run(
            `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, transaction_id)
             VALUES (?, 'payment', ?, ?, ?)`,
            [shift.id, total, `بيع نقدي #${transactionId}`, transactionId]
          );
        }

        // Stock decrement is atomic (UPDATE ... SET stock = stock + delta) and
        // negative stock is allowed by design — overselling is never blocked.
        for (const L of normalized) {
          await recordMovement(db, {
            productId: L.product_id,
            movementType: "sale",
            quantity: -L.quantity,
            refType: "transaction",
            refId: transactionId,
            notes: `بيع ${receiptNumber}`,
            userId: req.user.id,
            applyStock: true,
          });
        }

        if (custId && payment_method === "on_account") {
          await db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [total, custId]);
        }

        return { transactionId, receiptNumber };
      });

      if (result.replayTxId) {
        return res.status(200).json(await buildResponseFromTransaction(result.replayTxId, settings));
      }

      const { transactionId, receiptNumber } = result;
      const row = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
      const receiptLines = normalized.map((L, i) => ({
        name: L.name,
        quantity: L.quantity,
        price: L.price,
        lineTotal: detailed[i].lineGross,
      }));
      const receipt_text = buildReceiptText({
        transactionId,
        receiptNumber,
        timestamp: row.created_at,
        cashierName: cashier?.username || "",
        lines: receiptLines,
        subtotal,
        tax,
        total,
        paymentMethod: payment_method,
        settings,
      });

      res.status(201).json({
        success: true,
        transaction_id: transactionId,
        receipt_number: receiptNumber,
        items: itemsForJson,
        subtotal,
        tax,
        discount,
        total,
        payment_method,
        timestamp: row.created_at,
        cashier: cashier?.username || "",
        receipt_text,
      });
    } catch (e) {
      // Concurrent duplicate: the unique index rejected the second insert.
      // Return the original invoice instead of an error.
      if (
        idempotencyKey &&
        e &&
        String(e.code || "").startsWith("SQLITE_CONSTRAINT") &&
        /idempotency/i.test(String(e.message || ""))
      ) {
        const existing = await db.get(
          "SELECT id FROM transactions WHERE idempotency_key = ?",
          [idempotencyKey]
        );
        if (existing) {
          return res.status(200).json(await buildResponseFromTransaction(existing.id, settings));
        }
      }
      next(e);
    }
  });

  return router;
}
