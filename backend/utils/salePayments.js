import { round2 } from "./tax.js";
import {
  listCurrencies,
  getBaseCurrency,
  round2Rate,
  toNis,
  isBaseCurrencyCode,
  normalizeCurrencyCode,
} from "./currencies.js";
import {
  TX_BUSINESS_DAY_JOIN,
  businessDayRangeClause,
  businessDayRangeParams,
  txMatchesShopDate,
} from "./businessDay.js";

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
      return (
        byCode.get(String(spec.currency_code).toUpperCase()) ||
        byCode.get(normalizeCurrencyCode(spec.currency_code)) ||
        null
      );
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

  // Converting the invoice into a foreign amount and back (round2(total/rate)*rate)
  // can land 1–2 agorot short of the NIS total. Treat that as covering the bill.
  for (const line of lines) {
    if (line.method !== "cash" || !(line.exchange_rate_used > 0)) continue;
    const expectedOrig = round2(total / line.exchange_rate_used);
    if (Math.abs(line.original_amount - expectedOrig) <= 0.01) {
      line.nis_equivalent = Math.max(line.nis_equivalent, total);
    }
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

  let changeCurrency = base;
  if (changeNis > TOLERANCE) {
    if (body.change_currency_id != null || body.change_currency_code != null) {
      const resolved = resolveCurrency({
        currency_id: body.change_currency_id,
        currency_code: body.change_currency_code,
      });
      if (!resolved) return { error: "عملة الباقي غير موجودة" };
      if (!resolved.enabled) return { error: `عملة الباقي ${resolved.code} غير مفعّلة` };
      changeCurrency = resolved;
    }
  }

  let changeOriginal = 0;
  let changeRate = 1;
  if (changeNis > TOLERANCE && changeCurrency) {
    changeRate = round2Rate(changeCurrency.exchange_rate_to_nis);
    if (isBaseCurrencyCode(changeCurrency.code, base?.code)) {
      changeOriginal = changeNis;
      changeRate = 1;
    } else {
      if (!(changeRate > 0)) return { error: "سعر صرف عملة الباقي غير صالح" };
      changeOriginal = round2(changeNis / changeRate);
      let covered = round2(changeOriginal * changeRate);
      while (covered + TOLERANCE < changeNis) {
        changeOriginal = round2(changeOriginal + 0.01);
        covered = round2(changeOriginal * changeRate);
      }
    }
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
    changeOriginal,
    changeCurrencyId: changeCurrency?.id ?? null,
    changeCurrencyCode: changeCurrency?.code ?? null,
    changeCurrencySymbol: changeCurrency?.symbol ?? null,
    changeRate,
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

/**
 * NIS value that stays in the drawer from a sale (tender minus change).
 * Physical notes stay in their own currency; this is only the shekel equivalent.
 */
export function netDrawerCashNis(paymentLines, changeNis) {
  const cashLines = (paymentLines || []).filter((l) => l.method === "cash");
  const cashTotal = round2(
    cashLines.reduce(
      (s, l) => s + Number(l.nis_equivalent != null ? l.nis_equivalent : l.amount || 0),
      0
    )
  );
  return round2(cashTotal - (Number(changeNis) || 0));
}

function emptyBucket(meta, code) {
  return {
    currency_id: meta?.id ?? meta?.currency_id ?? null,
    code,
    name: meta?.name || code,
    symbol: meta?.symbol || (code === "NIS" ? "\u20AA" : code),
    original: 0,
    nis: 0,
    rate: Number(meta?.exchange_rate_to_nis ?? meta?.rate ?? 1) || 1,
    is_base: !!meta?.is_base,
  };
}

const DEFAULT_BASE_CURRENCY = {
  id: null,
  code: "NIS",
  name: "شيكل",
  symbol: "\u20AA",
  exchange_rate_to_nis: 1,
  is_base: true,
};

const DRAWER_PAY_SELECT = `sp.original_amount, sp.nis_equivalent, sp.amount, sp.currency_id, sp.exchange_rate_used,
            t.payment_method AS tx_method, t.change_amount, t.change_original_amount, t.change_currency_id,
            c.code AS currency_code, c.symbol, c.name, c.is_base, c.exchange_rate_to_nis,
            cc.code AS change_currency_code, cc.symbol AS change_symbol, cc.name AS change_name,
            cc.exchange_rate_to_nis AS change_rate, cc.is_base AS change_is_base`;

const DRAWER_PAY_FROM = `FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     LEFT JOIN currencies c ON c.id = sp.currency_id
     LEFT JOIN currencies cc ON cc.id = t.change_currency_id`;

/**
 * Pure bucketing step, shared by the single-shift and batch paths so both
 * produce byte-identical drawers.
 */
function drawerFromRows({
  base,
  openingCash,
  payRows,
  refundsTotal,
  adjTotal,
  advanceTotal,
  supplierPaymentTotal,
  customerCollectionTotal,
  customerCashDebtTotal,
}) {
  const open = round2(Number(openingCash) || 0);
  const baseCode = normalizeCurrencyCode(base.code);
  const buckets = new Map();

  function bucketFor(code, meta) {
    const key = normalizeCurrencyCode(code || baseCode);
    if (!buckets.has(key)) {
      const row = emptyBucket(meta, key);
      row.is_base = isBaseCurrencyCode(key, baseCode);
      buckets.set(key, row);
    }
    const b = buckets.get(key);
    if (meta) {
      if (meta.id != null && b.currency_id == null) b.currency_id = meta.id;
      if (meta.currency_id != null && b.currency_id == null) b.currency_id = meta.currency_id;
      if (meta.name) b.name = meta.name;
      if (meta.symbol) b.symbol = meta.symbol;
      if (meta.exchange_rate_to_nis != null) b.rate = Number(meta.exchange_rate_to_nis) || b.rate;
      if (meta.is_base) b.is_base = true;
    }
    return b;
  }

  function add(code, original, nis, meta) {
    const b = bucketFor(code, meta);
    b.original = round2(b.original + Number(original || 0));
    b.nis = round2(b.nis + Number(nis || 0));
  }

  add(baseCode, open, open, base);

  const txMap = new Map();
  let salesCashNis = 0;
  let cashOnlyNis = 0;
  let mixedCashNis = 0;
  for (const r of payRows) {
    const code = r.currency_code || baseCode;
    const original = round2(Number(r.original_amount != null ? r.original_amount : r.amount) || 0);
    const nis = round2(Number(r.nis_equivalent != null ? r.nis_equivalent : r.amount) || 0);
    add(code, original, nis, {
      id: r.currency_id,
      currency_id: r.currency_id,
      name: r.name,
      symbol: r.symbol,
      exchange_rate_to_nis: r.exchange_rate_used || r.exchange_rate_to_nis,
      is_base: !!r.is_base,
    });
    salesCashNis = round2(salesCashNis + nis);
    if (r.tx_method === "mixed") mixedCashNis = round2(mixedCashNis + nis);
    else cashOnlyNis = round2(cashOnlyNis + nis);
    if (!txMap.has(r.tx_id)) {
      const changeNis = round2(Number(r.change_amount) || 0);
      const changeOriginal =
        r.change_original_amount != null && r.change_original_amount !== ""
          ? round2(Number(r.change_original_amount) || 0)
          : changeNis;
      txMap.set(r.tx_id, {
        txMethod: r.tx_method,
        changeNis,
        changeOriginal,
        changeCode: r.change_currency_code || baseCode,
        changeMeta: {
          id: r.change_currency_id,
          currency_id: r.change_currency_id,
          name: r.change_name,
          symbol: r.change_symbol,
          exchange_rate_to_nis: r.change_rate,
          is_base: !!r.change_is_base,
        },
      });
    }
  }

  for (const tx of txMap.values()) {
    if (tx.changeNis || tx.changeOriginal) {
      const meta = tx.changeCode === baseCode || !tx.changeMeta?.id ? base : tx.changeMeta;
      add(tx.changeCode || baseCode, -tx.changeOriginal, -tx.changeNis, meta);
      salesCashNis = round2(salesCashNis - tx.changeNis);
      if (tx.txMethod === "mixed") mixedCashNis = round2(mixedCashNis - tx.changeNis);
      else cashOnlyNis = round2(cashOnlyNis - tx.changeNis);
    }
  }

  const refunds = round2(Number(refundsTotal) || 0);
  if (refunds) add(baseCode, -refunds, -refunds, base);

  const adj = round2(Number(adjTotal) || 0);
  const advances = round2(Number(advanceTotal) || 0);
  const supplierPays = round2(Number(supplierPaymentTotal) || 0);
  const collections = round2(Number(customerCollectionTotal) || 0);
  const cashDebts = round2(Number(customerCashDebtTotal) || 0);
  if (adj) add(baseCode, adj, adj, base);
  if (advances) add(baseCode, advances, advances, base);
  if (supplierPays) add(baseCode, supplierPays, supplierPays, base);
  if (collections) add(baseCode, collections, collections, base);
  if (cashDebts) add(baseCode, cashDebts, cashDebts, base);

  const by_currency = Array.from(buckets.values())
    .map((b) => {
      const original = round2(b.original);
      const nis = round2(b.nis);
      const rate = original !== 0 ? round2Rate(nis / original) : Number(b.rate) || 1;
      return { ...b, original, nis, rate };
    })
    .sort((a, b) => {
      if (a.is_base) return -1;
      if (b.is_base) return 1;
      return String(a.code).localeCompare(String(b.code));
    });

  const expected_cash = round2(by_currency.reduce((s, c) => s + c.nis, 0));
  const baseBucket = by_currency.find((c) => c.is_base) || by_currency[0];

  return {
    expected_cash,
    expected_base_cash: round2(baseBucket?.original || 0),
    sales_cash_nis: salesCashNis,
    cash_only_nis: cashOnlyNis,
    mixed_cash_nis: mixedCashNis,
    cash_refunds_nis: refunds,
    by_currency,
  };
}

/**
 * Physical drawer by currency: opening shekels + cash notes received,
 * minus change in the change currency (default shekels).
 */
export async function computeExpectedDrawer(db, shiftId, openingCash) {
  const sid = Number(shiftId);
  const base = (await getBaseCurrency(db)) || DEFAULT_BASE_CURRENCY;

  const payRows = await db.all(
    `SELECT t.id AS tx_id, ${DRAWER_PAY_SELECT}
     ${DRAWER_PAY_FROM}
     WHERE t.shift_id = ? AND sp.payment_method = 'cash'`,
    [sid]
  );
  const cashRefundsRow = await db.get(
    `SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE shift_id = ? AND payment_method = 'cash' AND status = 'approved'`,
    [sid]
  );
  const adjRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'adjustment'`,
    [sid]
  );
  const advancesRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'advance'`,
    [sid]
  );
  const supplierPayRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'`,
    [sid]
  );
  // Receipt vouchers are not added here. A POS collection is counted once,
  // through its customer_collection movement.
  const collectionRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_collection'`,
    [sid]
  );
  const cashDebtRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'`,
    [sid]
  );

  return drawerFromRows({
    base,
    openingCash,
    payRows,
    refundsTotal: cashRefundsRow?.s,
    adjTotal: adjRow?.s,
    advanceTotal: advancesRow?.s,
    supplierPaymentTotal: supplierPayRow?.s,
    customerCollectionTotal: collectionRow?.s,
    customerCashDebtTotal: cashDebtRow?.s,
  });
}

