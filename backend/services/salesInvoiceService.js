import { round2, applyPurchaseDiscount, computeSaleTotals, productTaxRate } from "../utils/tax.js";
import { getAppSettings } from "../utils/settings.js";
import { getDefaultUnit } from "../utils/productUnits.js";
import { recordMovement } from "../utils/inventory.js";
import { nextReceiptNumber } from "../utils/receiptNumber.js";
import { resolveInvoicePayments, insertSalePayments } from "../utils/salePayments.js";
import { shopTodayYmd } from "../utils/shopTime.js";

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

async function nextInvoiceNo(db) {
  const row = await db.get("SELECT MAX(invoice_no) AS mx FROM sales_invoices");
  return (Number(row?.mx) || 0) + 1;
}

async function resolveSaleUnit(db, productId, unitId) {
  if (unitId) {
    const unit = await db.get(
      "SELECT id, unit_name, conversion_to_base, price FROM product_units WHERE id = ? AND product_id = ?",
      [unitId, productId]
    );
    if (unit) {
      return {
        id: unit.id,
        unit_name: unit.unit_name,
        conversion: Math.max(0.0001, Number(unit.conversion_to_base) || 1),
        unit_price: Number(unit.price) || 0,
      };
    }
  }
  const saleDefault = await db.get(
    `SELECT id, unit_name, conversion_to_base, price FROM product_units
     WHERE product_id = ? AND sale_enabled = 1
     ORDER BY is_default DESC, id ASC LIMIT 1`,
    [productId]
  );
  if (saleDefault) {
    return {
      id: saleDefault.id,
      unit_name: saleDefault.unit_name,
      conversion: Math.max(0.0001, Number(saleDefault.conversion_to_base) || 1),
      unit_price: Number(saleDefault.price) || 0,
    };
  }
  const def = await getDefaultUnit(db, productId);
  if (def) {
    return {
      id: def.id,
      unit_name: def.unit_name,
      conversion: Math.max(0.0001, Number(def.conversion_to_base) || 1),
      unit_price: Number(def.price) || 0,
    };
  }
  const product = await db.get("SELECT price FROM products WHERE id = ?", [productId]);
  return { id: null, unit_name: null, conversion: 1, unit_price: Number(product?.price) || 0 };
}

export async function normalizeSaleItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const settings = await getAppSettings(db);
  const out = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity);
    if (!pid || !Number.isFinite(qty) || qty <= 0) return null;

    const product = await db.get("SELECT * FROM products WHERE id = ?", [pid]);
    if (!product) return null;

    const rawUnitId = it.unit_id != null ? Number(it.unit_id) : it.product_unit_id != null ? Number(it.product_unit_id) : null;
    const unit = await resolveSaleUnit(db, pid, rawUnitId);

    const hasTotal = it.total_price != null && it.total_price !== "";
    const listGross = hasTotal
      ? round2(Number(it.total_price) || 0)
      : round2((Number(it.unit_price) || unit.unit_price || Number(product.price) || 0) * qty);

    const discountPct = Math.min(100, Math.max(0, Number(it.discount_pct) || 0));
    const bonusQty = Math.max(0, Number(it.bonus_quantity) || 0);
    const baseQuantity = round6((qty + bonusQty) * unit.conversion);
    const payableGross = applyPurchaseDiscount(listGross, discountPct);
    const unitPrice = qty > 0 ? round2(payableGross / qty) : 0;
    const taxRate = productTaxRate(product, settings);

    out.push({
      product_id: pid,
      product,
      quantity: qty,
      total_price: listGross,
      unit_price: unitPrice,
      product_unit_id: unit.id,
      unit_name: unit.unit_name,
      conversion_used: unit.conversion,
      base_quantity: baseQuantity,
      discount_pct: discountPct,
      bonus_quantity: bonusQty,
      taxRate,
      payableGross,
      barcode: product.barcode,
      name: product.name,
      cost: Number(product.cost) || 0,
    });
  }
  return out;
}

