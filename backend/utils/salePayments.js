import { round2 } from "./tax.js";

const ALLOWED = ["cash", "visa", "on_account"];
const TOLERANCE = 0.005;

/**
 * Resolve and validate checkout payment lines against server-computed total.
 * @returns {{ lines?: Array<{method:string, amount:number}>, summaryMethod?: string, cashTendered?: number|null, onAccountTotal?: number, cashTotal?: number, error?: string }}
 */
export function resolveCheckoutPayments(body, computedTotal) {
  const total = round2(computedTotal);
  const cashTendered =
    body.cash_tendered != null && body.cash_tendered !== ""
      ? round2(Number(body.cash_tendered))
      : null;

  let lines = [];

  if (Array.isArray(body.payments) && body.payments.length > 0) {
    for (const p of body.payments) {
      const method = p.method;
      const amount = round2(Number(p.amount));
      if (!ALLOWED.includes(method)) {
        return { error: `طريقة دفع غير مدعومة: ${method}` };
      }
      if (!Number.isFinite(amount) || amount < 0) {
        return { error: "مبلغ الدفع غير صالح" };
      }
      if (amount > 0) {
        lines.push({ method, amount });
      }
    }
    if (lines.length === 0) {
      return { error: "يجب إدخال مبلغ دفع واحد على الأقل" };
    }
  } else if (body.payment_method) {
    const method = body.payment_method;
    if (method === "mixed") {
      return { error: "يجب إرسال تفاصيل الدفع المتعدد" };
    }
    if (!ALLOWED.includes(method)) {
      return { error: `طريقة الدفع يجب أن تكون: ${ALLOWED.join(" أو ")}` };
    }
    lines = [{ method, amount: total }];
  } else {
    return { error: "طريقة الدفع مطلوبة" };
  }

  const paidSum = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (paidSum + TOLERANCE < total) {
    return { error: "المبلغ المدفوع أقل من إجمالي الفاتورة" };
  }

  const cashTotal = round2(
    lines.filter((l) => l.method === "cash").reduce((s, l) => s + l.amount, 0)
  );
  const visaTotal = round2(
    lines.filter((l) => l.method === "visa").reduce((s, l) => s + l.amount, 0)
  );

  const isSplitPayment = lines.length > 1 || (lines.length === 1 && Array.isArray(body.payments) && body.payments.length > 1);
  if (isSplitPayment && Math.abs(paidSum - total) > TOLERANCE) {
    return { error: "مجموع الدفعات لا يطابق إجمالي الفاتورة" };
  }

  if (visaTotal > round2(total) + TOLERANCE) {
    return { error: "مبلغ الفيزا أكبر من إجمالي الفاتورة" };
  }

  if (
    cashTotal > 0 &&
    visaTotal > 0 &&
    visaTotal > round2(total - cashTotal) + TOLERANCE
  ) {
    return { error: "مبلغ الفيزا أكبر من المطلوب" };
  }

  let normalized = [...lines];
  if (!isSplitPayment && paidSum > total + TOLERANCE) {
    const excess = round2(paidSum - total);
    const cashOnlyExcess = cashTotal;
    if (excess > cashOnlyExcess + TOLERANCE) {
      return { error: "لا يمكن قبول زيادة في الدفع إلا من النقد" };
    }
    const cashIdx = normalized.findIndex((l) => l.method === "cash");
    if (cashIdx < 0) {
      return { error: "لا يمكن قبول زيادة في الدفع إلا من النقد" };
    }
    const newCash = round2(normalized[cashIdx].amount - excess);
    if (newCash < 0) {
      return { error: "مبلغ الدفع غير صالح" };
    }
    if (newCash === 0) {
      normalized = normalized.filter((_, i) => i !== cashIdx);
    } else {
      normalized[cashIdx] = { ...normalized[cashIdx], amount: newCash };
    }
  }

  const normCash = round2(
    normalized.filter((l) => l.method === "cash").reduce((s, l) => s + l.amount, 0)
  );
  const normVisa = round2(
    normalized.filter((l) => l.method === "visa").reduce((s, l) => s + l.amount, 0)
  );
  if (normVisa > round2(total - normCash) + TOLERANCE) {
    return { error: "مبلغ الفيزا أكبر من المطلوب" };
  }

  const onAccountTotal = round2(
    normalized.filter((l) => l.method === "on_account").reduce((s, l) => s + l.amount, 0)
  );

  const methods = new Set(normalized.map((l) => l.method));
  const summaryMethod =
    normalized.length > 1 || methods.size > 1 ? "mixed" : normalized[0].method;

  const storedSum = round2(normalized.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(storedSum - total) > TOLERANCE) {
    return { error: "مجموع الدفعات لا يطابق إجمالي الفاتورة" };
  }

  return {
    lines: normalized,
    summaryMethod,
    cashTendered,
    onAccountTotal: round2(
      normalized.filter((l) => l.method === "on_account").reduce((s, l) => s + l.amount, 0)
    ),
    cashTotal: round2(
      normalized.filter((l) => l.method === "cash").reduce((s, l) => s + l.amount, 0)
    ),
  };
}