/**
 * Same result as calling computeExpectedDrawer per shift, but in four queries
 * for the whole set instead of four per shift. The shift-audit list used to pay
 * that per-row cost for every shift it displayed.
 * @param {object} db
 * @param {{ id: number, opening_cash?: number }[]} shifts
 * @returns {Promise<Map<number, object>>} keyed by shift id
 */
export async function computeExpectedDrawers(db, shifts) {
  const out = new Map();
  const list = (Array.isArray(shifts) ? shifts : []).filter((s) =>
    Number.isFinite(Number(s?.id))
  );
  if (list.length === 0) return out;

  const ids = [...new Set(list.map((s) => Number(s.id)))];
  const placeholders = ids.map(() => "?").join(",");
  const base = (await getBaseCurrency(db)) || DEFAULT_BASE_CURRENCY;

  const payRows = await db.all(
    `SELECT t.shift_id AS shift_id, t.id AS tx_id, ${DRAWER_PAY_SELECT}
     ${DRAWER_PAY_FROM}
     WHERE t.shift_id IN (${placeholders}) AND sp.payment_method = 'cash'`,
    ids
  );
  const refundRows = await db.all(
    `SELECT shift_id, COALESCE(SUM(total), 0) AS s FROM refunds
     WHERE shift_id IN (${placeholders}) AND payment_method = 'cash' AND status = 'approved'
     GROUP BY shift_id`,
    ids
  );
  const movementRows = await db.all(
    `SELECT shift_id, movement_type, COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements
     WHERE shift_id IN (${placeholders}) AND movement_type IN ('adjustment', 'advance', 'supplier_payment', 'customer_collection', 'customer_cash_debt')
     GROUP BY shift_id, movement_type`,
    ids
  );

  const payByShift = new Map();
  for (const row of payRows) {
    const key = Number(row.shift_id);
    if (!payByShift.has(key)) payByShift.set(key, []);
    payByShift.get(key).push(row);
  }
  const refundByShift = new Map(
    refundRows.map((r) => [Number(r.shift_id), Number(r.s) || 0])
  );
  const adjByShift = new Map();
  const advanceByShift = new Map();
  const supplierPayByShift = new Map();
  const collectionByShift = new Map();
  const cashDebtByShift = new Map();
  for (const row of movementRows) {
    const target =
      row.movement_type === "adjustment"
        ? adjByShift
        : row.movement_type === "advance"
          ? advanceByShift
          : row.movement_type === "customer_collection"
            ? collectionByShift
            : row.movement_type === "customer_cash_debt"
              ? cashDebtByShift
              : supplierPayByShift;
    target.set(Number(row.shift_id), Number(row.s) || 0);
  }

  for (const shift of list) {
    const id = Number(shift.id);
    out.set(
      id,
      drawerFromRows({
        base,
        openingCash: shift.opening_cash,
        payRows: payByShift.get(id) || [],
        refundsTotal: refundByShift.get(id) || 0,
        adjTotal: adjByShift.get(id) || 0,
        advanceTotal: advanceByShift.get(id) || 0,
        supplierPaymentTotal: supplierPayByShift.get(id) || 0,
        customerCollectionTotal: collectionByShift.get(id) || 0,
        customerCashDebtTotal: cashDebtByShift.get(id) || 0,
      })
    );
  }
  return out;
}

