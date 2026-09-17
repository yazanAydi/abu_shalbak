/**
 * Read-only finance validation of a shop database or VACUUM INTO backup.
 *
 * Does NOT:
 *   - start the API / initDatabase / migrations / seeds
 *   - set journal_mode=WAL (driver readonly path skips write PRAGMAs)
 *   - write rows, vacuum, copy, or replace any file
 *
 * Usage (from repo root or backend/):
 *   node backend/scripts/validate-finance-readonly.mjs --confirm-readonly-backup --db C:\path\to\supermarket.db --from 2026-09-01 --to 2026-09-16
 *
 * Then manually check the printed source rows against paper receipts / invoices.
 */
import fs from "fs";
import path from "path";
import { openSqliteConnection, closeSqliteConnection } from "../database/sqliteDriver.js";
import { buildFinanceOverview, parseOverviewRange } from "../utils/financeOverview.js";
import { postedPurchaseTotalsForDateRange } from "../utils/purchasePeriodTotals.js";
import { fetchRefundsForShopDateRange, fetchTransactionsForShopDateRange } from "../utils/businessDay.js";
import { snapshotRefundCogsForRange, snapshotSalesCogsForRange } from "../utils/cogs.js";
import { round2, sumMoney } from "../utils/money.js";

const FORBIDDEN_BASENAMES = new Set([
  "supermarket-dev.db",
  "perf.db",
  "test.db",
]);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node backend/scripts/validate-finance-readonly.mjs --confirm-readonly-backup --db <file> --from YYYY-MM-DD --to YYYY-MM-DD"
  );
  process.exit(2);
}

if (!process.argv.includes("--confirm-readonly-backup")) {
  usage("Refusing: pass --confirm-readonly-backup after you have a VACUUM INTO (or stopped-store) copy.");
}

const dbArg = argValue("--db");
const fromArg = argValue("--from");
const toArg = argValue("--to");
if (!dbArg) usage("Missing --db");
const range = parseOverviewRange({ from: fromArg, to: toArg });
if (range.error) usage(range.error);

const dbPath = path.resolve(dbArg);
const base = path.basename(dbPath);
if (FORBIDDEN_BASENAMES.has(base) || /dev|test|perf|loadtest/i.test(base)) {
  console.error(`Refusing test/dev database: ${dbPath}`);
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`File not found: ${dbPath}`);
  process.exit(2);
}

const st = fs.statSync(dbPath);
const db = await openSqliteConnection(dbPath, { readonly: true });

function looksLikeTestCatalog(products, sampleNames) {
  const testNames = /^(ryryr|testdli|test\d*|hgt|tyt|ii|yuy|tyrr|fgfdg|rt)$/i;
  const hits = sampleNames.filter((n) => testNames.test(String(n || "").trim())).length;
  return products < 80 && hits >= 3;
}