export async function computeSalesInvoiceTotals(db, norm) {
  const settings = await getAppSettings(db);
  const saleLines = norm.map((line) => ({
    quantity: line.quantity,
    unitPrice: line.unit_price,
    taxRate: line.taxRate,
  }));
  const { subtotal, tax, total, lines } = computeSaleTotals(saleLines, settings);
  const detailed = norm.map((line, i) => ({
    ...line,
    vat_rate: line.taxRate,
    line_net: lines[i].lineNet,
    line_tax: lines[i].lineTax,
    line_total: lines[i].lineGross,
  }));
  return { subtotal, tax, total, lines: detailed };
}

async function insertInvoiceItems(db, invoiceId, lines) {
  for (const i of lines) {
    await db.run(
      `INSERT INTO sales_invoice_items
         (invoice_id, product_id, quantity, total_price, unit_price, vat_rate, line_net, line_tax, line_total,
          product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        i.product_id,
        i.quantity,
        i.total_price,
        i.unit_price,
        i.vat_rate,
        i.line_net,
        i.line_tax,
        i.line_total,
        i.product_unit_id,
        i.unit_name,
        i.conversion_used,
        i.base_quantity,
        i.discount_pct,
        i.bonus_quantity,
      ]
    );
  }
}

export async function createSalesInvoiceDraft(db, body, userId) {
  const { customer_id, ref_text, invoice_date, notes, items } = body || {};
  const cid = Number(customer_id);
  if (!cid) return { error: "العميل مطلوب", status: 400 };
  const norm = await normalizeSaleItems(db, items);
  if (!norm) return { error: "أصناف غير صالحة", status: 400 };
  const { subtotal, tax, total, lines } = await computeSalesInvoiceTotals(db, norm);

  await db.run("BEGIN IMMEDIATE");
  try {
    const no = await nextInvoiceNo(db);
    const ins = await db.run(
      `INSERT INTO sales_invoices
         (invoice_no, customer_id, ref_text, invoice_date, status, subtotal, tax, total, notes, created_by)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [
        no,
        cid,
        ref_text || null,
        invoice_date || shopTodayYmd(),
        subtotal,
        tax,
        total,
        notes || null,
        userId,
      ]
    );
    await insertInvoiceItems(db, ins.lastID, lines);
    await db.run("COMMIT");
    return { row: await db.get("SELECT * FROM sales_invoices WHERE id = ?", [ins.lastID]) };
  } catch (e) {
    try { await db.run("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

export async function updateSalesInvoiceDraft(db, invoiceId, body) {
  const inv = await db.get("SELECT * FROM sales_invoices WHERE id = ?", [invoiceId]);
  if (!inv) return { error: "الفاتورة غير موجودة", status: 404 };
  if (inv.status === "posted") return { error: "لا يمكن تعديل فاتورة مرحّلة", status: 400 };

  const { customer_id, ref_text, invoice_date, notes, items } = body || {};
  const cid = Number(customer_id);
  if (!cid) return { error: "العميل مطلوب", status: 400 };
  const norm = await normalizeSaleItems(db, items);
  if (!norm) return { error: "أصناف غير صالحة", status: 400 };
  const { subtotal, tax, total, lines } = await computeSalesInvoiceTotals(db, norm);

  await db.run("BEGIN IMMEDIATE");
  try {
    await db.run(
      `UPDATE sales_invoices
         SET customer_id = ?, ref_text = ?, invoice_date = ?, notes = ?, subtotal = ?, tax = ?, total = ?
       WHERE id = ?`,
      [cid, ref_text || null, invoice_date || inv.invoice_date, notes || null, subtotal, tax, total, inv.id]
    );
    await db.run("DELETE FROM sales_invoice_items WHERE invoice_id = ?", [inv.id]);
    await insertInvoiceItems(db, inv.id, lines);
    await db.run("COMMIT");
    return { row: await db.get("SELECT * FROM sales_invoices WHERE id = ?", [inv.id]) };
  } catch (e) {
    try { await db.run("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

export async function postSalesInvoice(db, invoiceId, body, userId) {
  const inv = await db.get("SELECT * FROM sales_invoices WHERE id = ?", [invoiceId]);
  if (!inv) return { error: "الفاتورة غير موجودة", status: 404 };
  if (inv.status === "posted") return { error: "الفاتورة مرحّلة بالفعل", status: 400 };

  const items = await db.all(
    `SELECT sii.*, p.name, p.barcode, p.cost, p.tax_rate
     FROM sales_invoice_items sii
     JOIN products p ON p.id = sii.product_id
     WHERE sii.invoice_id = ?`,
    [inv.id]
  );
  if (items.length === 0) return { error: "لا توجد أصناف", status: 400 };

  for (const it of items) {
    const stock = Number((await db.get("SELECT stock FROM products WHERE id = ?", [it.product_id]))?.stock) || 0;
    const need = it.base_quantity != null ? Number(it.base_quantity) : Number(it.quantity) || 0;
    if (stock < need) {
      return { error: `مخزون غير كافٍ للصنف: ${it.name}`, status: 400 };
    }
  }

  const paymentResolved = await resolveInvoicePayments(db, body || {}, inv.total);
  if (paymentResolved.error) return { error: paymentResolved.error, status: 400 };

  const {
    lines: paymentLines,
    summaryMethod,
    onAccountTotal,
    changeNis,
  } = paymentResolved;

  const receiptNumber = await nextReceiptNumber(db, 1);
  const itemsForJson = items.map((it) => ({
    product_id: it.product_id,
    name: it.name,
    barcode: it.barcode,
    quantity: it.quantity,
    price: it.unit_price,
    unit_name: it.unit_name,
  }));

  await db.run("BEGIN IMMEDIATE");
  try {
    const ins = await db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, change_amount, payment_method, shift_id, customer_id, receipt_number, status, store_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, 'completed', 1)`,
      [
        userId,
        JSON.stringify(itemsForJson),
        inv.subtotal,
        inv.tax,
        inv.total,
        round2(changeNis || 0),
        summaryMethod,
        inv.customer_id,
        receiptNumber,
      ]
    );
    const transactionId = ins.lastID;

    for (const it of items) {
      const stockDelta = it.base_quantity != null ? Number(it.base_quantity) : Number(it.quantity) || 0;
      const grossProfit = round2((Number(it.line_net) || 0) - (Number(it.cost) || 0) * stockDelta);
      await db.run(
        `INSERT INTO transaction_items
           (transaction_id, product_id, barcode, name, quantity, unit_price, line_net, line_tax, line_gross, tax_rate,
            unit_cost_at_sale, gross_profit, discount_at_sale, product_unit_id, unit_name, conversion_to_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          it.product_id,
          it.barcode,
          it.name,
          it.quantity,
          it.unit_price,
          it.line_net,
          it.line_tax,
          it.line_total,
          it.vat_rate,
          it.cost,
          grossProfit,
          it.discount_pct || 0,
          it.product_unit_id,
          it.unit_name,
          it.conversion_used,
        ]
      );
      await recordMovement(db, {
        productId: it.product_id,
        movementType: "sale",
        quantity: -stockDelta,
        refType: "sales_invoice",
        refId: inv.id,
        notes: `فتورة مبيعات #${inv.invoice_no ?? inv.id}`,
        userId,
        applyStock: true,
      });
    }

    await insertSalePayments(db, transactionId, paymentLines);

    for (const line of paymentLines) {
      const nis = round2(line.nis_equivalent);
      await db.run(
        `INSERT INTO sales_invoice_payments
           (invoice_id, payment_method, amount, currency_id, original_amount, exchange_rate_used, nis_equivalent, bank_name, check_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inv.id,
          line.method,
          nis,
          line.currency_id ?? null,
          line.original_amount,
          line.exchange_rate_used,
          nis,
          line.bank_name ?? null,
          line.check_no ?? null,
        ]
      );
    }

    if (onAccountTotal > 0) {
      await db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [onAccountTotal, inv.customer_id]);
    }

    await db.run(
      `UPDATE sales_invoices
         SET status = 'posted', posted_at = datetime('now'), transaction_id = ?,
             payment_method = ?, on_account_amount = ?
       WHERE id = ?`,
      [transactionId, summaryMethod, onAccountTotal, inv.id]
    );

    await db.run("COMMIT");
    return { row: await db.get("SELECT * FROM sales_invoices WHERE id = ?", [inv.id]) };
  } catch (e) {
    try { await db.run("ROLLBACK"); } catch (_) {}
    throw e;
  }
}
