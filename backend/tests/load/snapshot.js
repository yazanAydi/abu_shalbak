/**
 * Before/after snapshots for invariant math.
 * Stock is a live cache: final = baseline + ledger deltas after maxLedgerId.
 */

function toMap(rows, key, pick) {
  const out = {};
  for (const row of rows) out[String(row[key])] = pick(row);
  return out;
}

export async function captureBaseline(db) {
  const products = await db.all(
    "SELECT id, stock, price, name, min_stock, category, barcode FROM products"
  );
  const customers = await db.all(
    "SELECT id, balance, opening_balance, credit_limit, no_credit, name FROM customers"
  );
  const suppliers = await db.all(
    "SELECT id, balance, opening_balance, name FROM suppliers"
  );
  const promotions = await db.all("SELECT id, used_qty, limit_qty, name FROM promotions");
  const counts = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM transactions) AS transactions,
      (SELECT COUNT(*) FROM transaction_items) AS transaction_items,
      (SELECT COUNT(*) FROM sale_payments) AS sale_payments,
      (SELECT COUNT(*) FROM inventory_ledger) AS ledger,
      (SELECT COUNT(*) FROM refunds) AS refunds,
      (SELECT COUNT(*) FROM refund_requests) AS refund_requests,
      (SELECT COUNT(*) FROM on_account_requests) AS on_account_requests,
      (SELECT COUNT(*) FROM cashier_shifts) AS shifts
  `);
  const maxIds = await db.get(`
    SELECT
      COALESCE((SELECT MAX(id) FROM inventory_ledger), 0) AS ledger,
      COALESCE((SELECT MAX(id) FROM transactions), 0) AS transactions,
      COALESCE((SELECT MAX(id) FROM sale_payments), 0) AS sale_payments,
      COALESCE((SELECT MAX(id) FROM transaction_items), 0) AS transaction_items,
      COALESCE((SELECT MAX(id) FROM refunds), 0) AS refunds,
      COALESCE((SELECT MAX(id) FROM voucher_lines), 0) AS voucher_lines,
      COALESCE((SELECT MAX(id) FROM employee_settlements), 0) AS employee_settlements
  `);
  const reversedSettlements = await db.all(
    "SELECT id FROM employee_settlements WHERE kind = 'debt' AND status = 'reversed'"
  );
  const year = new Date().getFullYear();
  const seq = await db.get(
    "SELECT last_seq FROM receipt_sequences WHERE store_id = 1 AND year = ?",
    [year]
  );
  return {
    capturedAt: new Date().toISOString(),
    year,
    products: toMap(products, "id", (p) => ({
      stock: Number(p.stock) || 0,
      price: Number(p.price) || 0,
      name: p.name,
      min_stock: p.min_stock,
      category: p.category,
      barcode: p.barcode,
    })),
    customers: toMap(customers, "id", (c) => ({
      balance: Number(c.balance) || 0,
      opening_balance: Number(c.opening_balance) || 0,
      credit_limit: Number(c.credit_limit) || 0,
      no_credit: Number(c.no_credit) || 0,
      name: c.name,
    })),
    suppliers: toMap(suppliers, "id", (s) => ({
      balance: Number(s.balance) || 0,
      opening_balance: Number(s.opening_balance) || 0,
      name: s.name,
    })),
    promotions: toMap(promotions, "id", (p) => ({
      used_qty: Number(p.used_qty) || 0,
      limit_qty: Number(p.limit_qty) || 0,
      name: p.name,
    })),
    counts,
    maxIds,
    reversedSettlementIds: reversedSettlements.map((row) => row.id),
    receiptSeq: Number(seq?.last_seq) || 0,
  };
}

export async function diffBaseline(db, baseline) {
  const now = await captureBaseline(db);
  return { before: baseline, after: now };
}