/** Sum cash that stays in the drawer from sales, in NIS. Foreign notes count in full. */
export async function sumShiftCashPayments(db, shiftId) {
  const drawer = await computeExpectedDrawer(db, shiftId, 0);
  return drawer.sales_cash_nis;
}

/** Expected drawer cash: opening + cash sales - cash refunds + adjustments + advances + supplier payments + customer collections. */
export async function computeExpectedCash(db, shiftId, openingCash) {
  const drawer = await computeExpectedDrawer(db, shiftId, openingCash);
  return drawer.expected_cash;
}

/** Shekel notes only — used when paying advances from the till. */
export async function computeExpectedBaseCash(db, shiftId, openingCash) {
  const drawer = await computeExpectedDrawer(db, shiftId, openingCash);
  return drawer.expected_base_cash;
}

/**
 * After applying this sale's cash tenders, the change-currency bucket must
 * cover changeOriginal. Returns { error, code } or null.
 */
export async function assertDrawerCanGiveChange(
  db,
  shiftId,
  openingCash,
  paymentLines,
  { changeOriginal = 0, changeNis = 0, changeCurrencyCode = null } = {}
) {
  const orig = round2(Number(changeOriginal) || 0);
  const nis = round2(Number(changeNis) || 0);
  if (orig <= TOLERANCE && nis <= TOLERANCE) return null;

  const drawer = await computeExpectedDrawer(db, shiftId, openingCash);
  const baseCode = drawer.by_currency.find((c) => c.is_base)?.code || "NIS";
  const buckets = new Map(
    drawer.by_currency.map((b) => [normalizeCurrencyCode(b.code), { ...b }])
  );

  for (const line of paymentLines || []) {
    if (line.method !== "cash") continue;
    const code = normalizeCurrencyCode(line.currency_code || baseCode);
    const prev = buckets.get(code) || emptyBucket(line, code);
    prev.original = round2(prev.original + Number(line.original_amount || 0));
    prev.nis = round2(prev.nis + Number(line.nis_equivalent || line.amount || 0));
    if (line.symbol) prev.symbol = line.symbol;
    buckets.set(code, prev);
  }

  const changeCode = normalizeCurrencyCode(changeCurrencyCode || baseCode);
  const bucket = buckets.get(changeCode);
  const available = round2(bucket?.original || 0);
  if (available + TOLERANCE >= orig) return null;

  const symbol = bucket?.symbol || changeCode;
  return {
    error: `النقد في الدرج غير كافٍ لإرجاع الباقي (${symbol}${orig.toFixed(2)}). المتاح: ${symbol}${available.toFixed(2)} — غيّر عملة الباقي`,
    code: "INSUFFICIENT_CHANGE",
  };
}

