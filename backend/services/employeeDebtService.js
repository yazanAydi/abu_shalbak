import { round2, sumMoney } from "../utils/money.js";
import { shopDaySqlBounds, shopTodayYmd, shopYmdFromTimestamp, sqlUtcTimestampExpr } from "../utils/shopTime.js";
import { shopBusinessDayYmd } from "../utils/businessDay.js";
import { badRequest, notFound } from "../utils/httpError.js";
import { withTransaction } from "../utils/dbTx.js";
import { applyVoucherPostEffects } from "../routes/vouchers.js";
import { loadSaleReceipt } from "../routes/print.js";
import { requireEmployee } from "./employeeService.js";
import { getSalesInvoiceDetail } from "./salesInvoiceService.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

const employeeDebtLocks = new Map();

/**
 * Serialize competing collection on the same customer (payroll settlement vs
 * direct repayment, retries, overlapping HTTP handlers) before the SQLite tx.
 */
export function withEmployeeDebtLock(customerId, fn) {
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) return fn();
  const prev = employeeDebtLocks.get(cid) || Promise.resolve();
  const gate = prev.then(
    () => {},
    () => {}
  );
  const result = gate.then(fn);
  employeeDebtLocks.set(
    cid,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}

function inRange(ymd, from, to) {
  if (from && ymd < from) return false;
  if (to && ymd > to) return false;
  return true;
}

