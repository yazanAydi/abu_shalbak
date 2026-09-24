import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { buildReceiptPayload } from "../utils/receipt.js";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { computeSaleTotals, productTaxRate, round2 } from "../utils/tax.js";
import { roundPosPayable } from "../utils/money.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { validate } from "../middleware/validate.js";
import { checkoutSchema } from "../middleware/schemas.js";
import { getDefaultUnit, ensureDefaultProductUnit, resolveSoldUnitCost, isProductCostKnown, isWeighedBaseUnit, isKgUnit, toBaseQuantity } from "../utils/productUnits.js";
import {
  resolveCheckoutPayments,
  loadSalePayments,
  assertDrawerCanGiveChange,
} from "../utils/salePayments.js";
import {
  loadSuspendedSaleItemMap,
} from "../services/suspendedSaleService.js";
import {
  createOnAccountRequest,
  notifyOnAccountRequestTelegram,
} from "../services/onAccountRequestService.js";
import { executeCheckoutSale } from "../services/checkoutSaleService.js";
import { withTransaction } from "../utils/dbTx.js";
import { validateCustomerCredit } from "../utils/customerCredit.js";
import { partyBalanceForSale } from "../utils/partyBalanceAroundMove.js";
import {
  fingerprintCheckoutPayload,
  resolveCheckoutIdempotency,
} from "../utils/checkoutIdempotency.js";
import { resolveOnAccountParty } from "../utils/onAccountParty.js";
import { resolveCheckoutNotes } from "../utils/checkoutNotes.js";
import { isUnitSaleEnabled } from "../utils/bakeryMembership.js";

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
    if (!Number.isFinite(qty) || qty <= 0) {
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

  async function buildResponseFromTransaction(txId, settings) {
    const row = await db.get("SELECT * FROM transactions WHERE id = ?", [txId]);
    const tiRows = await db.all(
      `SELECT ti.*, p.sku AS product_sku
       FROM transaction_items ti
       LEFT JOIN products p ON p.id = ti.product_id
       WHERE ti.transaction_id = ? ORDER BY ti.id`,
      [txId]
    );
    const payments = await loadSalePayments(db, txId);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [row.cashier_id]);
    const customer = row.customer_id
      ? await db.get("SELECT name FROM customers WHERE id = ?", [row.customer_id])
      : null;
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
      sku: t.product_sku,
      quantity: t.quantity,
      price: t.unit_price,
      lineTotal: t.line_gross,
      weighed: t.unit_name === "كغم",
    }));
    const receiptOpts = {
      transactionId: txId,
      receiptNumber: row.receipt_number,
      timestamp: row.created_at,
      cashierName: cashier?.username || "",
      customerName: customer?.name || "",
      lines: receiptLines,
      subtotal: row.subtotal,
      tax: row.tax,
      discount: row.discount,
      total: row.total,
      roundingAdjustment: row.rounding_adjustment,
      paymentMethod: row.payment_method,
      payments,
      changeNis: row.change_amount,
      settings,
      partyBalance: await partyBalanceForSale(db, {
        customerId: row.customer_id,
        payments,
        transactionId: txId,
        status: "posted",
      }),
    };
    const { receipt_text, receipt_html } = buildReceiptPayload(receiptOpts);
    return {
      success: true,
      transaction_id: txId,
      receipt_number: row.receipt_number,
      items: itemsOut,
      subtotal: row.subtotal,
      tax: row.tax,
      discount: row.discount,
      total: row.total,
      amount_before_rounding: row.amount_before_rounding,
      rounding_adjustment: row.rounding_adjustment,
      payment_method: row.payment_method,
      payments,
      timestamp: row.created_at,
      cashier: cashier?.username || "",
      receipt_text,
      receipt_html,
      idempotent_replay: true,
    };
  }

  router.post("/", requireAuth, requirePosAccess, validate(checkoutSchema), async (req, res, next) => {
    const validationError = validateCheckoutBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    }

    const { items, customer_id, employee_id } = req.body;
    const idempotencyKey = String(req.body.idempotency_key).trim();
    const settings = await getAppSettings(db);
    const rawCustId = customer_id ? Number(customer_id) : null;
    const rawEmpId = employee_id ? Number(employee_id) : null;
    let custId = rawCustId;
    let empId = rawEmpId;
    const suspendedSaleId = req.body.suspended_sale_id ? Number(req.body.suspended_sale_id) : null;
    let notes = null;
    try {
      notes = resolveCheckoutNotes(req.body);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
    const payloadFingerprint = fingerprintCheckoutPayload({
      items,
      payments: req.body.payments,
      payment_method: req.body.payment_method,
      customer_id: rawCustId,
      employee_id: rawEmpId,
      suspended_sale_id: suspendedSaleId,
      notes,
    });

    try {
      const early = await resolveCheckoutIdempotency(db, {
        key: idempotencyKey,
        fingerprint: payloadFingerprint,
        userId: req.user.id,
      });
      if (early.kind === "sale") {
        return res.status(200).json(await buildResponseFromTransaction(early.transactionId, settings));
      }
      if (early.kind === "oa_pending") {
        return res.status(202).json({
          pending_approval: true,
          request_id: early.requestId,
          message: "سُجّل طلب البيع على الذمة قيد المراجعة. لن يُكمَل البيع حتى موافقة المسؤول.",
          telegram: false,
          idempotent_replay: true,
        });
      }
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }

    let suspendedContext = null;
    if (suspendedSaleId) {
      const hold = await db.get("SELECT * FROM suspended_sales WHERE id = ?", [suspendedSaleId]);
      if (!hold) {
        return res.status(404).json({
          error: "الفاتورة المعلقة غير موجودة أو مكتملة",
          code: "SUSPENDED_NOT_FOUND",
        });
      }
      if (hold.status !== "suspended") {
        return res.status(409).json({
          error: "الفاتورة المعلقة مكتملة أو غير موجودة",
          code: "SUSPENDED_ALREADY_COMPLETED",
        });
      }
      const { sale, itemMap } = await loadSuspendedSaleItemMap(db, suspendedSaleId);
      if (!sale || !itemMap) {
        return res.status(409).json({
          error: "الفاتورة المعلقة مكتملة أو غير موجودة",
          code: "SUSPENDED_ALREADY_COMPLETED",
        });
      }
      suspendedContext = { sale, itemMap, usedKeys: new Set() };
    }

    const uniqueProductIds = [
      ...new Set(items.map((line) => Number(line.product_id)).filter(Boolean)),
    ];
    const productById = new Map();
    const unitsByProduct = new Map();
    if (uniqueProductIds.length) {
      const ph = uniqueProductIds.map(() => "?").join(",");
      const productRows = await db.all(`SELECT * FROM products WHERE id IN (${ph})`, uniqueProductIds);
      for (const row of productRows) productById.set(Number(row.id), row);
      for (const pid of uniqueProductIds) {
        await ensureDefaultProductUnit(db, pid);
      }
      const unitRows = await db.all(
        `SELECT * FROM product_units WHERE product_id IN (${ph}) ORDER BY is_default DESC, id ASC`,
        uniqueProductIds
      );
      for (const u of unitRows) {
        const pid = Number(u.product_id);
        if (!unitsByProduct.has(pid)) unitsByProduct.set(pid, []);
        unitsByProduct.get(pid).push(u);
      }
    }

    const normalized = [];
    for (const line of items) {
      const productId = Number(line.product_id);
      const rawQty = Number(line.quantity);
      const price = Number(line.price);

      const p = productById.get(productId);
      if (!p) {
        return res.status(404).json({ error: `المنتج غير موجود: ${productId}`, code: "NOT_FOUND" });
      }
      const isWeighed = Number(p.is_weighed) === 1;
      if (Number(p.is_active) === 0) {
        return res.status(409).json({
          error: "المنتج غير نشط ولا يمكن بيعه",
          code: "PRODUCT_INACTIVE",
          product_id: productId,
          name: p.name,
        });
      }

      let unitId = line.unit_id != null ? Number(line.unit_id) : line.product_unit_id != null ? Number(line.product_unit_id) : null;
      const explicitUnitId =
        line.unit_id != null || line.product_unit_id != null;
      const units = unitsByProduct.get(productId) || [];
      let unit = null;
      if (unitId) {
        unit = units.find((u) => Number(u.id) === Number(unitId)) || null;
        if (!unit) {
          return res.status(400).json({
            error: "معرّف الوحدة لا يطابق المنتج",
            code: "UNIT_PRODUCT_MISMATCH",
            product_id: productId,
          });
        }
      } else {
        unit = units[0] || null;
        if (!unit) {
          const fallback = await getDefaultUnit(db, productId);
          if (!fallback) {
            return res.status(409).json({
              error: "لا توجد وحدة بيع للمنتج",
              code: "NO_SELLABLE_UNIT",
              product_id: productId,
            });
          }
          unit = fallback;
        }
        unitId = unit.id;
      }

      const unitSellable = isUnitSaleEnabled(unit);
      const bakery = String(p.inventory_scope || "retail") === "bakery";
      if (bakery && !unitSellable) {
        return res.status(409).json({
          error: "مواد المخبز غير قابلة للبيع",
          code: "BAKERY_SUPPLY_NOT_SELLABLE",
          product_id: productId,
          name: p.name,
        });
      }
      if (!bakery && !unitSellable) {
        const anySale = units.some((u) => isUnitSaleEnabled(u));
        if (anySale) {
          return res.status(409).json({
            error: "لا توجد وحدة بيع للمنتج",
            code: "NO_SELLABLE_UNIT",
            product_id: productId,
            name: p.name,
          });
        }
      }

      if (Number(unit.is_default) === 1 && !explicitUnitId) {
        const livePrice = round2(Number(p.price));
        if (Math.abs(livePrice - round2(Number(unit.price))) > 0.009) {
          unit.price = livePrice;
        }
        // unit.cost is no longer the COGS source — resolveSoldUnitCost always derives
        // from products.cost × conversion_to_base. No need to patch unit.cost here.
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
      const unitForQty = snapshotRow
        ? { unit_name: snapshotRow.unit_name_snapshot, conversion_to_base: conversionToBase }
        : unit;
      // isWeightLine: true when product is is_weighed=1 AND sold as كغم.
      // Used for whole-shekel scale rounding only — NOT for qty gate.
      const isWeightLine = isWeighedBaseUnit(unitForQty, isWeighed);
      // isKgSale: true whenever the sold unit is كغم regardless of is_weighed.
      // This is the gate for allowing fractional quantities.
      const isKgSale = isKgUnit(unitForQty);
      let qty;
      if (isKgSale) {
        // KG unit: fractional quantities always allowed (0.255, 0.5, 1.25…).
        if (!Number.isFinite(rawQty) || rawQty <= 0) {
          return res.status(400).json({
            error: "كمية الوزن غير صالحة",
            code: "INVALID_WEIGHT_QTY",
            product_id: productId,
          });
        }
        qty = rawQty;
      } else if (isWeighed) {
        // Weighed product but sold as a package unit (حبة): integer only.
        if (!Number.isFinite(rawQty) || rawQty < 1 || Math.abs(rawQty - Math.round(rawQty)) > 1e-9) {
          return res.status(400).json({
            error: "كمية الحبة غير صالحة",
            code: "INVALID_PACKAGE_QTY",
            product_id: productId,
          });
        }
        qty = Math.round(rawQty);
      } else if (!Number.isFinite(rawQty) || rawQty < 1 || Math.abs(rawQty - Math.round(rawQty)) > 1e-9) {
        // Piece and package units are whole counts. A fraction is rejected
        // rather than rounded up to the next piece.
        return res.status(400).json({
          error: "كمية الحبة يجب أن تكون عدداً صحيحاً",
          code: "INVALID_PIECE_QTY",
          product_id: productId,
        });
      } else {
        qty = Math.round(rawQty);
      }
      const stockDelta = toBaseQuantity(qty, conversionToBase);

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
        sku: p.sku ?? null,
        scanned_barcode: scannedBarcode || null,
        product_barcode_id: productBarcodeId || null,
        name: lineName,
        category: p.category,
        quantity: qty,
        price: effectivePrice,
        cost: isProductCostKnown(p) ? resolveSoldUnitCost(unit, p) : null,
        taxRate: lineTaxRate,
        is_weighed: isWeightLine,
      });
    }

    const taxLines = normalized.map((L) => ({
      quantity: L.quantity,
      unitPrice: L.price,
      taxRate: L.taxRate,
      scaleWeighed: Boolean(L.is_weighed),
    }));
    const saleTotals = computeSaleTotals(taxLines, settings);
    const { subtotal, tax } = saleTotals;
    const grossTotal = round2(subtotal + tax);

    let discount = 0;
    let promoBreakdown = [];
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
            product_unit_id: L.product_unit_id,
            category: L.category,
            quantity: L.quantity,
            unitPrice: L.price,
          }));
          const promoResult = computeCartDiscount(activePromos, promoLines);
          discount = promoResult.discount;
          promoBreakdown = promoResult.breakdown || [];
          discount = Math.min(discount, grossTotal);
        }
      } catch (err) {
        const e = new Error(err?.message || "فشل احتساب العرض");
        e.status = 409;
        e.code = "PROMO_FAILED";
        throw e;
      }
    }
    const calculatedTotal = round2(grossTotal - discount);
    const payable = roundPosPayable(calculatedTotal);
    const total = payable.payable;
    const amountBeforeRounding = payable.calculated;
    const roundingAdjustment = payable.adjustment;

    const paymentResolved = await resolveCheckoutPayments(db, req.body, total);
    if (paymentResolved.error) {
      return res.status(400).json({ error: paymentResolved.error, code: "PAYMENT_ERROR" });
    }

    const {
      lines: paymentLines,
      summaryMethod,
      cashTendered,
      onAccountTotal,
      cashTotal,
      changeNis,
      changeOriginal,
      changeCurrencyId,
      changeCurrencyCode,
    } = paymentResolved;

    if (onAccountTotal > 0) {
      try {
        const party = await resolveOnAccountParty(db, {
          customerId: rawCustId,
          employeeId: rawEmpId,
        });
        custId = party.customerId;
        empId = party.employeeId;
      } catch (e) {
        if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
        throw e;
      }
      if (!custId && !empId) {
        return res.status(400).json({
          error: "اختر عميلاً أو موظفاً للبيع على الذمة",
          code: "CUSTOMER_REQUIRED",
        });
      }
    }

    // Credit + drawer checks run inside the write transaction below.

    const itemsForJson = normalized.map((L) => ({
      product_id: L.product_id,
      unit_id: L.product_unit_id,
      barcode: L.barcode,
      sku: L.sku ?? null,
      name: L.name,
      unit_name: L.unit_name,
      quantity: L.quantity,
      price: L.price,
      tax_rate: L.taxRate,
      conversion_to_base: L.conversion_to_base,
    }));

    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [req.user.id]);
    const customer = custId
      ? await db.get("SELECT name FROM customers WHERE id = ?", [custId])
      : null;

    const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, req.user.id);
    if (shiftErr || !shift) {
      return res.status(400).json({ error: shiftErr || "لا توجد وردية مفتوحة", code: "NO_OPEN_SHIFT" });
    }

    // Drawer availability is re-checked under the serialized write lock.

    if (suspendedContext && Number(suspendedContext.sale.shift_id) !== Number(shift.id)) {
      return res.status(403).json({
        error: "الفاتورة المعلقة تابعة لوردية أخرى",
        code: "SUSPENDED_SHIFT_MISMATCH",
      });
    }

    const detailed = saleTotals.lines;

    try {
      const result = await withTransaction(db, async () => {
        const resolved = await resolveCheckoutIdempotency(db, {
          key: idempotencyKey,
          fingerprint: payloadFingerprint,
          userId: req.user.id,
        });
        if (resolved.kind !== "proceed") return resolved;

        if (onAccountTotal > 0) {
          const party = await resolveOnAccountParty(db, {
            customerId: rawCustId,
            employeeId: rawEmpId,
          });
          custId = party.customerId;
          empId = party.employeeId;
          if (!custId && !empId) {
            const err = new Error("اختر عميلاً أو موظفاً للبيع على الذمة");
            err.status = 400;
            err.code = "CUSTOMER_REQUIRED";
            throw err;
          }
          const saleSnapshot = {
            itemsForJson,
            normalized,
            detailed,
            subtotal,
            tax,
            total,
            discount,
            amountBeforeRounding,
            roundingAdjustment,
            paymentLines,
            summaryMethod,
            cashTendered,
            onAccountTotal,
            cashTotal,
            changeNis,
            changeCurrencyId,
            changeOriginalAmount: changeOriginal,
            idempotencyKey,
            payloadFingerprint,
            suspendedSaleId: suspendedSaleId || null,
            promoBreakdown,
            employeeId: empId,
            notes,
          };
          const created = await createOnAccountRequest(
            db,
            {
              cashierId: req.user.id,
              shiftId: shift.id,
              custId,
              employeeId: empId,
              saleSnapshot,
              totals: {
                subtotal,
                tax,
                total,
                amountBeforeRounding,
                roundingAdjustment,
                onAccountTotal,
                summaryMethod,
              },
              req,
              notes,
              idempotencyKey,
              payloadFingerprint,
            },
            { inTransaction: true, skipTelegram: true }
          );
          return { kind: "oa_created", created };
        }

        const creditErr = await validateCustomerCredit(db, custId, onAccountTotal);
        if (creditErr) {
          const err = new Error(creditErr.error);
          err.status = creditErr.status;
          err.code = creditErr.code;
          throw err;
        }
        const changeErr = await assertDrawerCanGiveChange(db, shift.id, shift.opening_cash, paymentLines, {
          changeOriginal,
          changeNis,
          changeCurrencyCode,
        });
        if (changeErr) {
          const err = new Error(changeErr.error);
          err.status = 400;
          err.code = changeErr.code;
          throw err;
        }
        const sale = await executeCheckoutSale(db, {
        cashierId: req.user.id,
        shiftId: shift.id,
        custId,
        itemsForJson,
        normalized,
        detailed,
        subtotal,
        tax,
        total,
        discount,
        amountBeforeRounding,
        roundingAdjustment,
        paymentLines,
        summaryMethod,
        onAccountTotal,
        cashTotal,
        changeNis,
        changeCurrencyId,
        changeOriginalAmount: changeOriginal,
        idempotencyKey,
        payloadFingerprint,
        suspendedSaleId: suspendedSaleId || null,
        promoBreakdown,
        employeeId: empId,
        }, { inTransaction: true });
        if (sale.replayTxId) return { kind: "sale", transactionId: sale.replayTxId };
        return { kind: "sale_created", sale };
      });

      if (result.kind === "sale") {
        return res.status(200).json(await buildResponseFromTransaction(result.transactionId, settings));
      }
      if (result.kind === "oa_pending") {
        return res.status(202).json({
          pending_approval: true,
          request_id: result.requestId,
          message: "سُجّل طلب البيع على الذمة قيد المراجعة. لن يُكمَل البيع حتى موافقة المسؤول.",
          telegram: false,
          idempotent_replay: true,
        });
      }
      if (result.kind === "oa_created") {
        const telegramMessageId = await notifyOnAccountRequestTelegram(
          db,
          result.created,
          req.user.id,
          custId
        );
        return res.status(202).json({
          pending_approval: true,
          request_id: result.created.request_id,
          message: result.created.message || "سُجّل طلب البيع على الذمة قيد المراجعة. لن يُكمَل البيع حتى موافقة المسؤول.",
          telegram: !!telegramMessageId,
        });
      }

      const { transactionId, receiptNumber } = result.sale;
      const row = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
      const receiptLines = normalized.map((L, i) => ({
        name: L.unit_name ? `${L.name} (${L.unit_name})` : L.name,
        sku: L.sku ?? null,
        quantity: L.quantity,
        price: L.price,
        lineTotal: detailed[i].lineGross,
        weighed: L.is_weighed,
      }));
      const { receipt_text, receipt_html } = buildReceiptPayload({
        transactionId,
        receiptNumber,
        timestamp: row.created_at,
        cashierName: cashier?.username || "",
        customerName: customer?.name || "",
        lines: receiptLines,
        subtotal,
        tax,
        discount,
        total,
        roundingAdjustment,
        paymentMethod: summaryMethod,
        payments: paymentLines,
        cashTendered,
        changeNis,
        settings,
        partyBalance: await partyBalanceForSale(db, {
          customerId: custId,
          payments: paymentLines,
          transactionId,
          status: "posted",
        }),
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
        amount_before_rounding: amountBeforeRounding,
        rounding_adjustment: roundingAdjustment,
        payment_method: summaryMethod,
        payments: paymentLines,
        timestamp: row.created_at,
        cashier: cashier?.username || "",
        receipt_text,
        receipt_html,
      });
    } catch (e) {
      if (e?.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      if (
        idempotencyKey &&
        e &&
        String(e.code || "").startsWith("SQLITE_CONSTRAINT") &&
        /idempotency/i.test(String(e.message || ""))
      ) {
        try {
          const existing = await resolveCheckoutIdempotency(db, {
            key: idempotencyKey,
            fingerprint: payloadFingerprint,
            userId: req.user.id,
          });
          if (existing.kind === "sale") {
            return res.status(200).json(await buildResponseFromTransaction(existing.transactionId, settings));
          }
          if (existing.kind === "oa_pending") {
            return res.status(202).json({
              pending_approval: true,
              request_id: existing.requestId,
              message: "سُجّل طلب البيع على الذمة قيد المراجعة. لن يُكمَل البيع حتى موافقة المسؤول.",
              telegram: false,
              idempotent_replay: true,
            });
          }
        } catch (replayErr) {
          if (replayErr?.status) {
            return res.status(replayErr.status).json({ error: replayErr.message, code: replayErr.code });
          }
        }
      }
      next(e);
    }
  });

  return router;
}
