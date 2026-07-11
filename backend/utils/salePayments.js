import { round2 } from "./tax.js";
import { listCurrencies, getBaseCurrency, round2Rate } from "./currencies.js";
import { TX_BUSINESS_DAY_JOIN, txBusinessDayEquals } from "./businessDay.js";

const ALLOWED = ["cash", "visa", "on_account"];
const INVOICE_ALLOWED = ["cash", "visa", "on_account", "check"];
const TOLERANCE = 0.005;

async function resolvePaymentLines(db, body, computedTotal, allowedMethods) {
  const total = round2(computedTotal);
  const cashTendered =
    body.cash_tendered != null && body.cash_tendered !== ""
      ? round2(Number(body.cash_tendered))
      : null;

  const currencies = await listCurrencies(db, { enabledOnly: false });
  const byId = new Map(currencies.map((c) => [c.id, c]));
  const byCode = new Map(currencies.map((c) => [String(c.code).toUpperCase(), c]));
  const base = (await getBaseCurrency(db)) || currencies.find((c) => c.is_base) || null;

  function resolveCurrency(spec) {
    if (spec.currency_id != null) {
      return byId.get(Number(spec.currency_id)) || null;
    }
    if (spec.currency_code != null) {
      return byCode.get(String(spec.currency_code).toUpperCase()) || null;
    }
    return base;
  }

  function buildLine(spec, fallbackAmount) {
    const method = spec.method || spec.payment_method;
    if (!allowedMethods.includes(method)) {
      return { error: `طريقة دفع غير مدعومة: ${method}` };
    }
    if (method === "check" && !String(spec.bank_name || "").trim()) {
      return { error: "اسم البنك مطلوب لدفع الشيك" };
    }
    const cur = resolveCurrency(spec);
    if (!cur) {
      return { error: "العملة غير موجودة" };
    }
    if (!cur.enabled) {
      return { error: `العملة ${cur.code} غير مفعّلة` };
    }
    const rawOriginal =
      spec.original_amount != null && spec.original_amount !== ""
        ? Number(spec.original_amount)
        : spec.amount != null && spec.amount !== ""
          ? Number(spec.amount)
          : Number(fallbackAmount);
    const originalAmount = round2(rawOriginal);
    if (!Number.isFinite(originalAmount) || originalAmount < 0) {
      return { error: "مبلغ الدفع غير صالح" };
    }
    const rate = round2Rate(cur.exchange_rate_to_nis);
    const nisEquivalent = round2(originalAmount * rate);
    return {
      line: {
        method,
        currency_id: cur.id,
        currency_code: cur.code,
        symbol: cur.symbol,
        original_amount: originalAmount,
        exchange_rate_used: rate,
        nis_equivalent: nisEquivalent,
        bank_name: method === "check" ? String(spec.bank_name || "").trim() : null,
        check_no: method === "check" ? String(spec.check_no || "").trim() || null : null,
      },
    };
  }

  let lines = [];

  if (Array.isArray(body.payments) && body.payments.length > 0) {
    for (const p of body.payments) {
      const built = buildLine(p, p.amount);
      if (built.error) return { error: built.error };
      if (built.line.original_amount > 0) lines.push(built.line);
    }
    if (lines.length === 0) {
      return { error: "يجب إدخال مبلغ دفع واحد على الأقل" };
    }
  } else if (body.payment_method) {
    const method = body.payment_method;
    if (method === "mixed") {
      return { error: "يجب إرسال تفاصيل الدفع المتعدد" };
    }
    const built = buildLine(
      {
        method,
        currency_id: body.currency_id,
        currency_code: body.currency_code,
        original_amount: body.original_amount,
        bank_name: body.bank_name,
        check_no: body.check_no,
      },
      total
    );
    if (built.error) return { error: built.error };
    lines = [built.line];
  } else {
    return { error: "طريقة الدفع مطلوبة" };
  }

  const paidNisSum = round2(lines.reduce((s, l) => s + l.nis_equivalent, 0));
  if (paidNisSum + TOLERANCE < total) {
    return { error: "المبلغ المدفوع أقل من إجمالي الفاتورة" };
  }

  const cashNis = round2(
    lines.filter((l) => l.method === "cash").reduce((s, l) => s + l.nis_equivalent, 0)
  );
  const nonCashNis = round2(
    lines.filter((l) => l.method !== "cash").reduce((s, l) => s + l.nis_equivalent, 0)
  );

  if (nonCashNis > total + TOLERANCE) {
    return { error: "المبلغ المدفوع بغير النقد أكبر من إجمالي الفاتورة" };
  }

  const excess = round2(paidNisSum - total);
  let changeNis = 0;
  if (excess > TOLERANCE) {
    if (excess > cashNis + TOLERANCE) {
      return { error: "لا يمكن قبول زيادة في الدفع إلا من النقد" };
    }
    changeNis = excess;
  }

  const onAccountTotal = round2(
    lines.filter((l) => l.method === "on_account").reduce((s, l) => s + l.nis_equivalent, 0)
  );

  const methods = new Set(lines.map((l) => l.method));
  const summaryMethod = lines.length > 1 || methods.size > 1 ? "mixed" : lines[0].method;

  return {
    lines,
    summaryMethod,
    cashTendered,
    onAccountTotal,
    cashTotal: cashNis,
    changeNis,
  };
}