/** Convert a counted-currency payload to a single NIS closing amount. */
export async function resolveCountedCash(db, body, drawer = null) {
  const counted = body?.counted_currencies;
  if (Array.isArray(counted) && counted.length > 0) {
    const currencies = await listCurrencies(db, { enabledOnly: false });
    const byId = new Map(currencies.map((c) => [Number(c.id), c]));
    const byCode = new Map(currencies.map((c) => [normalizeCurrencyCode(c.code), c]));
    const snapshotRates = new Map(
      (drawer?.by_currency || []).map((c) => [normalizeCurrencyCode(c.code), Number(c.rate) || 1])
    );
    const snapshot = [];
    let total = 0;
    for (const row of counted) {
      const cur =
        row?.currency_id != null
          ? byId.get(Number(row.currency_id))
          : byCode.get(normalizeCurrencyCode(row.currency_code || row.code));
      if (!cur) return { error: "عملة العد غير موجودة" };
      const amount = round2(Number(row.amount) || 0);
      if (!Number.isFinite(amount) || amount < 0) {
        return { error: "مبلغ النقد الفعلي غير صالح" };
      }
      const snap = snapshotRates.get(normalizeCurrencyCode(cur.code));
      const rate = snap != null && snap > 0 ? round2Rate(snap) : round2Rate(cur.exchange_rate_to_nis);
      const nis = toNis(amount, rate);
      total = round2(total + nis);
      snapshot.push({
        currency_id: cur.id,
        code: cur.code,
        symbol: cur.symbol,
        amount,
        rate,
        nis,
      });
    }
    return { closing_cash: total, counted_cash: snapshot };
  }

  const raw = body?.closing_cash ?? body?.actual_cash;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { error: "مبلغ النقد الفعلي غير صالح" };
  }
  const closing_cash = round2(Number(raw));
  if (Number.isNaN(closing_cash) || closing_cash < 0) {
    return { error: "مبلغ النقد الفعلي غير صالح" };
  }
  return { closing_cash, counted_cash: null };
}

