import { round2 } from "../utils/tax.js";
import { nextReceiptNumber } from "../utils/receiptNumber.js";
import { insertSalePayments, netDrawerCashNis } from "../utils/salePayments.js";
import { markSuspendedSaleCompleted } from "../services/suspendedSaleService.js";
import { withTransaction } from "../utils/dbTx.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { HttpError } from "../utils/httpError.js";
import { applySaleStock } from "./stockBatchService.js";

/**
 * Execute a validated checkout sale (inventory, payments, customer balance, cash movement).
 * @param {{ inTransaction?: boolean }} [options] — set inTransaction when already inside withTransaction
 */
export async function executeCheckoutSale(db, params, options = {}) {
  const run = async () => executeCheckoutSaleCore(db, params, options);
  if (options.inTransaction) return run();
  return withTransaction(db, run);
}

async function executeCheckoutSaleCore(db, params, options = {}) {
  const {
    cashierId,
    shiftId,
    custId,
    itemsForJson,
    normalized,
    detailed,
    subtotal,
    tax,
    total,
    discount,
    amountBeforeRounding = null,
    roundingAdjustment = null,
    paymentLines,
    summaryMethod,
    onAccountTotal,
    cashTotal: _cashTotal,
    changeNis,
    changeCurrencyId,
    changeOriginalAmount,
    idempotencyKey,
    payloadFingerprint,
    suspendedSaleId,
    promoBreakdown,
    employeeId = null,
    notes = null,
  } = params;

  if (idempotencyKey) {
    const dup = await db.get(
      "SELECT id, cashier_id, payload_fingerprint FROM transactions WHERE idempotency_key = ?",
      [idempotencyKey]
    );
    if (dup) {
      if (Number(dup.cashier_id) !== Number(cashierId)) {
        throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
      }
      if (
        dup.payload_fingerprint &&
        payloadFingerprint &&
        dup.payload_fingerprint !== payloadFingerprint
      ) {
        throw new HttpError(
          409,
          "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
          "IDEMPOTENCY_KEY_REUSE"
        );
      }
      return { replayTxId: dup.id };
    }
  }

  if (shiftId) {
    const allowed = options.allowPendingCount ? ["open", "pending_count"] : ["open"];
    const openShift = await db.get(
      `SELECT id FROM cashier_shifts WHERE id = ? AND status IN (${allowed.map(() => "?").join(", ")})`,
      [shiftId, ...allowed]
    );
    if (!openShift) {
      const err = new Error("الوردية أُغلقت — أعد المحاولة بعد فتح وردية");
      err.status = 409;
      err.code = "SHIFT_CLOSED";
      throw err;
    }
  }

  if (suspendedSaleId) {
    await markSuspendedSaleCompleted(db, suspendedSaleId);
  }

  const receiptNumber = await nextReceiptNumber(db, 1);

    const ins = await db.run(
      `INSERT INTO transactions (cashier_id, items_json, subtotal, tax, total, discount, amount_before_rounding, rounding_adjustment, change_amount, change_currency_id, change_original_amount, payment_method, shift_id, customer_id, employee_id, receipt_number, status, store_id, idempotency_key, payload_fingerprint, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?)`,
      [
        cashierId,
        JSON.stringify(itemsForJson),
        subtotal,
        tax,
        total,
        discount,
        amountBeforeRounding,
        roundingAdjustment,
        round2(changeNis || 0),
        changeCurrencyId ?? null,
        changeOriginalAmount != null ? round2(changeOriginalAmount) : round2(changeNis || 0),
        summaryMethod,
        shiftId,
        custId,
        employeeId || null,
        receiptNumber,
        idempotencyKey,
        payloadFingerprint || null,
        notes || null,
      ]
    );
    const transactionId = ins.lastID;
    let saleBusinessDay = null;
    if (shiftId) {
      const shiftDay = await db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [shiftId]);
      saleBusinessDay = shiftDay?.business_day || null;
    }

    const preDiscountGross = round2(
      detailed.reduce((s, d) => s + round2(Number(d.lineGross) || 0), 0)
    );
    let discountAllocated = 0;

    for (let i = 0; i < normalized.length; i++) {
      const L = normalized[i];
      const d = detailed[i];
      const lineGross = round2(Number(d?.lineGross) || 0);
      let lineDiscount = 0;
      if (discount > 0 && preDiscountGross > 0) {
        if (i === normalized.length - 1) {
          lineDiscount = round2(discount - discountAllocated);
        } else {
          lineDiscount = round2(discount * (lineGross / preDiscountGross));
          discountAllocated = round2(discountAllocated + lineDiscount);
        }
      }
      const lineNetAfterDiscount = round2(d.lineNet - lineDiscount);
      const costKnown = L.cost != null && Number.isFinite(Number(L.cost));
      const unitCost = costKnown ? Number(L.cost) : null;
      const grossProfit = costKnown ? round2(lineNetAfterDiscount - unitCost * L.quantity) : null;
      const itemIns = await db.run(
        `INSERT INTO transaction_items
           (transaction_id, product_id, barcode, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
            unit_cost_at_sale, gross_profit, discount_at_sale, scanned_barcode, product_barcode_id,
            product_unit_id, unit_name, conversion_to_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          L.product_id,
          L.barcode,
          L.name,
          L.quantity,
          L.price,
          lineNetAfterDiscount,
          d.lineTax,
          d.lineGross,
          L.taxRate,
          unitCost,
          grossProfit,
          lineDiscount,
          L.scanned_barcode,
          L.product_barcode_id,
          L.product_unit_id,
          L.unit_name,
          L.conversion_to_base,
        ]
      );
      await applySaleStock(db, {
        productId: L.product_id,
        quantity: L.stock_delta,
        userId: cashierId,
        notes: `بيع ${receiptNumber} (${L.unit_name} x${L.quantity})`,
        referenceType: "transaction",
        referenceId: transactionId,
        transactionItemId: itemIns.lastID,
        businessDay: saleBusinessDay,
      });
    }

    await insertSalePayments(db, transactionId, paymentLines);

    const netCashNis = netDrawerCashNis(paymentLines, changeNis);
    if (netCashNis > 0) {
      await db.run(
        `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, transaction_id)
         VALUES (?, 'payment', ?, ?, ?)`,
        [shiftId, netCashNis, `بيع نقدي #${transactionId}`, transactionId]
      );
    }

    if (custId && onAccountTotal > 0) {
      await db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [onAccountTotal, custId]);
    }

    if (promoBreakdown.length > 0) {
      const usageByPromo = new Map();
      for (const entry of promoBreakdown) {
        const units = Number(entry.units_used) || 0;
        if (units <= 0) continue;
        usageByPromo.set(entry.promotion_id, (usageByPromo.get(entry.promotion_id) || 0) + units);
      }
      for (const [promoId, units] of usageByPromo) {
        const info = await db.run(
          `UPDATE promotions SET used_qty = used_qty + ?
           WHERE id = ? AND (limit_qty <= 0 OR used_qty + ? <= limit_qty)`,
          [units, promoId, units]
        );
        if (!info.changes) {
          const err = new Error("تجاوز حد العرض");
          err.status = 409;
          err.code = "PROMO_LIMIT";
          throw err;
        }
      }
      invalidatePromotionsCache();
    }

    return { transactionId, receiptNumber };
}