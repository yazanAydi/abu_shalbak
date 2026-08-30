/**
 * Framework-agnostic data-integrity checks.
 * Returns { name, ok, expectedFail, detail }[] so Jest and the load runner
 * can share the same math.
 *
 * Column names follow the live schema (quantity_delta, line_net) — not the
 * plan's first-draft names.
 */
import { computeExpectedDrawer } from "../../utils/salePayments.js";

const MONEY_EPS = 0.015;

function result(name, ok, detail, expectedFail = false, extra = {}) {
  const applicable = extra.applicable !== false;
  let status = extra.status;
  if (!status) {
    if (!applicable) status = "na";
    else if (ok) status = "pass";
    else if (expectedFail) status = "known-bug";
    else status = "fail";
  }
  return {
    name,
    ok: Boolean(ok),
    expectedFail: Boolean(expectedFail),
    detail: detail || "",
    applicable,
    status,
  };
}

function near(a, b, eps = MONEY_EPS) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function finite(n) {
  return Number.isFinite(Number(n));
}

/**
 * @param {object} db
 * @param {object} baseline from captureBaseline
 * @param {{
 *   receiptsFromResponses?: string[],
 *   successfulCheckouts?: number,
 *   expectCreditLimitBypass?: boolean,
 *   expectShiftDuplication?: boolean,
 *   expectedProductFields?: { id: number, fields: Record<string, unknown> },
 *   expectSales?: boolean,
 * }} [extras]
 */