/** Recorded Visa payments. Not a bank settlement and not a card-terminal match. */
export const VISA_RECORDED_NOTE =
  "مدفوعات فيزا مسجّلة في النظام. ليست تسوية بنكية ولا مطابقة لجهاز البطاقة.";

export const VISA_INCOMPLETE_NOTE =
  "سجل الفيزا غير مكتمل: توجد عمليات بلا توزيع دفع موثوق، ولم يُخمَّن المبلغ الناقص.";

export const SHIFT_VISA_LABELS = Object.freeze({
  sales: "مبيعات فيزا",
  refunds: "مرتجعات الفيزا",
  net: "صافي المبيعات الفيزا",
});

export const SHIFT_CASH_SALES_LABEL = "مبيعات نقدية";
export const SHIFT_MIXED_CASH_LABEL = "منها نقد من دفعات مختلطة";
export const SHIFT_MIXED_CASH_INCLUDED_NOTE = "مشمول في المبيعات النقدية";
export const SHIFT_VISA_AMOUNT_LABEL = SHIFT_VISA_LABELS.sales;
export const SHIFT_TENDER_TOTAL_LABEL = "إجمالي المبيعات النقدية والفيزا";
export const SHIFT_CASH_REFUNDS_LABEL = "مرتجعات نقدية";
export const SHIFT_CASH_NET_LABEL = "صافي المبيعات النقدية";
export const SHIFT_EXPECTED_CASH_LABEL = "النقد المتوقع في الصندوق";

