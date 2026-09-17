import { round2 } from "./money.js";

function toMap(rows, key, fields) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row[key]);
    if (!id) continue;
    const entry = {};
    for (const field of fields) entry[field] = round2(Number(row[field]) || 0);
    map.set(id, entry);
  }
  return map;
}

function get(map, id) {
  return map.get(Number(id)) || {};
}

/**
 * Lifetime supplier payable breakdown from the same sources as suppliers.balance.
 * Returns are listed separately and excluded from the displayed debit subtotal.
 *
 * credit_total − debit_total − return_total = computed_balance
 * `balance` is the canonical suppliers.balance cache (not clamped).
 */
export async function buildSupplierBalanceReport(db, { onlyOpen = false } = {}) {
  const suppliers = await db.all(
    `SELECT id, supplier_code, name, contact_phone, balance, opening_balance,
            opening_balance_date, opening_balance_source
     FROM suppliers
     ${onlyOpen ? "WHERE ABS(balance) > 0.009" : ""}
     ORDER BY balance DESC, name COLLATE NOCASE`
  );

  const [purchases, returns, vouchers, legacyPays, adjustments] = await Promise.all([
    db.all(
      `SELECT supplier_id,
              COALESCE(SUM(total), 0) AS purchases
       FROM purchase_invoices
       WHERE status = 'posted'
       GROUP BY supplier_id`
    ),
    db.all(
      `SELECT supplier_id,
              COALESCE(SUM(total), 0) AS returns
       FROM purchase_returns
       WHERE status = 'posted'
       GROUP BY supplier_id`
    ),
    db.all(
      `SELECT vl.supplier_id,
              COALESCE(SUM(vl.amount_nis), 0) AS payments
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.supplier_id IS NOT NULL
         AND v.status = 'posted'
         AND v.voucher_type = 'payment'
       GROUP BY vl.supplier_id`
    ),
    db.all(
      `SELECT supplier_id, COALESCE(SUM(amount), 0) AS payments
       FROM supplier_payments
       GROUP BY supplier_id`
    ),
    db.all(
      `SELECT supplier_id,
              COALESCE(SUM(credit), 0) AS credit,
              COALESCE(SUM(debit), 0) AS debit
       FROM supplier_adjustments
       GROUP BY supplier_id`
    ),
  ]);

  const purchaseMap = toMap(purchases, "supplier_id", ["purchases"]);
  const returnMap = toMap(returns, "supplier_id", ["returns"]);
  const voucherMap = toMap(vouchers, "supplier_id", ["payments"]);
  const legacyMap = toMap(legacyPays, "supplier_id", ["payments"]);
  const adjMap = toMap(adjustments, "supplier_id", ["credit", "debit"]);

  const rows = suppliers.map((s) => {
    const opening = round2(Number(s.opening_balance) || 0);
    const openingCredit = opening > 0 ? opening : 0;
    const openingDebit = opening < 0 ? round2(-opening) : 0;
    const purch = get(purchaseMap, s.id).purchases || 0;
    const ret = get(returnMap, s.id).returns || 0;
    const vouch = get(voucherMap, s.id);
    const legacy = get(legacyMap, s.id).payments || 0;
    const adj = get(adjMap, s.id);
    const creditTotal = round2(
      openingCredit + purch + (adj.credit || 0)
    );
    const debitTotal = round2(
      openingDebit + (vouch.payments || 0) + legacy + (adj.debit || 0)
    );
    const balance = round2(Number(s.balance) || 0);
    return {
      id: Number(s.id),
      supplier_code: s.supplier_code,
      name: s.name,
      contact_phone: s.contact_phone,
      credit_total: creditTotal,
      debit_total: debitTotal,
      return_total: ret,
      balance,
      opening_balance: opening,
      opening_balance_date: s.opening_balance_date || null,
      opening_balance_source: s.opening_balance_source || null,
    };
  });

  const totals = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS total_payable,
            COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END), 0) AS total_advance
     FROM suppliers`
  );

  return {
    suppliers: rows,
    total_payable: round2(Number(totals?.total_payable) || 0),
    total_advance: round2(Number(totals?.total_advance) || 0),
    sign_note:
      "دائن يزيد ما علينا للمورد (رصيد افتتاحي، فواتير شراء مرحّلة، تسويات دائنة). مدين ينقصه (دفعات وتسويات مدينة بدون المرتجعات). مرتجع = مرتجعات الشراء المرحّلة. المجموع = الرصيد المتبقي من الحساب الرسمي (موجب = علينا للمورد). الأرصدة الافتتاحية المستوردة تُعرض ضمن دائن/مدين دون اختراع فواتير أو دفعات.",
  };
}
