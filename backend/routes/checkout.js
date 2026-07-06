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
import { getDefaultUnit, ensureDefaultProductUnit } from "../utils/productUnits.js";
import {
  resolveCheckoutPayments,
  loadSalePayments,
  insertSalePayments,
} from "../utils/salePayments.js";
import {
  loadSuspendedSaleItemMap,
  markSuspendedSaleCompleted,
} from "../services/suspendedSaleService.js";

const SUSPENDED_QTY_TOLERANCE = 0.0001;

function cartMatchesSuspendedExactly(itemMap, normalized) {
  if (normalized.length !== itemMap.size) return false;
  for (const line of normalized) {
    const key = `${line.product_id}-${line.product_unit_id}`;
    const snap = itemMap.get(key);
    if (!snap || Math.abs(Number(snap.quantity) - line.quantity) > SUSPENDED_QTY_TOLERANCE) {
      return false;
    }
  }
  return true;
}

function validateCheckoutBody(body) {
  const { items } = body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return "قائمة الأصناف مطلوبة";
  }
  if (!body.payment_method && (!Array.isArray(body.payments) || body.payments.length === 0)) {
    return "طريقة الدفع مطلوبة";
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

async function validateCustomerCredit(db, custId, onAccountAmount) {
  if (!custId || onAccountAmount <= 0) return null;
  const cust = await db.get("SELECT * FROM customers WHERE id = ?", [custId]);
  if (!cust) return { status: 404, error: "العميل غير موجود", code: "NOT_FOUND" };
  if (cust.no_credit) return { status: 400, error: "هذا العميل ممنوع الدين", code: "CREDIT_BLOCKED" };
  if (cust.credit_limit > 0 && cust.balance + onAccountAmount > cust.credit_limit) {
    return { status: 400, error: "العميل تجاوز حد الائتمان", code: "CREDIT_LIMIT_EXCEEDED" };
  }
  return null;
}

export function createCheckoutRouter(db) {
  const router = Router();

  async function buildResponseFromTransaction(txId, settings) {
    const row = await db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    const tiRows = await db.all(
      "SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id",
      [txId]
    );
    const payments = await loadSalePayments(db, txId);
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
      name: t.unit_name ? `${t.name} (${t.unit_name})` : t.name,
      quantity: t.quantity,
      price: t.unit_price,
      lineTotal: t.line_gross,
      weighed: t.unit_name === "كغم",
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
      payments,
      changeNis: row.change_amount,
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
      payments,
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

    const { items, customer_id } = req.body;
    const idempotencyKey = req.body.idempotency_key
      ? String(req.body.idempotency_key).trim()
      : null;
    const settings = await getAppSettings(db);
    const custId = customer_id ? Number(customer_id) : null;
    const suspendedSaleId = req.body.suspended_sale_id ? Number(req.body.suspended_sale_id) : null;

    let suspendedContext = null;
    if (suspendedSaleId) {
      const { sale, itemMap } = await loadSuspendedSaleItemMap(db, suspendedSaleId);
      if (!sale || !itemMap) {
        return res.status(404).json({
          error: "الفاتورة المعلقة غير موجودة أو مكتملة",
          code: "SUSPENDED_NOT_FOUND",
        });
      }
      suspendedContext = { sale, itemMap, usedKeys: new Set() };
    }

    if (idempotencyKey) {
      const existing = await db.get(
        "SELECT id FROM transactions WHERE idempotency_key = ?",
        [idempotencyKey]
      );
      if (existing) {
        return res.status(200).json(await buildResponseFromTransaction(existing.id, settings));
      }
    }

    const normalized = [];
    for (const line of items) {
      const productId = Number(line.product_id);
      const rawQty = Number(line.quantity);
      const price = Number(line.price);

      const p = await db.get("SELECT * FROM products WHERE id = ?", [productId]);
      if (!p) {
        return res.status(404).json({ error: `المنتج غير موجود: ${productId}`, code: "NOT_FOUND" });
      }
      const isWeighed = Number(p.is_weighed) === 1;
      let qty;
      if (isWeighed) {
        if (!Number.isFinite(rawQty) || rawQty <= 0) {
          return res.status(400).json({
            error: "كمية الوزن غير صالحة",
            code: "INVALID_WEIGHT_QTY",
            product_id: productId,
          });
        }
        qty = rawQty;
      } else {
        qty = Math.max(1, rawQty || 1);
      }
      if (Number(p.is_active) === 0) {
        return res.status(409).json({
          error: "المنتج غير نشط ولا يمكن بيعه",
          code: "PRODUCT_INACTIVE",
          product_id: productId,
          name: p.name,
        });
      }

      await ensureDefaultProductUnit(db, productId);

      let unitId = line.unit_id != null ? Number(line.unit_id) : line.product_unit_id != null ? Number(line.product_unit_id) : null;
      const explicitUnitId =
        line.unit_id != null || line.product_unit_id != null;
      let unit = null;
      if (unitId) {
        unit = await db.get("SELECT * FROM product_units WHERE id = ? AND product_id = ?", [
          unitId,
          productId,
        ]);
        if (!unit) {
          return res.status(400).json({
            error: "معرّف الوحدة لا يطابق المنتج",
            code: "UNIT_PRODUCT_MISMATCH",
            product_id: productId,
          });
        }
      } else {
        unit = await db.get(
          "SELECT * FROM product_units WHERE product_id = ? ORDER BY is_default DESC, id ASC LIMIT 1",
          [productId]
        );
        if (!unit) {
          const fallback = await getDefaultUnit(db, productId);
          if (!fallback) {
            return res.status(409).json({
              error: "لا توجد وحدة بيع للمنتج",
              code: "NO_SELLABLE_UNIT",
              product_id: productId,
            });
          }
          unit = await db.get("SELECT * FROM product_units WHERE id = ?", [fallback.id]);
        }
        unitId = unit.id;
      }

      if (Number(unit.is_default) === 1 && !explicitUnitId) {
        const livePrice = round2(Number(p.price));
        if (Math.abs(livePrice - round2(Number(unit.price))) > 0.009) {
          await db.run("UPDATE product_units SET price = ?, updated_at = datetime('now') WHERE id = ?", [
            livePrice,
            unit.id,
          ]);
          unit.price = livePrice;
        }
        const liveCost = round2(Number(p.cost) || 0);
        if (liveCost !== round2(Number(unit.cost) || 0)) {
          await db.run("UPDATE product_units SET cost = ? WHERE id = ?", [liveCost, unit.id]);
          unit.cost = liveCost;
        }
      }

      const dbPrice = round2(Number(unit.price));
      const linePrice = round2(price);
      let snapshotRow = null;
      if (suspendedContext) {
        const snapKey = `${productId}-${unitId}`;
        snapshotRow = suspendedContext.itemMap.get(snapKey) || null;
        if (snapshotRow) {
          suspendedContext.usedKeys.add(snapKey);
        }
      }

      if (!snapshotRow && Math.abs(dbPrice - linePrice) > 0.009) {
        return res.status(409).json({
          error: "عدم تطابق السعر مع أحدث سعر في النظام",
          code: "PRICE_MISMATCH",
          product_id: productId,
          unit_id: unitId,
          expected: dbPrice,
          received: linePrice,
        });
      }

      const effectivePrice = snapshotRow
        ? round2(Number(snapshotRow.unit_price_snapshot))
        : dbPrice;

      let scannedBarcode = line.scanned_barcode != null ? String(line.scanned_barcode).trim() : null;
      let productBarcodeId = line.product_barcode_id != null ? Number(line.product_barcode_id) : null;
      if (productBarcodeId) {
        const pb = await db.get(
          "SELECT id, barcode, product_id FROM product_barcodes WHERE id = ?",
          [productBarcodeId]
        );
        if (!pb || Number(pb.product_id) !== productId) {
          return res.status(400).json({
            error: "معرّف الباركود لا يطابق المنتج",
            code: "BARCODE_PRODUCT_MISMATCH",
            product_id: productId,
          });
        }
        if (!scannedBarcode) scannedBarcode = pb.barcode;
      }
      if (!scannedBarcode) scannedBarcode = unit.barcode;
      if (snapshotRow?.scanned_barcode_snapshot) {
        scannedBarcode = snapshotRow.scanned_barcode_snapshot;
      }

      const conversionToBase = snapshotRow
        ? Math.max(0.0001, Number(snapshotRow.conversion_to_base) || 1)
        : Math.max(0.0001, Number(unit.conversion_to_base) || 1);
      const stockDelta = qty * conversionToBase;

      const lineName = snapshotRow ? snapshotRow.product_name_snapshot : p.name;
      const lineUnitName = snapshotRow ? snapshotRow.unit_name_snapshot : unit.unit_name;
      const lineBarcode = snapshotRow?.barcode_snapshot || unit.barcode;
      const lineTaxRate = snapshotRow
        ? Number(snapshotRow.tax_rate_snapshot)
        : productTaxRate(p, settings);

      normalized.push({
        product_id: productId,
        product_unit_id: unitId,
        unit_name: lineUnitName,
        conversion_to_base: conversionToBase,
        stock_delta: stockDelta,
        barcode: lineBarcode,
        scanned_barcode: scannedBarcode || null,
        product_barcode_id: productBarcodeId || null,
        name: lineName,
        category: p.category,
        quantity: qty,
        price: effectivePrice,
        cost: round2(Number(unit.cost) || Number(p.cost) || 0),
        taxRate: lineTaxRate,
        is_weighed: isWeighed,
      });
    }

    const taxLines = normalized.map((L) => ({
      quantity: L.quantity,
      unitPrice: L.price,
      taxRate: L.taxRate,
    }));
    const { subtotal, tax } = computeSaleTotals(taxLines, settings);
    const grossTotal = round2(subtotal + tax);

    let discount = 0;
    if (
      suspendedContext &&
      cartMatchesSuspendedExactly(suspendedContext.itemMap, normalized)
    ) {
      discount = round2(Number(suspendedContext.sale.discount));
    } else {
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
      } catch (_) {
        discount = 0;
      }
    }
    const total = round2(grossTotal - discount);

    const paymentResolved = await resolveCheckoutPayments(db, req.body, total);
    if (paymentResolved.error) {
      return res.status(400).json({ error: paymentResolved.error, code: "PAYMENT_ERROR" });
    }

    const { lines: paymentLines, summaryMethod, cashTendered, onAccountTotal, cashTotal, changeNis } =
      paymentResolved;

    if (onAccountTotal > 0 && !custId) {
      return res.status(400).json({ error: "اختر عميلاً للبيع على الذمة", code: "CUSTOMER_REQUIRED" });
    }

    const creditErr = await validateCustomerCredit(db, custId, onAccountTotal);
    if (creditErr) {
      return res.status(creditErr.status).json({
        error: creditErr.error,
        code: creditErr.code,
      });
    }

    const itemsForJson = normalized.map((L) => ({
      product_id: L.product_id,
      unit_id: L.product_unit_id,
      barcode: L.barcode,
      name: L.name,
      unit_name: L.unit_name,
      quantity: L.quantity,
      price: L.price,
      tax_rate: L.taxRate,
      conversion_to_base: L.conversion_to_base,
    }));

    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [req.user.id]);

    const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, req.user.id);
    if (shiftErr || !shift) {
      return res.status(400).json({ error: shiftErr || "لا توجد وردية مفتوحة", code: "NO_OPEN_SHIFT" });
    }

    if (suspendedContext && Number(suspendedContext.sale.shift_id) !== Number(shift.id)) {
      return res.status(403).json({
        error: "الفاتورة المعلقة تابعة لوردية أخرى",
        code: "SUSPENDED_SHIFT_MISMATCH",
      });
    }

    const detailed = computeSaleTotals(taxLines, settings).lines;

    try {
      const result = await withTransaction(db, async () => {
        if (idempotencyKey) {
          const dup = await db.get(
            "SELECT id FROM transactions WHERE idempotency_key = ?",
            [idempotencyKey]
          );
          if (dup) return { replayTxId: dup.id };
        }

        const receiptNumber = await nextReceiptNumber(db, 1);

        const ins = await db.run(
          `INSERT INTO transactions (cashier_id, items_json, subtotal, tax, total, discount, change_amount, payment_method, shift_id, customer_id, receipt_number, status, store_id, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?)`,
          [
            req.user.id,
            JSON.stringify(itemsForJson),
            subtotal,
            tax,
            total,
            discount,
            round2(changeNis || 0),
            summaryMethod,
            shift.id,
            custId,
            receiptNumber,
            idempotencyKey,
          ]
        );
        const transactionId = ins.lastID;

        for (let i = 0; i < normalized.length; i++) {
          const L = normalized[i];
          const d = detailed[i];
          const grossProfit = round2(d.lineNet - L.cost * L.quantity);
          await db.run(
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
              d.lineNet,
              d.lineTax,
              d.lineGross,
              L.taxRate,
              L.cost,
              grossProfit,
              0,
              L.scanned_barcode,
              L.product_barcode_id,
              L.product_unit_id,
              L.unit_name,
              L.conversion_to_base,
            ]
          );
        }

        await insertSalePayments(db, transactionId, paymentLines);

        const netCashNis = round2((cashTotal || 0) - (changeNis || 0));
        if (netCashNis > 0) {
          await db.run(
            `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, transaction_id)
             VALUES (?, 'payment', ?, ?, ?)`,
            [shift.id, netCashNis, `بيع نقدي #${transactionId}`, transactionId]
          );
        }

        for (const L of normalized) {
          await recordMovement(db, {
            productId: L.product_id,
            movementType: "sale",
            quantity: -L.stock_delta,
            refType: "transaction",
            refId: transactionId,
            notes: `بيع ${receiptNumber} (${L.unit_name} x${L.quantity})`,
            userId: req.user.id,
            applyStock: true,
          });
        }

        if (custId && onAccountTotal > 0) {
          await db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [
            onAccountTotal,
            custId,
          ]);
        }

        if (suspendedContext) {
          await markSuspendedSaleCompleted(db, suspendedSaleId);
        }

        return { transactionId, receiptNumber };
      });

      if (result.replayTxId) {
        return res.status(200).json(await buildResponseFromTransaction(result.replayTxId, settings));
      }

      const { transactionId, receiptNumber } = result;
      const row = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
      const receiptLines = normalized.map((L, i) => ({
        name: L.unit_name ? `${L.name} (${L.unit_name})` : L.name,
        quantity: L.quantity,
        price: L.price,
        lineTotal: detailed[i].lineGross,
        weighed: L.is_weighed,
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
        paymentMethod: summaryMethod,
        payments: paymentLines,
        cashTendered,
        changeNis,
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
        payment_method: summaryMethod,
        payments: paymentLines,
        timestamp: row.created_at,
        cashier: cashier?.username || "",
        receipt_text,
      });
    } catch (e) {
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