/**
 * Resolve and validate multi-currency checkout payment lines against the
 * server-computed NIS total. The exchange rate is always read from the DB
 * (never trusted from the client) and snapshotted onto each stored line.
 *
 * Every returned line carries:
 *   { method, currency_id, currency_code, symbol, original_amount,
 *     exchange_rate_used, nis_equivalent }
 *
 * @param {object} db wrapped sqlite db
 * @param {object} body checkout request body
 * @param {number} computedTotal invoice total in NIS
 * @returns {Promise<{ lines?, summaryMethod?, cashTendered?, onAccountTotal?, cashTotal?, changeNis?, error? }>}
 */
export async function resolveCheckoutPayments(db, body, computedTotal) {
  return resolvePaymentLines(db, body, computedTotal, ALLOWED);
}

/** Office sales invoice payments — includes check and mixed. */
export async function resolveInvoicePayments(db, body, computedTotal) {
  return resolvePaymentLines(db, body, computedTotal, INVOICE_ALLOWED);
}

export async function loadSalePayments(db, transactionId) {
  const rows = await db.all(
    `SELECT sp.payment_method AS method,
            sp.amount,
            sp.currency_id,
            sp.original_amount,
            sp.exchange_rate_used,
            sp.nis_equivalent,
            c.code AS currency_code,
            c.symbol AS symbol
     FROM sale_payments sp
     LEFT JOIN currencies c ON c.id = sp.currency_id
     WHERE sp.transaction_id = ? ORDER BY sp.id`,
    [transactionId]
  );
  return rows.map((r) => {
    const nis = round2(Number(r.nis_equivalent ?? r.amount) || 0);
    return {
      method: r.method,
      amount: nis,
      currency_id: r.currency_id ?? null,
      currency_code: r.currency_code ?? null,
      symbol: r.symbol ?? null,
      original_amount: round2(Number(r.original_amount ?? r.amount) || 0),
      exchange_rate_used: Number(r.exchange_rate_used ?? 1) || 1,
      nis_equivalent: nis,
    };
  });
}

export async function insertSalePayments(db, transactionId, lines) {
  for (const line of lines) {
    const nis = round2(
      Number(line.nis_equivalent != null ? line.nis_equivalent : line.amount) || 0
    );
    const original = round2(
      Number(line.original_amount != null ? line.original_amount : line.amount) || 0
    );
    const rate = Number(line.exchange_rate_used != null ? line.exchange_rate_used : 1) || 1;
    await db.run(
      `INSERT INTO sale_payments
         (transaction_id, payment_method, amount, currency_id, original_amount, exchange_rate_used, nis_equivalent, bank_name, check_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        line.method,
        nis,
        line.currency_id ?? null,
        original,
        rate,
        nis,
        line.bank_name ?? null,
        line.check_no ?? null,
      ]
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
    `SELECT sp.payment_method, sp.amount, sp.transaction_id, t.payment_method AS tx_method,
            sp.currency_id, sp.original_amount, sp.nis_equivalent,
            c.code AS currency_code, c.symbol AS currency_symbol, c.name AS currency_name
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     ${TX_BUSINESS_DAY_JOIN}
     LEFT JOIN currencies c ON c.id = sp.currency_id
     WHERE ${txBusinessDayEquals("?")}`,
    [dateStr]
  );

  let cash_total = 0;
  let card_total = 0;
  let on_account_total = 0;
  const txMethods = new Map();
  const currencyMap = new Map();

  for (const r of rows) {
    const amt = round2(Number(r.amount) || 0);
    if (r.payment_method === "cash") cash_total = round2(cash_total + amt);
    else if (r.payment_method === "on_account") on_account_total = round2(on_account_total + amt);
    else card_total = round2(card_total + amt);

    const code = r.currency_code || "NIS";
    const entry =
      currencyMap.get(code) ||
      {
        currency_id: r.currency_id ?? null,
        code,
        name: r.currency_name || code,
        symbol: r.currency_symbol || "\u20AA",
        original_total: 0,
        nis_total: 0,
      };
    entry.original_total = round2(entry.original_total + (Number(r.original_amount ?? r.amount) || 0));
    entry.nis_total = round2(entry.nis_total + (Number(r.nis_equivalent ?? r.amount) || 0));
    currencyMap.set(code, entry);

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

  const collections_by_currency = Array.from(currencyMap.values()).sort((a, b) => {
    if (a.code === "NIS") return -1;
    if (b.code === "NIS") return 1;
    return String(a.code).localeCompare(String(b.code));
  });
  const collections_grand_total_nis = round2(
    collections_by_currency.reduce((s, c) => s + c.nis_total, 0)
  );

  return {
    cash_total: round2(cash_total),
    card_total: round2(card_total),
    on_account_total: round2(on_account_total),
    mixed_sales_count,
    cash_transactions,
    card_transactions,
    on_account_transactions,
    collections_by_currency,
    collections_grand_total_nis,
  };
}