async function settledBySource(db, sourceType, sourceId, asOf) {
  const row = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM employee_settlements
     WHERE kind = 'debt' AND source_type = ? AND source_id = ? AND status = 'active'
       AND (? IS NULL OR occurred_on <= ?)`,
    [sourceType, sourceId, asOf, asOf]
  );
  return round2(Number(row?.total) || 0);
}

async function debtSettlementHistory(db, sourceType, sourceId, asOf) {
  const rows = await db.all(
    `SELECT s.occurred_on, s.amount, s.payout_id, p.ledger_entry_id
     FROM employee_settlements s
     LEFT JOIN employee_payroll_payouts p ON p.id = s.payout_id
     WHERE s.kind = 'debt' AND s.source_type = ? AND s.source_id = ? AND s.status = 'active'
       AND (? IS NULL OR s.occurred_on <= ?)
     ORDER BY s.occurred_on ASC, s.id ASC`,
    [sourceType, sourceId, asOf, asOf]
  );
  return rows.map((row) => ({
    date: row.occurred_on,
    amount: round2(Number(row.amount) || 0),
    payout_id: row.payout_id,
    salary_payment_id: row.ledger_entry_id || null,
  }));
}

async function productLinesForSale(db, transactionId) {
  const rows = await db.all(
    `SELECT name, quantity, unit_price, line_gross
     FROM transaction_items WHERE transaction_id = ? ORDER BY id`,
    [transactionId]
  );
  return rows.map((row) => ({
    name: row.name,
    quantity: Number(row.quantity) || 0,
    unit_price: round2(Number(row.unit_price) || 0),
    line_gross: round2(Number(row.line_gross) || 0),
  }));
}

async function productLinesForInvoice(db, invoiceId) {
  const rows = await db.all(
    `SELECT COALESCE(p.name, i.unit_name, 'صنف') AS name, i.quantity, i.unit_price, i.line_total
     FROM sales_invoice_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.invoice_id = ?
     ORDER BY i.id`,
    [invoiceId]
  );
  return rows.map((row) => ({
    name: row.name,
    quantity: Number(row.quantity) || 0,
    unit_price: round2(Number(row.unit_price) || 0),
    line_gross: round2(Number(row.line_total) || 0),
  }));
}

/**
 * Invoice-level employee debts reuse the linked customer's canonical on-account
 * sales / office invoices. Remaining = original − refunds − payroll settlements,
 * then unallocated customer credits (vouchers + balance gap) applied FIFO so
 * outstanding stays aligned with customers.balance.
 */
export async function listEmployeeDebts(db, emp, { from = null, to = null, asOf = null } = {}) {
  const asOfDay = asOf || to || null;
  const empId = Number(emp.id);
  const currentCustomerId = emp.customer_id ? Number(emp.customer_id) : null;

  const posSales = await db.all(
    `SELECT t.id, t.created_at, t.receipt_number, t.payment_method, t.total, t.customer_id, t.employee_id, t.notes,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS start_time,
            COALESCE(
              (SELECT SUM(sp.amount) FROM sale_payments sp
                WHERE sp.transaction_id = t.id AND sp.payment_method = 'on_account'),
              CASE WHEN t.payment_method = 'on_account' THEN t.total ELSE 0 END
            ) AS original
     FROM transactions t
     LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id
     WHERE COALESCE(t.status, 'completed') = 'completed'
       AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.transaction_id = t.id)
       AND t.employee_id = ?
       AND (
         t.payment_method = 'on_account'
         OR EXISTS (
           SELECT 1 FROM sale_payments sp
           WHERE sp.transaction_id = t.id AND sp.payment_method = 'on_account'
         )
       )
     ORDER BY datetime(t.created_at) ASC, t.id ASC`,
    [empId]
  );

  const officeInvoices = currentCustomerId
    ? await db.all(
        `SELECT si.id, si.invoice_date, si.invoice_no, si.ref_text, si.on_account_amount, si.transaction_id, si.customer_id, si.notes
         FROM sales_invoices si
         WHERE si.customer_id = ? AND si.status = 'posted' AND si.on_account_amount > 0
         ORDER BY si.invoice_date ASC, si.id ASC`,
        [currentCustomerId]
      )
    : [];

  const invoices = [];
  for (const row of posSales) {
    const original = round2(Number(row.original) || 0);
    if (original <= 0) continue;
    const ymd = shopBusinessDayYmd(row) || shopYmdFromTimestamp(row.created_at);
    const refund = await db.get(
      `SELECT COALESCE(SUM(total), 0) AS total
       FROM refunds
       WHERE original_transaction_id = ? AND COALESCE(status, 'approved') = 'approved'
         AND (? IS NULL OR ${sqlUtcTimestampExpr("created_at")} <= datetime(?))`,
      [row.id, asOfDay, asOfDay ? shopDaySqlBounds(asOfDay).endSql : null]
    );
    const refunded = round2(Number(refund?.total) || 0);
    const afterAsOf = Boolean(asOfDay && ymd > asOfDay);
    const settlements = afterAsOf ? [] : await debtSettlementHistory(db, "pos_sale", row.id, asOfDay);
    const settled = afterAsOf ? 0 : await settledBySource(db, "pos_sale", row.id, asOfDay);
    const products = await productLinesForSale(db, row.id);
    invoices.push({
      source_type: "pos_sale",
      source_id: row.id,
      customer_id: row.customer_id ? Number(row.customer_id) : null,
      employee_id: row.employee_id ? Number(row.employee_id) : null,
      date: ymd,
      invoice_no: row.receipt_number || null,
      description: products.map((p) => p.name).filter(Boolean).join("، ") || "فاتورة ذمة",
      notes: row.notes || null,
      products,
      original,
      refunded: afterAsOf ? 0 : refunded,
      settled,
      settlements,
      remaining_raw: afterAsOf ? 0 : round2(Math.max(0, original - refunded - settled)),
      href: `/shift-audit?tx=${row.id}`,
    });
  }

  for (const row of officeInvoices) {
    const original = round2(Number(row.on_account_amount) || 0);
    if (original <= 0) continue;
    const ymd = String(row.invoice_date).slice(0, 10);
    let refunded = 0;
    if (row.transaction_id) {
      const refund = await db.get(
        `SELECT COALESCE(SUM(total), 0) AS total
         FROM refunds
         WHERE original_transaction_id = ? AND COALESCE(status, 'approved') = 'approved'
           AND (? IS NULL OR ${sqlUtcTimestampExpr("created_at")} <= datetime(?))`,
        [row.transaction_id, asOfDay, asOfDay ? shopDaySqlBounds(asOfDay).endSql : null]
      );
      refunded = round2(Number(refund?.total) || 0);
    }
    const afterAsOf = Boolean(asOfDay && ymd > asOfDay);
    const settlements = afterAsOf ? [] : await debtSettlementHistory(db, "sales_invoice", row.id, asOfDay);
    const settled = afterAsOf ? 0 : await settledBySource(db, "sales_invoice", row.id, asOfDay);
    const products = await productLinesForInvoice(db, row.id);
    invoices.push({
      source_type: "sales_invoice",
      source_id: row.id,
      customer_id: row.customer_id ? Number(row.customer_id) : currentCustomerId,
      employee_id: null,
      date: ymd,
      invoice_no: row.invoice_no != null ? String(row.invoice_no) : row.ref_text || null,
      description: products.map((p) => p.name).filter(Boolean).join("، ") || "فاتورة مبيعات ذمة",
      notes: row.notes || null,
      products,
      original,
      refunded: afterAsOf ? 0 : refunded,
      settled,
      settlements,
      remaining_raw: afterAsOf ? 0 : round2(Math.max(0, original - refunded - settled)),
      href: `/sales-invoices?id=${row.id}`,
    });
  }

  invoices.sort((a, b) => (a.date === b.date ? a.source_id - b.source_id : a.date < b.date ? -1 : 1));

  const customerIds = [...new Set(invoices.map((inv) => inv.customer_id).filter(Boolean))];
  const liveByCustomer = new Map();
  for (const cid of customerIds) {
    const customer = await db.get("SELECT balance FROM customers WHERE id = ?", [cid]);
    liveByCustomer.set(cid, round2(Number(customer?.balance) || 0));
  }
  const asOfIsCurrent = !asOfDay || asOfDay >= shopTodayYmd();
  const decorated = [];
  const grouped = new Map();
  for (const inv of invoices) {
    const key = inv.customer_id || 0;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(inv);
  }
  for (const [cid, list] of grouped) {
    const liveBalance = cid ? liveByCustomer.get(cid) || 0 : 0;
    const rawSum = round2(sumMoney(list.map((inv) => inv.remaining_raw)));
    let unallocated = asOfIsCurrent && cid ? round2(Math.max(0, rawSum - liveBalance)) : 0;
    for (const inv of list) {
      const take = round2(Math.min(inv.remaining_raw, unallocated));
      unallocated = round2(unallocated - take);
      const remaining = round2(inv.remaining_raw - take);
      decorated.push({
        ...inv,
        other_repayments: take,
        remaining,
        selectable: remaining > 0,
      });
    }
  }
  decorated.sort((a, b) => (a.date === b.date ? a.source_id - b.source_id : a.date < b.date ? -1 : 1));

  const liveBalance = currentCustomerId ? liveByCustomer.get(currentCustomerId) ?? null : null;
  const inPeriod = decorated.filter((inv) => inRange(inv.date, from, to));
  return {
    linked: Boolean(currentCustomerId) || decorated.length > 0,
    customer_id: currentCustomerId,
    customer_name: emp.customer_name || null,
    customer_code: emp.customer_code || null,
    customer_balance: liveBalance,
    invoices: decorated,
    period_invoices: inPeriod,
    period_original_total: round2(sumMoney(inPeriod.map((inv) => inv.original))),
    period_outstanding_total: round2(sumMoney(inPeriod.map((inv) => inv.remaining))),
    outstanding_as_of: round2(sumMoney(decorated.map((inv) => inv.remaining))),
  };
}

async function findEmployeePosDebtSale(db, emp, transactionId) {
  return db.get(
    `SELECT t.id, t.receipt_number
     FROM transactions t
     WHERE t.id = ?
       AND COALESCE(t.status, 'completed') = 'completed'
       AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.transaction_id = t.id)
       AND t.employee_id = ?
       AND (
         t.payment_method = 'on_account'
         OR EXISTS (
           SELECT 1 FROM sale_payments sp
           WHERE sp.transaction_id = t.id AND sp.payment_method = 'on_account'
         )
       )`,
    [transactionId, emp.id]
  );
}

async function findEmployeeOfficeDebtInvoice(db, emp, invoiceId) {
  const customerId = emp.customer_id ? Number(emp.customer_id) : null;
  if (!customerId) return null;
  return db.get(
    `SELECT si.id, si.invoice_no, si.transaction_id
     FROM sales_invoices si
     WHERE si.id = ? AND si.customer_id = ? AND si.status = 'posted' AND si.on_account_amount > 0`,
    [invoiceId, customerId]
  );
}

async function posReceiptPayload(db, transactionId, invoiceNo) {
  try {
    const receipt = await loadSaleReceipt(db, transactionId);
    if (!receipt) throw notFound("الفاتورة غير موجودة");
    return {
      kind: "pos_receipt",
      invoice_no: invoiceNo || null,
      receipt_html: receipt.receipt_html,
      receipt_text: receipt.receipt_text,
      transaction_id: receipt.transaction_id,
    };
  } catch (e) {
    if (e.code === "BAD_ITEMS") throw badRequest("بيانات العملية غير صالحة", "BAD_ITEMS");
    throw e;
  }
}

/**
 * Printable receipt for a ذمة invoice already shown on the employee statement.
 * POS sales use the thermal receipt; posted office invoices prefer the linked POS
 * receipt and fall back to the A4 sales-invoice document.
 */
export async function getEmployeeInvoiceReceipt(db, employeeId, sourceType, sourceId) {
  const emp = await requireEmployee(db, employeeId);
  const type = String(sourceType || "").trim();
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("رقم الفاتورة غير صالح");
  if (type !== "pos_sale" && type !== "sales_invoice") {
    throw badRequest("نوع الفاتورة غير صالح");
  }

  if (type === "pos_sale") {
    const sale = await findEmployeePosDebtSale(db, emp, id);
    if (!sale) throw notFound("الفاتورة غير موجودة");
    return posReceiptPayload(db, sale.id, sale.receipt_number || null);
  }

  const invoice = await findEmployeeOfficeDebtInvoice(db, emp, id);
  if (!invoice) throw notFound("الفاتورة غير موجودة");
  if (invoice.transaction_id) {
    try {
      return await posReceiptPayload(
        db,
        Number(invoice.transaction_id),
        invoice.invoice_no != null ? String(invoice.invoice_no) : null
      );
    } catch (e) {
      if (e.code !== "BAD_ITEMS" && e.code !== "NOT_FOUND") throw e;
    }
  }

  const detail = await getSalesInvoiceDetail(db, invoice.id);
  if (!detail) throw notFound("الفاتورة غير موجودة");
  return {
    kind: "sales_invoice",
    invoice_no: detail.invoice_no != null ? String(detail.invoice_no) : invoice.invoice_no != null ? String(invoice.invoice_no) : null,
    invoice: detail,
  };
}

export async function applyCustomerDebtDeltaInTx(db, customerId, amount) {
  const delta = round2(Number(amount));
  if (!customerId || !(delta > 0)) return 0;
  const row = await db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
  const live = round2(Number(row?.balance) || 0);
  const applied = round2(Math.min(delta, Math.max(0, live)));
  if (!(applied > 0.009)) return 0;
  await db.run("UPDATE customers SET balance = balance - ? WHERE id = ?", [applied, customerId]);
  return applied;
}

const PAY_METHOD_AR = {
  cash: "نقد",
  transfer: "تحويل",
  check: "شيك",
  other: "أخرى",
};

function voucherLineType(paymentMethod) {
  if (paymentMethod === "check") return "check";
  if (paymentMethod === "transfer") return "bank";
  return "cash";
}

/**
 * Posted receipt vouchers on the employee's debt customer.
 */
export async function listEmployeeDebtRepayments(db, emp, { from = null, to = null } = {}) {
  const customerId = emp.customer_id ? Number(emp.customer_id) : null;
  if (!customerId) {
    return { items: [], period_items: [], period_total: 0 };
  }
  const rows = await db.all(
    `SELECT v.id, v.voucher_date, v.voucher_no, v.notes, vl.amount_nis, vl.line_type, vl.description
     FROM voucher_lines vl
     JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.customer_id = ? AND v.voucher_type = 'receipt' AND v.status = 'posted'
     ORDER BY v.voucher_date ASC, v.id ASC`,
    [customerId]
  );
  const items = rows.map((row) => {
    const method =
      row.line_type === "check" ? "check" : row.line_type === "bank" ? "transfer" : "cash";
    return {
      id: row.id,
      date: String(row.voucher_date || "").slice(0, 10),
      amount: round2(Number(row.amount_nis) || 0),
      payment_method: method,
      payment_method_label: PAY_METHOD_AR[method] || method,
      voucher_no: row.voucher_no ?? null,
      notes: row.notes || row.description || null,
    };
  });
  const period_items = items.filter((row) => {
    if (from && row.date < from) return false;
    if (to && row.date > to) return false;
    return true;
  });
  return {
    items,
    period_items,
    period_total: round2(sumMoney(period_items.map((row) => row.amount))),
  };
}

/**
 * Canonical cash/bank/check collection against the same customers.balance
 * as payroll settlements. Caps at the live remaining inside the write tx.
 */
export async function postEmployeeDebtRepayment(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  if (!emp.customer_id) {
    throw badRequest("لا يوجد حساب ذمة مربوط بهذا الموظف", "EMPLOYEE_CUSTOMER_REQUIRED");
  }
  const amount = round2(Number(body?.amount));
  if (!Number.isFinite(amount) || !(amount > 0)) {
    throw badRequest("المبلغ غير صالح");
  }
  const paymentMethod = String(body?.payment_method || "").trim();
  if (!["cash", "transfer", "check", "other"].includes(paymentMethod)) {
    throw badRequest("طريقة الدفع غير صالحة");
  }
  const occurredOn = String(body?.occurred_on || shopTodayYmd()).slice(0, 10);
  const idempotencyKey =
    body?.idempotency_key != null && String(body.idempotency_key).trim()
      ? String(body.idempotency_key).trim()
      : null;
  const noteTag = idempotencyKey ? `EMP-DEBT-PAY:${idempotencyKey}` : null;
  const reference = body?.reference_note != null && String(body.reference_note).trim()
    ? String(body.reference_note).trim().slice(0, 500)
    : "تسديد ذمة موظف";
  const notes = noteTag ? `${noteTag} — ${reference}` : reference;
  const lineType = voucherLineType(paymentMethod);

  const created = await withEmployeeDebtLock(emp.customer_id, () =>
    withTransaction(db, async () => {
    if (noteTag) {
      const raced = await db.get(
        `SELECT v.* FROM vouchers v
         JOIN voucher_lines vl ON vl.voucher_id = v.id
         WHERE v.voucher_type = 'receipt' AND vl.customer_id = ? AND v.notes LIKE ?
         ORDER BY v.id DESC LIMIT 1`,
        [emp.customer_id, `${noteTag}%`]
      );
      if (raced) return { voucher: raced, replay: true };
    }

    await db.run("UPDATE customers SET balance = COALESCE(balance, 0) WHERE id = ?", [
      emp.customer_id,
    ]);
    const customer = await db.get("SELECT id, balance FROM customers WHERE id = ?", [emp.customer_id]);
    const remaining = round2(Math.max(0, Number(customer?.balance) || 0));
    if (remaining < 0.009) {
      throw badRequest("لا يوجد متبقي على الذمة", "NO_REMAINING_DEBT");
    }
    if (amount - remaining > 0.009) {
      throw badRequest(`المبلغ أكبر من المتبقي (₪${remaining.toFixed(2)})`, "AMOUNT_EXCEEDS_REMAINING");
    }

    const ins = await db.run(
      `INSERT INTO vouchers (voucher_type, voucher_date, notes, total_amount, recorded_by_id, status)
       VALUES ('receipt', ?, ?, ?, ?, 'draft')`,
      [occurredOn, notes, amount, req?.user?.id ?? null]
    );
    const voucherId = ins.lastID;
    const maxNo = await db.get(
      "SELECT MAX(voucher_no) AS mx FROM vouchers WHERE voucher_type = 'receipt'"
    );
    await db.run("UPDATE vouchers SET voucher_no = ? WHERE id = ?", [
      ((maxNo?.mx) || 0) + 1,
      voucherId,
    ]);
    await db.run(
      `INSERT INTO voucher_lines
         (voucher_id, line_type, amount, currency, exchange_rate, amount_nis,
          customer_id, description)
       VALUES (?, ?, ?, 'NIS', 1, ?, ?, ?)`,
      [voucherId, lineType, amount, amount, emp.customer_id, "تسديد ذمة موظف"]
    );
    const voucher = await db.get("SELECT * FROM vouchers WHERE id = ?", [voucherId]);
    const lines = await db.all("SELECT * FROM voucher_lines WHERE voucher_id = ?", [voucherId]);
    await applyVoucherPostEffects(db, voucher, lines);
    return { voucher: await db.get("SELECT * FROM vouchers WHERE id = ?", [voucherId]), replay: false };
  })
  );

  const live = await db.get("SELECT balance FROM customers WHERE id = ?", [emp.customer_id]);
  if (req && created?.voucher?.id && !created.replay) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_DEBT_PAYMENT, "vouchers", created.voucher.id, null, {
      employee_id: emp.id,
      customer_id: emp.customer_id,
      amount,
      payment_method: paymentMethod,
    });
  }
  return {
    id: created.voucher.id,
    voucher_id: created.voucher.id,
    voucher_no: created.voucher.voucher_no ?? null,
    amount: round2(Number(created.voucher.total_amount) || amount),
    occurred_on: created.voucher.voucher_date,
    payment_method: paymentMethod,
    payment_method_label: PAY_METHOD_AR[paymentMethod] || paymentMethod,
    customer_id: emp.customer_id,
    remaining_after: round2(Number(live?.balance) || 0),
    replay: Boolean(created.replay),
  };
}