export const CASH_SALES_INCOMPLETE_NOTE =
  "سجل المبيعات النقدية غير مكتمل: توجد عمليات بلا توزيع دفع موثوق، ولم يُخمَّن المبلغ الناقص.";

/** Agorot slack for historical REAL sums. Larger gaps are incomplete, not filled in. */
const ALLOCATION_TOLERANCE = 0.02;

export function emptyShiftVisa() {
  return {
    visa_sales: 0,
    visa_refunds: 0,
    visa_net: 0,
    visa_incomplete: false,
    visa_note: VISA_RECORDED_NOTE,
    visa_incomplete_note: VISA_INCOMPLETE_NOTE,
    visa_labels: SHIFT_VISA_LABELS,
    cash_sales_incomplete: false,
    cash_sales_incomplete_note: CASH_SALES_INCOMPLETE_NOTE,
  };
}

/**
 * A visa/mixed sale lacks a reliable allocation when there is no payment split,
 * a mixed sale was stored as a single guessed line, a visa sale has no visa line,
 * or the visa lines do not match the invoice (including a retry that inserted
 * the same visa line twice). Callers still sum the rows that exist; they do not
 * invent the missing portion from the invoice total.
 */
export function saleAllocationIncomplete(row) {
  const method = row?.payment_method;
  if (method !== "visa" && method !== "mixed") return false;
  const payCount = Number(row.pay_count) || 0;
  const visaCount = Number(row.visa_count) || 0;
  const visaPaid = round2(Number(row.visa_paid) || 0);
  const total = round2(Number(row.total) || 0);
  if (payCount === 0) return true;
  if (method === "mixed" && payCount < 2) return true;
  if (method === "visa" && visaCount === 0) return true;
  if (method === "visa" && Math.abs(visaPaid - total) > ALLOCATION_TOLERANCE) return true;
  if (visaPaid > round2(total + ALLOCATION_TOLERANCE)) return true;
  return false;
}

/** Approved refunds with no cash/visa/on-account method cannot be split by guesswork. */
export function refundAllocationIncomplete(row) {
  if (String(row?.status || "") !== "approved") return false;
  const method = row?.payment_method;
  return method !== "cash" && method !== "visa" && method !== "on_account";
}

/**
 * A cash/mixed sale lacks a reliable cash allocation when there is no payment
 * split, a cash sale has no cash line, or the cash lines exceed the invoice.
 * Callers still sum recorded cash lines; they do not invent the missing portion.
 */
export function saleCashAllocationIncomplete(row) {
  const method = row?.payment_method;
  if (method !== "cash" && method !== "mixed") return false;
  const payCount = Number(row.pay_count) || 0;
  const cashCount = Number(row.cash_count) || 0;
  const cashPaid = round2(Number(row.cash_paid) || 0);
  const total = round2(Number(row.total) || 0);
  if (payCount === 0) return true;
  if (method === "mixed" && payCount < 2) return true;
  if (method === "cash" && cashCount === 0) return true;
  if (method === "cash" && Math.abs(cashPaid - total) > ALLOCATION_TOLERANCE) return true;
  if (cashPaid > round2(total + ALLOCATION_TOLERANCE)) return true;
  return false;
}