export async function loadSalePayments(db, transactionId) {
  const rows = await db.all(
    `SELECT payment_method AS method, amount FROM sale_payments
     WHERE transaction_id = ? ORDER BY id`,
    [transactionId]
  );
  return rows.map((r) => ({
    method: r.method,
    amount: round2(Number(r.amount) || 0),
  }));
}

export async function insertSalePayments(db, transactionId, lines) {
  for (const line of lines) {
    await db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, ?, ?)`,
      [transactionId, line.method, line.amount]
    );
  }
}

/** Sum cash payment lines for transactions in a shift. */
export async function sumShiftCashPayments(db, shiftId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(sp.amount), 0) AS s
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     WHERE t.shift_id = ? AND sp.payment_method = 'cash'`,
    [shiftId]
  );
  return round2(Number(row?.s) || 0);
}

/** Sum visa payment lines for transactions in a shift. */
export async function sumShiftCardPayments(db, shiftId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(sp.amount), 0) AS s
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     WHERE t.shift_id = ? AND sp.payment_method = 'visa'`,
    [shiftId]
  );
  return round2(Number(row?.s) || 0);
}

/** Aggregate payment lines for transactions on a given date. */
export async function aggregatePaymentLinesForDate(db, dateStr) {
  const rows = await db.all(
    `SELECT sp.payment_method, sp.amount, sp.transaction_id, t.payment_method AS tx_method
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     WHERE date(t.created_at) = ?`,
    [dateStr]
  );

  let cash_total = 0;
  let card_total = 0;
  let on_account_total = 0;
  const txMethods = new Map();

  for (const r of rows) {
    const amt = round2(Number(r.amount) || 0);
    if (r.payment_method === "cash") cash_total = round2(cash_total + amt);
    else if (r.payment_method === "on_account") on_account_total = round2(on_account_total + amt);
    else card_total = round2(card_total + amt);

    const prev = txMethods.get(r.transaction_id) || new Set();
    prev.add(r.payment_method);
    txMethods.set(r.transaction_id, prev);
  }

  let mixed_sales_count = 0;
  let cash_transactions = 0;
  let card_transactions = 0;
  let on_account_transactions = 0;

  for (const [txId, methods] of txMethods) {
    const txRow = rows.find((r) => r.transaction_id === txId);
    if (methods.size > 1 || txRow?.tx_method === "mixed") {
      mixed_sales_count++;
    }
    if (methods.has("cash")) cash_transactions++;
    if (methods.has("visa")) card_transactions++;
    if (methods.has("on_account")) on_account_transactions++;
  }

  return {
    cash_total: round2(cash_total),
    card_total: round2(card_total),
    on_account_total: round2(on_account_total),
    mixed_sales_count,
    cash_transactions,
    card_transactions,
    on_account_transactions,
  };
}