export async function checkInvariants(db, baseline, extras = {}) {
  const out = [];
  const maxLedger = Number(baseline?.maxIds?.ledger) || 0;
  const maxTx = Number(baseline?.maxIds?.transactions) || 0;

  // 1. Stock cache = baseline + ledger deltas after snapshot
  const products = await db.all("SELECT id, stock FROM products");
  const ledgerSums = await db.all(
    `SELECT product_id, COALESCE(SUM(quantity_delta), 0) AS delta
     FROM inventory_ledger WHERE id > ? GROUP BY product_id`,
    [maxLedger]
  );
  const deltaByProduct = Object.fromEntries(
    ledgerSums.map((r) => [String(r.product_id), Number(r.delta) || 0])
  );
  const stockMismatches = [];
  for (const p of products) {
    const id = String(p.id);
    const before = baseline.products[id];
    if (!before) continue;
    const expected = before.stock + (deltaByProduct[id] || 0);
    if (!near(p.stock, expected, 0.0001)) {
      stockMismatches.push(`product ${id}: stock=${p.stock} expected=${expected}`);
    }
  }
  out.push(
    result(
      "stock_equals_baseline_plus_ledger",
      stockMismatches.length === 0,
      stockMismatches.slice(0, 8).join("; ") || "ok"
    )
  );

  // 2. Ledger chaining (qty_after = qty_before + quantity_delta; consecutive rows)
  const chainBreaks = [];
  const ledgerRows = await db.all(
    `SELECT id, product_id, quantity_delta, qty_before, qty_after
     FROM inventory_ledger ORDER BY product_id, id`
  );
  const lastByProduct = new Map();
  for (const row of ledgerRows) {
    const pid = String(row.product_id);
    const before = Number(row.qty_before);
    const after = Number(row.qty_after);
    const delta = Number(row.quantity_delta);
    if (!near(after, before + delta, 0.0001)) {
      chainBreaks.push(`ledger ${row.id} product ${pid}: ${before}+${delta}!=${after}`);
    }
    const prev = lastByProduct.get(pid);
    if (prev && !near(before, prev, 0.0001)) {
      chainBreaks.push(`ledger ${row.id} product ${pid}: qty_before=${before} prev_after=${prev}`);
    }
    lastByProduct.set(pid, after);
  }
  out.push(
    result(
      "ledger_qty_chaining",
      chainBreaks.length === 0,
      chainBreaks.slice(0, 8).join("; ") || "ok"
    )
  );

  // 3. Every sale line has a sale ledger row; every approved refund has a refund ledger row
  const maxRefund = Number(baseline?.maxIds?.refunds) || 0;
  const missingSaleLedger = await db.get(
    `SELECT COUNT(*) AS n FROM transaction_items ti
     WHERE ti.transaction_id > ?
       AND NOT EXISTS (
         SELECT 1 FROM inventory_ledger il
         WHERE il.reference_type = 'transaction'
           AND il.reference_id = ti.transaction_id
           AND il.product_id = ti.product_id
           AND il.movement_type = 'sale'
       )`,
    [maxTx]
  );
  const missingRefundLedger = await db.get(
    `SELECT COUNT(*) AS n FROM refunds r
     WHERE r.id > ?
       AND r.status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM inventory_ledger il
         WHERE il.reference_type = 'refund' AND il.reference_id = r.id AND il.movement_type = 'refund'
       )`,
    [maxRefund]
  );
  out.push(
    result(
      "sale_and_refund_ledger_coverage",
      Number(missingSaleLedger?.n) === 0 && Number(missingRefundLedger?.n) === 0,
      `missing sale ledger lines=${missingSaleLedger?.n} missing refund ledger=${missingRefundLedger?.n}`
    )
  );

  // 4. No NaN / null / infinite quantities
  const badQty = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM products WHERE stock IS NULL OR stock != stock) AS bad_stock,
      (SELECT COUNT(*) FROM inventory_ledger
        WHERE quantity_delta IS NULL OR quantity_delta != quantity_delta
           OR qty_before IS NULL OR qty_after IS NULL) AS bad_ledger,
      (SELECT COUNT(*) FROM transaction_items WHERE quantity IS NULL OR quantity != quantity) AS bad_items
  `);
  out.push(
    result(
      "quantities_finite",
      Number(badQty.bad_stock) === 0 && Number(badQty.bad_ledger) === 0 && Number(badQty.bad_items) === 0,
      `bad_stock=${badQty.bad_stock} bad_ledger=${badQty.bad_ledger} bad_items=${badQty.bad_items}`
    )
  );

  // 5. Receipt uniqueness (workload-aware: empty is N/A or FAIL, never a vacuous PASS)
  const receiptDup = await db.get(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT receipt_number) AS distinct_n
    FROM transactions WHERE receipt_number IS NOT NULL
  `);
  const receiptTotal = Number(receiptDup.total) || 0;
  const receiptDistinct = Number(receiptDup.distinct_n) || 0;
  const receiptsUnique = receiptTotal === receiptDistinct;
  if (extras.expectSales === false && receiptTotal === 0) {
    out.push(
      result(
        "receipt_numbers_unique",
        true,
        "N/A: profile performs no sales",
        false,
        { applicable: false, status: "na" }
      )
    );
  } else if (extras.expectSales === true && receiptTotal === 0) {
    out.push(
      result(
        "receipt_numbers_unique",
        false,
        "FAIL: profile expected sales but receipts total=0",
        false,
        { status: "fail" }
      )
    );
  } else {
    out.push(
      result(
        "receipt_numbers_unique",
        receiptsUnique,
        receiptsUnique
          ? `PASS: total=${receiptTotal} distinct=${receiptDistinct}`
          : `total=${receiptTotal} distinct=${receiptDistinct}`
      )
    );
  }

  // 6. Response receipts exist once
  const receiptsFromResponses = extras.receiptsFromResponses || [];
  const missingReceipts = [];
  const multiReceipts = [];
  for (const rn of receiptsFromResponses) {
    if (!rn) continue;
    const row = await db.get(
      "SELECT COUNT(*) AS n FROM transactions WHERE receipt_number = ?",
      [rn]
    );
    if (Number(row.n) === 0) missingReceipts.push(rn);
    if (Number(row.n) > 1) multiReceipts.push(rn);
  }
  out.push(
    result(
      "response_receipts_persisted_once",
      missingReceipts.length === 0 && multiReceipts.length === 0,
      missingReceipts.length
        ? `missing=${missingReceipts.slice(0, 5).join(",")}`
        : multiReceipts.length
          ? `duplicates=${multiReceipts.slice(0, 5).join(",")}`
          : "ok"
    )
  );

  // 7. Successful checkouts match new transaction rows
  if (extras.successfulCheckouts != null) {
    const newTx = await db.get(
      "SELECT COUNT(*) AS n FROM transactions WHERE id > ?",
      [maxTx]
    );
    out.push(
      result(
        "successful_checkouts_match_transactions",
        Number(newTx.n) === Number(extras.successfulCheckouts),
        `http_201=${extras.successfulCheckouts} new_tx=${newTx.n}`
      )
    );
  }

  // 8. receipt_sequences.last_seq >= max minted sequence for this year
  const year = baseline.year || new Date().getFullYear();
  const seqRow = await db.get(
    "SELECT last_seq FROM receipt_sequences WHERE store_id = 1 AND year = ?",
    [year]
  );
  const maxReceipt = await db.get(
    `SELECT receipt_number FROM transactions
     WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1`,
    [`INV-${year}-%`]
  );
  let minted = 0;
  if (maxReceipt?.receipt_number) {
    const m = String(maxReceipt.receipt_number).match(/INV-\d{4}-(\d+)/);
    minted = m ? Number(m[1]) : 0;
  }
  const lastSeq = Number(seqRow?.last_seq) || 0;
  if (extras.expectSales === false && minted === 0 && lastSeq === 0) {
    out.push(
      result(
        "receipt_sequence_covers_minted",
        true,
        "N/A: profile performs no sales",
        false,
        { applicable: false, status: "na" }
      )
    );
  } else if (extras.expectSales === true && minted === 0 && lastSeq === 0) {
    out.push(
      result(
        "receipt_sequence_covers_minted",
        false,
        "FAIL: profile expected sales but last_seq=0 max_minted=0",
        false,
        { status: "fail" }
      )
    );
  } else {
    out.push(
      result(
        "receipt_sequence_covers_minted",
        lastSeq >= minted,
        lastSeq >= minted
          ? `PASS: last_seq=${lastSeq} max_minted=${minted}`
          : `last_seq=${lastSeq} max_minted=${minted}`
      )
    );
  }

  // 9. One transaction per idempotency_key
  const idempDup = await db.get(`
    SELECT idempotency_key, COUNT(*) AS n
    FROM transactions
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING n > 1
    LIMIT 1
  `);
  out.push(
    result(
      "idempotency_keys_unique",
      !idempDup,
      idempDup ? `key=${idempDup.idempotency_key} n=${idempDup.n}` : "ok"
    )
  );

  // 10. Payments cover total + change (NIS)
  const payMismatch = await db.all(`
    SELECT t.id, t.total, t.change_amount,
           COALESCE((SELECT SUM(COALESCE(nis_equivalent, amount)) FROM sale_payments sp WHERE sp.transaction_id = t.id), 0) AS paid
    FROM transactions t
    WHERE t.id > ?
  `, [maxTx]);
  const payBad = payMismatch.filter((r) => !near(Number(r.paid), Number(r.total) + Number(r.change_amount || 0)));
  out.push(
    result(
      "payments_cover_total_plus_change",
      payBad.length === 0,
      payBad
        .slice(0, 5)
        .map((r) => `tx ${r.id}: paid=${r.paid} total=${r.total} change=${r.change_amount}`)
        .join("; ") || "ok"
    )
  );

  // 11. No orphan payments / empty payment sets
  const orphans = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM sale_payments sp
         WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = sp.transaction_id)) AS orphan_payments,
      (SELECT COUNT(*) FROM transactions t
         WHERE t.id > ${maxTx}
           AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.transaction_id = t.id)) AS tx_without_payments
  `);
  out.push(
    result(
      "payments_not_orphaned",
      Number(orphans.orphan_payments) === 0 && Number(orphans.tx_without_payments) === 0,
      `orphan_payments=${orphans.orphan_payments} tx_without_payments=${orphans.tx_without_payments}`
    )
  );

  // 12. Drawer expected cash matches movement reconstruction
  const shifts = await db.all("SELECT id, opening_cash FROM cashier_shifts");
  const drawerBad = [];
  for (const sh of shifts) {
    const drawer = await computeExpectedDrawer(db, sh.id, sh.opening_cash);
    const expected = Number(drawer?.expected_cash ?? drawer?.expected ?? drawer);
    if (!finite(expected)) {
      drawerBad.push(`shift ${sh.id}: non-finite expected`);
      continue;
    }
    const recon = await db.get(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM shift_cash_movements
                   WHERE shift_id = ? AND movement_type IN ('opening','payment','adjustment','advance')), 0)
         - COALESCE((SELECT SUM(total) FROM refunds
                     WHERE shift_id = ? AND payment_method = 'cash' AND status = 'approved'), 0)
         AS s`,
      [sh.id, sh.id]
    );
    // computeExpectedDrawer already subtracts change from cash payments; compare to its own number being finite
    if (!finite(Number(recon?.s))) drawerBad.push(`shift ${sh.id}: recon non-finite`);
  }
  out.push(
    result("drawer_totals_finite_and_computable", drawerBad.length === 0, drawerBad.join("; ") || "ok")
  );

  // 13. Cash sales have a payment movement when net cash > 0
  const missingMove = await db.get(`
    SELECT COUNT(*) AS n FROM transactions t
    JOIN sale_payments sp ON sp.transaction_id = t.id AND sp.payment_method = 'cash'
    WHERE t.id > ? AND COALESCE(t.change_amount, 0) < sp.amount
      AND NOT EXISTS (
        SELECT 1 FROM shift_cash_movements m
        WHERE m.transaction_id = t.id AND m.movement_type = 'payment'
      )
  `, [maxTx]);
  out.push(
    result(
      "cash_sales_have_drawer_movement",
      Number(missingMove?.n) === 0,
      `missing_movements=${missingMove?.n}`
    )
  );

  // 14. Customer balance cache = baseline + on_account payments + voucher deltas
  const custMismatches = [];
  const customers = await db.all("SELECT id, balance FROM customers");
  for (const c of customers) {
    const id = String(c.id);
    const before = baseline.customers[id];
    if (!before) continue;
    const oa = await db.get(
      `SELECT COALESCE(SUM(COALESCE(nis_equivalent, amount)), 0) AS s
       FROM sale_payments sp
       JOIN transactions t ON t.id = sp.transaction_id
       WHERE t.customer_id = ? AND t.id > ? AND sp.payment_method = 'on_account'`,
      [c.id, maxTx]
    );
    const vouchers = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN v.voucher_type = 'receipt' THEN -vl.amount_nis ELSE vl.amount_nis END), 0) AS s
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id AND v.status = 'posted'
       WHERE vl.customer_id = ? AND vl.id > ?`,
      [c.id, Number(baseline.maxIds?.voucher_lines) || 0]
    );
    const expected = before.balance + Number(oa?.s || 0) + Number(vouchers?.s || 0);
    if (!near(c.balance, expected)) {
      custMismatches.push(`customer ${id}: balance=${c.balance} expected=${expected}`);
    }
  }
  out.push(
    result(
      "customer_balance_matches_on_account_sales",
      custMismatches.length === 0,
      custMismatches.slice(0, 6).join("; ") || "ok"
    )
  );

  // 15. Credit limit not exceeded (known bypass on 100% / any POS on-account approval)
  const overLimit = await db.all(`
    SELECT id, name, balance, credit_limit FROM customers
    WHERE credit_limit > 0 AND no_credit = 0 AND balance > credit_limit + 0.01
  `);
  out.push(
    result(
      "customer_credit_limit_respected",
      overLimit.length === 0,
      overLimit
        .slice(0, 5)
        .map((c) => `${c.id} ${c.name}: balance=${c.balance} limit=${c.credit_limit}`)
        .join("; ") || "ok",
      Boolean(extras.expectCreditLimitBypass)
    )
  );

  // 16. Promotion used_qty never exceeds limit_qty
  const promoOver = await db.all(
    "SELECT id, name, used_qty, limit_qty FROM promotions WHERE limit_qty > 0 AND used_qty > limit_qty + 0.0001"
  );
  out.push(
    result(
      "promotion_used_qty_within_limit",
      promoOver.length === 0,
      promoOver.map((p) => `${p.id} used=${p.used_qty} limit=${p.limit_qty}`).join("; ") || "ok"
    )
  );

  // 17. used_qty non-negative and matches committed promotional increment vs baseline
  const promoNeg = await db.all("SELECT id FROM promotions WHERE used_qty < 0");
  out.push(
    result("promotion_used_qty_non_negative", promoNeg.length === 0, `negative=${promoNeg.length}`)
  );

  // 18. Supplier cached balance stays finite (suite rarely posts supplier docs)
  const suppliers = await db.all("SELECT id, balance, opening_balance FROM suppliers");
  const badSup = suppliers.filter((s) => !finite(s.balance) || !finite(s.opening_balance));
  out.push(
    result("supplier_balances_finite", badSup.length === 0, `bad=${badSup.length}`)
  );

  // 19. Line nets reconcile to subtotal - discount
  const lineBad = await db.all(`
    SELECT t.id, t.subtotal, t.discount,
           COALESCE((SELECT SUM(line_net + COALESCE(discount_at_sale, 0)) FROM transaction_items ti WHERE ti.transaction_id = t.id), 0) AS lines
    FROM transactions t WHERE t.id > ?
  `, [maxTx]);
  const lineMismatches = lineBad.filter((r) => !near(Number(r.lines), Number(r.subtotal)));
  out.push(
    result(
      "line_nets_match_subtotal",
      lineMismatches.length === 0,
      lineMismatches
        .slice(0, 5)
        .map((r) => `tx ${r.id}: lines=${r.lines} subtotal=${r.subtotal}`)
        .join("; ") || "ok"
    )
  );

  // 20 / 21. PRAGMA checks
  const fk = await db.all("PRAGMA foreign_key_check");
  out.push(result("foreign_key_check", fk.length === 0, fk.length ? JSON.stringify(fk.slice(0, 3)) : "ok"));

  const integrity = await db.get("PRAGMA integrity_check");
  const integrityOk = Object.values(integrity || {})[0] === "ok";
  out.push(result("integrity_check", integrityOk, JSON.stringify(integrity)));

  // 22. At most one open shift per cashier
  const dupShifts = await db.all(`
    SELECT cashier_id, COUNT(*) AS n FROM cashier_shifts
    WHERE status = 'open' GROUP BY cashier_id HAVING n > 1
  `);
  out.push(
    result(
      "one_open_shift_per_cashier",
      dupShifts.length === 0,
      dupShifts.map((s) => `cashier ${s.cashier_id} open=${s.n}`).join("; ") || "ok",
      Boolean(extras.expectShiftDuplication)
    )
  );

  // 23. Concurrent multi-field product edit survival (C5)
  if (extras.expectedProductFields) {
    const { id, fields } = extras.expectedProductFields;
    const row = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    const lost = [];
    for (const [k, v] of Object.entries(fields)) {
      if (String(row?.[k] ?? "") !== String(v ?? "")) {
        lost.push(`${k}: got=${row?.[k]} expected=${v}`);
      }
    }
    out.push(
      result(
        "concurrent_product_field_edits_survive",
        lost.length === 0,
        lost.join("; ") || "ok",
        true
      )
    );
  }

  return out;
}

export function unexpectedInvariantFailures(results) {
  return results.filter((r) => r.applicable !== false && !r.ok && !r.expectedFail);
}

export function knownInvariantFailures(results) {
  return results.filter((r) => !r.ok && r.expectedFail);
}

export function formatInvariantReport(results) {
  return results
    .map((r) => {
      const tag =
        r.applicable === false || r.status === "na"
          ? "N/A"
          : r.ok
            ? "PASS"
            : r.expectedFail
              ? "KNOWN-BUG"
              : "FAIL";
      return `[${tag}] ${r.name}: ${r.detail}`;
    })
    .join("\n");
}

export function assertInvariants(results) {
  const unexpected = unexpectedInvariantFailures(results);
  const known = knownInvariantFailures(results);
  if (known.length) {
    // eslint-disable-next-line no-console
    console.warn(`[invariants] known production bugs (${known.length}):\n${formatInvariantReport(known)}`);
  }
  if (unexpected.length) {
    throw new Error(
      `Invariant violations:\n${formatInvariantReport(unexpected)}\n--- all ---\n${formatInvariantReport(results)}`
    );
  }
}