function shiftIdList(shiftIds) {
  return [
    ...new Set(
      (shiftIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
}

/**
 * Recorded Visa for each shift.
 * Sales: visa lines on sale_payments for transactions posted on that shift.
 * Refunds: approved visa refunds whose shift_id is the shift that processed them.
 * Shiftless rows (office invoices) are absent from both sets.
 * Each sale_payments.id is summed once so a join cannot double-count a line.
 */
export async function computeShiftVisaMap(db, shiftIds) {
  const ids = shiftIdList(shiftIds);
  const out = new Map(ids.map((id) => [id, emptyShiftVisa()]));
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");

  const salesRows = await db.all(
    `SELECT shift_id, COALESCE(SUM(line_nis), 0) AS visa_sales
     FROM (
       SELECT sp.id AS payment_id,
              t.shift_id AS shift_id,
              COALESCE(sp.nis_equivalent, sp.amount) AS line_nis
       FROM sale_payments sp
       INNER JOIN transactions t ON t.id = sp.transaction_id
       WHERE t.shift_id IN (${ph}) AND sp.payment_method = 'visa'
       GROUP BY sp.id
     ) AS visa_lines
     GROUP BY shift_id`,
    ids
  );
  const refundRows = await db.all(
    `SELECT shift_id, COALESCE(SUM(total), 0) AS visa_refunds
     FROM refunds
     WHERE shift_id IN (${ph}) AND status = 'approved' AND payment_method = 'visa'
     GROUP BY shift_id`,
    ids
  );
  const suspectSales = await db.all(
    `SELECT t.shift_id AS shift_id,
            t.payment_method AS payment_method,
            t.total AS total,
            COUNT(sp.id) AS pay_count,
            COALESCE(SUM(CASE WHEN sp.payment_method = 'visa' THEN 1 ELSE 0 END), 0) AS visa_count,
            COALESCE(SUM(CASE WHEN sp.payment_method = 'visa' THEN COALESCE(sp.nis_equivalent, sp.amount) ELSE 0 END), 0) AS visa_paid,
            COALESCE(SUM(CASE WHEN sp.payment_method = 'cash' THEN 1 ELSE 0 END), 0) AS cash_count,
            COALESCE(SUM(CASE WHEN sp.payment_method = 'cash' THEN COALESCE(sp.nis_equivalent, sp.amount) ELSE 0 END), 0) AS cash_paid
     FROM transactions t
     LEFT JOIN sale_payments sp ON sp.transaction_id = t.id
     WHERE t.shift_id IN (${ph})
       AND t.payment_method IN ('visa', 'mixed', 'cash')
     GROUP BY t.id`,
    ids
  );
  const suspectRefunds = await db.all(
    `SELECT shift_id, status, payment_method
     FROM refunds
     WHERE shift_id IN (${ph})
       AND status = 'approved'
       AND COALESCE(payment_method, '') NOT IN ('cash', 'visa', 'on_account')`,
    ids
  );

  for (const row of salesRows) {
    const visa = out.get(Number(row.shift_id));
    if (visa) visa.visa_sales = round2(Number(row.visa_sales) || 0);
  }
  for (const row of refundRows) {
    const visa = out.get(Number(row.shift_id));
    if (visa) visa.visa_refunds = round2(Number(row.visa_refunds) || 0);
  }
  for (const row of suspectSales) {
    const visa = out.get(Number(row.shift_id));
    if (!visa) continue;
    if (saleAllocationIncomplete(row)) visa.visa_incomplete = true;
    if (saleCashAllocationIncomplete(row)) visa.cash_sales_incomplete = true;
  }
  for (const row of suspectRefunds) {
    if (!refundAllocationIncomplete(row)) continue;
    const visa = out.get(Number(row.shift_id));
    if (visa) visa.visa_incomplete = true;
  }
  for (const visa of out.values()) {
    visa.visa_net = round2(visa.visa_sales - visa.visa_refunds);
  }
  return out;
}

export async function computeShiftVisa(db, shiftId) {
  const map = await computeShiftVisaMap(db, [shiftId]);
  return map.get(Number(shiftId)) || emptyShiftVisa();
}

/** Sum visa payment lines for transactions posted on a shift. */
export async function sumShiftCardPayments(db, shiftId) {
  const visa = await computeShiftVisa(db, shiftId);
  return visa.visa_sales;
}

/** Aggregate payment lines for transactions on a given shop calendar date. */
export async function aggregatePaymentLinesForDate(db, dateStr) {
  const rows = await db.all(
    `SELECT sp.payment_method, sp.amount, sp.transaction_id, t.payment_method AS tx_method,
            sp.currency_id, sp.original_amount, sp.nis_equivalent,
            c.code AS currency_code, c.symbol AS currency_symbol, c.name AS currency_name,
            t.created_at, t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     ${TX_BUSINESS_DAY_JOIN}
     LEFT JOIN currencies c ON c.id = sp.currency_id
     WHERE ${businessDayRangeClause("t", "cs")}`,
    businessDayRangeParams(dateStr, dateStr)
  );
  const matched = rows.filter((r) => txMatchesShopDate(r, dateStr));

  let cash_total = 0;
  let card_total = 0;
  let on_account_total = 0;
  const txMethods = new Map();
  const currencyMap = new Map();

  for (const r of matched) {
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
    const txRow = matched.find((r) => r.transaction_id === txId);
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