try {
  const integrity = await db.get("PRAGMA integrity_check");
  const identity = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM products) AS products,
       (SELECT COUNT(*) FROM transactions) AS transactions,
       (SELECT MAX(created_at) FROM transactions) AS latest_transaction,
       (SELECT COUNT(*) FROM customers) AS customers,
       (SELECT COUNT(*) FROM suppliers) AS suppliers`
  );
  const sampleNames = (
    await db.all("SELECT name FROM products ORDER BY id LIMIT 20")
  ).map((r) => r.name);

  if (looksLikeTestCatalog(Number(identity.products) || 0, sampleNames)) {
    console.error(
      JSON.stringify(
        {
          blocked: true,
          reason: "Catalog looks like the local test SKU set, not a shop extract.",
          path: dbPath,
          products: identity.products,
          sampleNames,
        },
        null,
        2
      )
    );
    process.exit(3);
  }

  const from = range.from;
  const to = range.to;
  const overview = await buildFinanceOverview(db, from, to);
  const purchasesHelper = await postedPurchaseTotalsForDateRange(db, from, to);
  const txs = await fetchTransactionsForShopDateRange(db, from, to);
  const refunds = await fetchRefundsForShopDateRange(db, from, to);
  const salesCogs = await snapshotSalesCogsForRange(db, from, to);
  const refundCogs = await snapshotRefundCogsForRange(db, from, to);

  const independent = {
    expenses: await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
       FROM operating_expenses WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    ),
    postedPurchases: await db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_invoices WHERE status = 'posted' AND invoice_date >= ? AND invoice_date <= ?`,
      [from, to]
    ),
    draftPurchases: await db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_invoices WHERE status != 'posted' AND invoice_date >= ? AND invoice_date <= ?`,
      [from, to]
    ),
    postedReturns: await db.get(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n
       FROM purchase_returns WHERE status = 'posted' AND return_date >= ? AND return_date <= ?`,
      [from, to]
    ),
    legacySupplierPayments: await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
       FROM supplier_payments WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    ),
    postedPaymentVouchers: await db.get(
      `SELECT COALESCE(SUM(vl.amount_nis), 0) AS total, COUNT(*) AS n
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.status = 'posted' AND v.voucher_type = 'payment'
         AND vl.supplier_id IS NOT NULL
         AND v.voucher_date >= ? AND v.voucher_date <= ?`,
      [from, to]
    ),
    receivables: await db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS total_due,
         SUM(CASE WHEN balance > 0.009 THEN 1 ELSE 0 END) AS owing
       FROM customers`
    ),
    inventory: await db.get(
      `SELECT
         COALESCE(SUM(stock * cost), 0) AS at_cost,
         COALESCE(SUM(stock * price), 0) AS at_retail,
         SUM(CASE WHEN stock < 0 THEN 1 ELSE 0 END) AS neg_count,
         SUM(CASE WHEN ABS(stock) > 0.009 AND cost IS NULL THEN 1 ELSE 0 END) AS null_cost_stocked,
         SUM(CASE WHEN ABS(stock) > 0.009 AND (price IS NULL OR price = 0) THEN 1 ELSE 0 END) AS zero_or_null_price_stocked
       FROM products`
    ),
  };

  const sampleSourceRecords = {
    sales: await db.all(
      `SELECT t.id, t.receipt_number, t.total, t.status, t.created_at, cs.start_time AS shift_start
       FROM transactions t
       LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id
       WHERE COALESCE(t.status, 'completed') = 'completed'
       ORDER BY t.id DESC
       LIMIT 8`
    ),
    refunds: await db.all(
      `SELECT id, original_transaction_id, total, status, created_at, items_json
       FROM refunds
       ORDER BY id DESC
       LIMIT 8`
    ),
    expenses: await db.all(
      `SELECT id, amount, paid_on, category, notes FROM operating_expenses
       WHERE paid_on >= ? AND paid_on <= ?
       ORDER BY id DESC LIMIT 8`,
      [from, to]
    ),
    purchaseInvoices: await db.all(
      `SELECT id, invoice_no, invoice_date, status, total, supplier_id, ref_text
       FROM purchase_invoices
       WHERE invoice_date >= ? AND invoice_date <= ?
       ORDER BY id DESC LIMIT 8`,
      [from, to]
    ),
    purchaseReturns: await db.all(
      `SELECT id, return_no, return_date, status, total, supplier_id
       FROM purchase_returns
       WHERE return_date >= ? AND return_date <= ?
       ORDER BY id DESC LIMIT 8`,
      [from, to]
    ),
    customersOwing: await db.all(
      `SELECT id, customer_code, name, balance FROM customers
       WHERE balance > 0.009
       ORDER BY balance DESC LIMIT 8`
    ),
    inventoryNegatives: await db.all(
      `SELECT id, sku, barcode, name, stock, cost, price,
              ROUND(stock * cost, 2) AS val_cost,
              ROUND(stock * price, 2) AS val_retail
       FROM products
       WHERE stock < 0
       ORDER BY (stock * price) ASC
       LIMIT 8`
    ),
    saleLinesWithCost: txs.length
      ? await db.all(
          `SELECT ti.transaction_id, ti.product_id, ti.name, ti.quantity, ti.unit_price,
                  ti.unit_cost_at_sale, ti.line_gross
           FROM transaction_items ti
           WHERE ti.transaction_id IN (${txs.slice(0, 5).map(() => "?").join(",")})
           ORDER BY ti.id DESC
           LIMIT 12`,
          txs.slice(0, 5).map((t) => t.id)
        )
      : [],
  };

  const recon = {
    salesGross_builder_vs_txSum: {
      builder: overview.sales.gross,
      independent: sumMoney(txs.map((t) => t.total)),
    },
    refunds_builder_vs_refundSum: {
      builder: overview.sales.refunds,
      independent: sumMoney(refunds.map((r) => r.total)),
    },
    cogs_builder_vs_snapshot: {
      builder: overview.profit.cogs,
      salesCogs: salesCogs.cogs,
      refundCogs: refundCogs.cogs,
      unknown: !!(salesCogs.unknown || refundCogs.unknown),
    },
    opex_builder_vs_sql: {
      builder: overview.profit.operatingExpenses,
      independent: round2(Number(independent.expenses.total) || 0),
    },
    purchases_builder_vs_sql: {
      builder: overview.purchases,
      helper: purchasesHelper,
      postedSql: {
        total: round2(Number(independent.postedPurchases.total) || 0),
        count: Number(independent.postedPurchases.n) || 0,
      },
      returnsSql: {
        total: round2(Number(independent.postedReturns.total) || 0),
        count: Number(independent.postedReturns.n) || 0,
      },
      draftsExcluded: independent.draftPurchases,
    },
    receivables_builder_vs_sql: {
      builder: overview.currentPosition.customerReceivables,
      independent: round2(Number(independent.receivables.total_due) || 0),
    },
    inventory_builder_vs_sql: {
      builderCost: overview.currentPosition.inventoryAtCost,
      builderRetail: overview.currentPosition.inventoryAtRetail,
      sqlCost: round2(Number(independent.inventory.at_cost) || 0),
      sqlRetail: round2(Number(independent.inventory.at_retail) || 0),
    },
  };

  console.log(
    JSON.stringify(
      {
        readonly: true,
        bypassed: ["server.js", "initDatabase", "migrations", "WAL pragma"],
        file: {
          path: dbPath,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        },
        integrity: integrity?.integrity_check ?? integrity,
        identity,
        range: { from, to },
        dashboard: {
          sales: overview.sales,
          profit: overview.profit,
          purchases: overview.purchases,
          supplierPayments: overview.supplierPayments,
          currentPosition: overview.currentPosition,
        },
        recon,
        sampleSourceRecords,
        manualChecks: [
          "Pick 2 sale rows from sampleSourceRecords.sales and confirm total against the printed receipt.",
          "Pick 1 refund and confirm original_transaction_id, qty in items_json, and unit_cost_at_sale on the original sale line.",
          "Pick 1 posted purchase_invoices row and confirm invoice_date + total against the supplier invoice.",
          "Pick 1 operating_expenses row and confirm paid_on + amount against the voucher/receipt.",
          "Pick 1 customer from customersOwing and confirm balance against the customer statement.",
          "Pick 1 inventoryNegatives row and confirm stock on the shelf / last count — do not write a correction from this script.",
        ],
      },
      null,
      2
    )
  );
} finally {
  await closeSqliteConnection(db);
}
