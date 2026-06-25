import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import bcrypt from "bcrypt";
import { seedDefaultSettings } from "../utils/settings.js";
import { backfillMissingEntityCodes } from "../utils/entityCodes.js";

/** @param {import("sqlite3").Database} raw */
function wrapDb(raw) {
  return {
    raw,
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        raw.run(sql, params, function onRun(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        raw.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        raw.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        raw.exec(sql, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function tableHasColumn(db, table, colName) {
  const row = await db.get(`SELECT 1 as x FROM pragma_table_info(?) WHERE name = ? LIMIT 1`, [
    table,
    colName,
  ]);
  return !!row;
}

async function migrateAppSettingsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function migrateProductsExtendedColumns(db) {
  const cols = [
    ["tax_rate", "REAL"],
    ["name_en", "TEXT"],
    ["unit", "TEXT"],
    ["expiry_date", "TEXT"],
    ["min_price", "REAL"],
    ["max_price", "REAL"],
    ["sku", "TEXT"],
    ["image_url", "TEXT"],
    // Product deactivation: inactive products are hidden from POS and rejected
    // at checkout, but never hard-deleted (history/reports stay intact).
    ["is_active", "INTEGER NOT NULL DEFAULT 1"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "products", col))) {
      await db.run(`ALTER TABLE products ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateTransactionItemsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      product_id     INTEGER REFERENCES products(id),
      barcode        TEXT,
      name           TEXT NOT NULL,
      quantity       REAL NOT NULL,
      unit_price     REAL NOT NULL,
      line_net       REAL NOT NULL,
      line_tax       REAL NOT NULL DEFAULT 0,
      line_gross     REAL NOT NULL,
      tax_rate       REAL NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tx_items_tx   ON transaction_items(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_tx_items_prod ON transaction_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_tx_items_date ON transaction_items(created_at);
  `);
}

async function migrateTransactionItemsPriceSnapshots(db) {
  const cols = [
    ["unit_cost_at_sale", "REAL"],
    ["gross_profit", "REAL"],
    ["discount_at_sale", "REAL NOT NULL DEFAULT 0"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "transaction_items", col))) {
      await db.run(`ALTER TABLE transaction_items ADD COLUMN ${col} ${type}`);
    }
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tx_items_prod_price
      ON transaction_items(product_id, unit_price);
  `);
}

async function migrateTransactionItemsScannedBarcode(db) {
  const cols = [
    ["scanned_barcode", "TEXT"],
    ["product_barcode_id", "INTEGER REFERENCES product_barcodes(id)"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "transaction_items", col))) {
      await db.run(`ALTER TABLE transaction_items ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateProductBarcodesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_barcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL UNIQUE,
      label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode ON product_barcodes(barcode);
  `);
}

/** Copy products.barcode into product_barcodes (one primary row per product). */
async function migrateProductBarcodesFromProducts(db) {
  const rows = await db.all("SELECT id, barcode FROM products WHERE barcode IS NOT NULL AND trim(barcode) != ''");
  for (const { id, barcode } of rows) {
    const cleaned = bestDigitBarcodeValue(barcode) || String(barcode).trim();
    if (!cleaned) continue;
    const existing = await db.get("SELECT id FROM product_barcodes WHERE barcode = ?", [cleaned]);
    if (existing) continue;
    const hasPrimary = await db.get(
      "SELECT id FROM product_barcodes WHERE product_id = ? AND is_primary = 1",
      [id]
    );
    await db.run(
      "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, ?)",
      [id, cleaned, hasPrimary ? 0 : 1]
    );
  }
}

async function migrateCustomersTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      phone           TEXT,
      phone2          TEXT,
      address         TEXT,
      city            TEXT,
      price_category  TEXT DEFAULT 'retail',
      credit_limit    REAL NOT NULL DEFAULT 0,
      balance         REAL NOT NULL DEFAULT 0,
      no_credit       INTEGER NOT NULL DEFAULT 0,
      notes           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
  `);

  if (!(await tableHasColumn(db, "transactions", "customer_id"))) {
    await db.run("ALTER TABLE transactions ADD COLUMN customer_id INTEGER REFERENCES customers(id)");
  }
  if (!(await tableHasColumn(db, "refunds", "customer_id"))) {
    await db.run("ALTER TABLE refunds ADD COLUMN customer_id INTEGER REFERENCES customers(id)");
  }
  const pmethods = ["cash", "visa", "on_account"];
  const txChk = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'`);
  if (txChk?.sql && !txChk.sql.includes("on_account")) {
    // SQLite cannot modify CHECK constraints; recreate is complex. We accept the old constraint
    // and enforce on_account validation in the application layer instead.
  }
}

async function migrateBankAccountsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      bank_name   TEXT,
      account_no  TEXT,
      currency    TEXT NOT NULL DEFAULT 'NIS',
      balance     REAL NOT NULL DEFAULT 0,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bank_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      check_type    TEXT NOT NULL CHECK (check_type IN ('received','issued')),
      check_no      TEXT,
      bank_name     TEXT,
      branch        TEXT,
      amount        REAL NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'NIS',
      due_date      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','bounced','cancelled')),
      customer_id   INTEGER REFERENCES customers(id),
      supplier_id   INTEGER REFERENCES suppliers(id),
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      notes         TEXT,
      recorded_by_id INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_checks_status   ON bank_checks(status);
    CREATE INDEX IF NOT EXISTS idx_checks_due      ON bank_checks(due_date);
    CREATE INDEX IF NOT EXISTS idx_checks_customer ON bank_checks(customer_id);
  `);
}

async function migrateSuppliersBalance(db) {
  if (!(await tableHasColumn(db, "suppliers", "balance"))) {
    await db.run("ALTER TABLE suppliers ADD COLUMN balance REAL NOT NULL DEFAULT 0");
  }
}

async function migrateVouchersTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_type   TEXT NOT NULL CHECK (voucher_type IN ('receipt','payment')),
      voucher_no     INTEGER,
      voucher_date   TEXT NOT NULL DEFAULT (date('now')),
      status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      total_amount   REAL NOT NULL DEFAULT 0,
      notes          TEXT,
      recorded_by_id INTEGER REFERENCES users(id),
      posted_at      TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS voucher_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      line_type       TEXT NOT NULL CHECK (line_type IN ('cash','check','bank')),
      amount          REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'NIS',
      exchange_rate   REAL NOT NULL DEFAULT 1,
      amount_nis      REAL NOT NULL,
      customer_id     INTEGER REFERENCES customers(id),
      supplier_id     INTEGER REFERENCES suppliers(id),
      check_id        INTEGER REFERENCES bank_checks(id),
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      account_category TEXT,
      bank_name        TEXT,
      description     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vouchers_date   ON vouchers(voucher_date);
    CREATE INDEX IF NOT EXISTS idx_vouchers_type   ON vouchers(voucher_type);
    CREATE INDEX IF NOT EXISTS idx_vlines_voucher  ON voucher_lines(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_vlines_customer ON voucher_lines(customer_id);
  `);

  if (!(await tableHasColumn(db, "vouchers", "voucher_no"))) {
    await db.run("ALTER TABLE vouchers ADD COLUMN voucher_no INTEGER");
  }
  if (!(await tableHasColumn(db, "voucher_lines", "bank_name"))) {
    await db.run("ALTER TABLE voucher_lines ADD COLUMN bank_name TEXT");
  }
}

async function migrateStockCountTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_count_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      posted_at    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_count_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      system_qty  REAL NOT NULL,
      counted_qty REAL NOT NULL,
      variance    REAL NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sc_lines_session ON stock_count_lines(session_id);
    CREATE INDEX IF NOT EXISTS idx_sc_lines_product ON stock_count_lines(product_id);
  `);
}

async function migrateTransactionsDiscount(db) {
  if (!(await tableHasColumn(db, "transactions", "discount"))) {
    await db.run("ALTER TABLE transactions ADD COLUMN discount REAL NOT NULL DEFAULT 0");
  }
}

async function migrateInventoryMovementsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL,
      quantity      REAL NOT NULL,
      unit_cost     REAL,
      warehouse_id  INTEGER,
      ref_type      TEXT,
      ref_id        INTEGER,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_moves_product ON inventory_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_inv_moves_type    ON inventory_movements(movement_type);
    CREATE INDEX IF NOT EXISTS idx_inv_moves_date    ON inventory_movements(created_at);
    CREATE INDEX IF NOT EXISTS idx_inv_moves_ref     ON inventory_movements(ref_type, ref_id);
  `);
}

async function migrateCustomersErpColumns(db) {
  const cols = [
    ["customer_code", "TEXT"],
    ["payment_terms", "TEXT"],
    ["opening_balance", "REAL NOT NULL DEFAULT 0"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "customers", col))) {
      await db.run(`ALTER TABLE customers ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateCustomerBalanceGroups(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customer_balance_groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE,
      label_ar   TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system  INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const count = await db.get("SELECT COUNT(*) AS c FROM customer_balance_groups");
  if (count.c === 0) {
    for (const g of [
      { slug: "zaboon", label_ar: "أرصدة الزبون", sort_order: 1 },
      { slug: "mashghilin", label_ar: "أرصدة المشغلين", sort_order: 2 },
      { slug: "omara", label_ar: "أرصدة العمارة", sort_order: 3 },
    ]) {
      await db.run(
        "INSERT INTO customer_balance_groups (slug, label_ar, sort_order, is_system) VALUES (?, ?, ?, 1)",
        [g.slug, g.label_ar, g.sort_order]
      );
    }
  }

  if (!(await tableHasColumn(db, "customers", "balance_group_id"))) {
    await db.run(
      "ALTER TABLE customers ADD COLUMN balance_group_id INTEGER REFERENCES customer_balance_groups(id)"
    );
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_balance_group ON customers(balance_group_id);
  `);

  const groups = await db.all("SELECT id, slug FROM customer_balance_groups");
  const bySlug = Object.fromEntries(groups.map((g) => [g.slug, g.id]));

  if (bySlug.mashghilin) {
    await db.run(
      `UPDATE customers SET balance_group_id = ?
       WHERE balance_group_id IS NULL AND notes LIKE '%مشغل%'`,
      [bySlug.mashghilin]
    );
  }
  if (bySlug.omara) {
    await db.run(
      `UPDATE customers SET balance_group_id = ?
       WHERE balance_group_id IS NULL AND notes LIKE '%عمارة%'`,
      [bySlug.omara]
    );
  }
  if (bySlug.zaboon) {
    await db.run(
      `UPDATE customers SET balance_group_id = ?
       WHERE balance_group_id IS NULL`,
      [bySlug.zaboon]
    );
  }
}

async function migrateSuppliersErpColumns(db) {
  const cols = [
    ["supplier_code", "TEXT"],
    ["address", "TEXT"],
    ["payment_terms", "TEXT"],
    ["opening_balance", "REAL NOT NULL DEFAULT 0"],
    ["statement_pdf_updated_at", "TEXT"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "suppliers", col))) {
      await db.run(`ALTER TABLE suppliers ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateSupplierOpeningBalanceMeta(db) {
  const supplierCols = [
    ["opening_balance_date", "TEXT"],
    ["opening_balance_source", "TEXT"],
    ["opening_balance_excel", "REAL"],
  ];
  for (const [col, type] of supplierCols) {
    if (!(await tableHasColumn(db, "suppliers", col))) {
      await db.run(`ALTER TABLE suppliers ADD COLUMN ${col} ${type}`);
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS party_opening_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      party_type   TEXT NOT NULL,
      party_id     INTEGER NOT NULL,
      entry_date   TEXT NOT NULL,
      description  TEXT NOT NULL,
      debit        REAL NOT NULL DEFAULT 0,
      credit       REAL NOT NULL DEFAULT 0,
      source_type  TEXT NOT NULL,
      source_id    TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_party_opening_entries_party
      ON party_opening_entries (party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_party_opening_entries_source
      ON party_opening_entries (party_type, party_id, source_type);
  `);

  await db.run(
    `UPDATE suppliers
     SET opening_balance_excel = -opening_balance
     WHERE opening_balance_source = 'hesabati_import'
       AND opening_balance_excel IS NULL`
  );
}

async function migrateAccountStatementEntries(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS account_statement_entries (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      party_type              TEXT NOT NULL,
      party_id                INTEGER NOT NULL,
      import_batch_id         TEXT NOT NULL,
      legacy_reference_number TEXT,
      entry_date              TEXT,
      description             TEXT NOT NULL,
      debit                   REAL NOT NULL DEFAULT 0,
      credit                  REAL NOT NULL DEFAULT 0,
      running_balance         REAL NOT NULL DEFAULT 0,
      notes                   TEXT,
      source_type             TEXT NOT NULL DEFAULT 'hesabati_history_import',
      source_file_name        TEXT,
      row_order               INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ase_party
      ON account_statement_entries (party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_ase_party_date
      ON account_statement_entries (party_type, party_id, entry_date, row_order);
    CREATE INDEX IF NOT EXISTS idx_ase_party_source
      ON account_statement_entries (party_type, party_id, source_type);
  `);
}

async function migratePurchasesTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no     INTEGER,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      order_date   TEXT NOT NULL DEFAULT (date('now')),
      status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','received','cancelled')),
      total_amount REAL NOT NULL DEFAULT 0,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_cost   REAL NOT NULL DEFAULT 0,
      line_total  REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no          INTEGER,
      supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
      order_id            INTEGER REFERENCES purchase_orders(id),
      supplier_invoice_id INTEGER REFERENCES supplier_invoices(id),
      ref_text            TEXT,
      invoice_date        TEXT NOT NULL DEFAULT (date('now')),
      status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      subtotal            REAL NOT NULL DEFAULT 0,
      vat                 REAL NOT NULL DEFAULT 0,
      total               REAL NOT NULL DEFAULT 0,
      notes               TEXT,
      created_by          INTEGER REFERENCES users(id),
      posted_at           TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_cost   REAL NOT NULL DEFAULT 0,
      vat_rate    REAL NOT NULL DEFAULT 0,
      line_net    REAL NOT NULL DEFAULT 0,
      line_vat    REAL NOT NULL DEFAULT 0,
      line_total  REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      return_no    INTEGER,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      invoice_id   INTEGER REFERENCES purchase_invoices(id),
      return_date  TEXT NOT NULL DEFAULT (date('now')),
      status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      total        REAL NOT NULL DEFAULT 0,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      posted_at    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS purchase_return_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id   INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_cost   REAL NOT NULL DEFAULT 0,
      line_total  REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_po_supplier   ON purchase_orders(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_poi_order     ON purchase_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_pinv_supplier ON purchase_invoices(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_pinvi_invoice ON purchase_invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_pret_supplier ON purchase_returns(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_preti_return  ON purchase_return_items(return_id);
  `);
}

async function migrateStockAdjustmentsTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_no    INTEGER,
      adjustment_date  TEXT NOT NULL DEFAULT (date('now')),
      adjustment_type  TEXT NOT NULL CHECK (adjustment_type IN ('in','out','damage','consumption','correction')),
      status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      notes            TEXT,
      created_by       INTEGER REFERENCES users(id),
      posted_at        TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_adjustment_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_id INTEGER NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
      product_id    INTEGER NOT NULL REFERENCES products(id),
      quantity      REAL NOT NULL,
      unit_cost     REAL,
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_adj_items_adj ON stock_adjustment_items(adjustment_id);
  `);
}

async function migrateProductBatchesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL REFERENCES products(id),
      batch_no    TEXT,
      expiry_date TEXT,
      quantity    REAL NOT NULL DEFAULT 0,
      cost        REAL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_id);
    CREATE INDEX IF NOT EXISTS idx_batches_expiry  ON product_batches(expiry_date);
  `);
}

async function migrateExpenseCategoriesTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      name_ar    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (!(await tableHasColumn(db, "operating_expenses", "category_id"))) {
    await db.run("ALTER TABLE operating_expenses ADD COLUMN category_id INTEGER REFERENCES expense_categories(id)");
  }
  const count = await db.get("SELECT COUNT(*) AS c FROM expense_categories");
  if (count.c === 0) {
    const seed = [
      ["rent", "إيجار"],
      ["electricity", "كهرباء"],
      ["internet", "إنترنت"],
      ["transportation", "نقل ومواصلات"],
      ["maintenance", "صيانة"],
      ["cleaning", "نظافة"],
      ["salaries", "رواتب"],
    ];
    for (const [name, name_ar] of seed) {
      await db.run("INSERT INTO expense_categories (name, name_ar) VALUES (?, ?)", [name, name_ar]);
    }
  }
}

async function migrateDeliveriesTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sales_deliveries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_no    INTEGER,
      transaction_id INTEGER REFERENCES transactions(id),
      customer_id    INTEGER REFERENCES customers(id),
      driver         TEXT,
      vehicle        TEXT,
      address        TEXT,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','out','delivered','cancelled')),
      delivery_date  TEXT NOT NULL DEFAULT (date('now')),
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS purchase_receivings (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      receiving_no        INTEGER,
      purchase_invoice_id INTEGER REFERENCES purchase_invoices(id),
      supplier_id         INTEGER REFERENCES suppliers(id),
      driver              TEXT,
      vehicle             TEXT,
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
      received_date       TEXT NOT NULL DEFAULT (date('now')),
      notes               TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_deliveries_status ON sales_deliveries(status);
    CREATE INDEX IF NOT EXISTS idx_purchase_recv_status    ON purchase_receivings(status);
  `);
}

async function migrateMarketingTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      start_date  TEXT,
      end_date    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promotions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id    INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
      name           TEXT NOT NULL,
      offer_type     TEXT NOT NULL CHECK (offer_type IN ('percentage','fixed','bundle','buy_x_get_y')),
      product_id     INTEGER REFERENCES products(id),
      category       TEXT,
      discount_value REAL NOT NULL DEFAULT 0,
      buy_qty        REAL NOT NULL DEFAULT 0,
      get_qty        REAL NOT NULL DEFAULT 0,
      min_amount     REAL NOT NULL DEFAULT 0,
      start_date     TEXT,
      end_date       TEXT,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_promotions_active  ON promotions(active);
    CREATE INDEX IF NOT EXISTS idx_promotions_product ON promotions(product_id);
  `);
}

async function migrateWarehousesTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      code       TEXT,
      type       TEXT NOT NULL DEFAULT 'main' CHECK (type IN ('main','store','returns','damaged')),
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS warehouse_stock (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      product_id   INTEGER NOT NULL REFERENCES products(id),
      quantity     REAL NOT NULL DEFAULT 0,
      UNIQUE(warehouse_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_no       INTEGER,
      from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      to_warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
      transfer_date     TEXT NOT NULL DEFAULT (date('now')),
      status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      posted_at         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id  INTEGER NOT NULL REFERENCES warehouse_transfers(id) ON DELETE CASCADE,
      product_id   INTEGER NOT NULL REFERENCES products(id),
      quantity     REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wh_stock_wh   ON warehouse_stock(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_wh_stock_prod ON warehouse_stock(product_id);
    CREATE INDEX IF NOT EXISTS idx_wh_tr_items   ON warehouse_transfer_items(transfer_id);
  `);
  const count = await db.get("SELECT COUNT(*) AS c FROM warehouses");
  if (count.c === 0) {
    const seed = [
      ["المستودع الرئيسي", "MAIN", "main"],
      ["مستودع المتجر", "STORE", "store"],
      ["مستودع المرتجعات", "RET", "returns"],
      ["مستودع التالف", "DMG", "damaged"],
    ];
    for (const [name, code, type] of seed) {
      await db.run("INSERT INTO warehouses (name, code, type) VALUES (?, ?, ?)", [name, code, type]);
    }
  }
}

async function migrateSupplierPaymentInvoiceId(db) {
  if (await tableHasColumn(db, "supplier_payments", "invoice_id")) return;
  await db.run("ALTER TABLE supplier_payments ADD COLUMN invoice_id INTEGER REFERENCES supplier_invoices(id)");
}

async function migrateCashierShiftsTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      start_time TEXT NOT NULL DEFAULT (datetime('now')),
      end_time TEXT,
      opening_cash REAL NOT NULL,
      closing_cash REAL,
      expected_cash REAL,
      variance REAL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_count', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shift_cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL REFERENCES cashier_shifts(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN ('opening', 'payment', 'refund', 'adjustment', 'closing')),
      amount REAL NOT NULL,
      description TEXT,
      transaction_id INTEGER REFERENCES transactions(id),
      refund_id INTEGER REFERENCES refunds(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_cashier_status ON cashier_shifts(cashier_id, status);
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_start ON cashier_shifts(start_time);
    CREATE INDEX IF NOT EXISTS idx_shift_movements_shift_time ON shift_cash_movements(shift_id, created_at);
  `);
}

async function migrateTransactionsShiftId(db) {
  if (await tableHasColumn(db, "transactions", "shift_id")) return;
  await db.run(
    "ALTER TABLE transactions ADD COLUMN shift_id INTEGER REFERENCES cashier_shifts(id)"
  );
}

async function migrateRefundsShiftId(db) {
  if (await tableHasColumn(db, "refunds", "shift_id")) return;
  await db.run("ALTER TABLE refunds ADD COLUMN shift_id INTEGER REFERENCES cashier_shifts(id)");
}

async function migrateRefundsWorkflow(db) {
  if (!(await tableHasColumn(db, "refunds", "status"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
  }
  await db.run(`UPDATE refunds SET status = 'approved' WHERE status IS NULL OR TRIM(COALESCE(status,'')) = ''`);
  if (!(await tableHasColumn(db, "refunds", "approved_at"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN approved_at TEXT`);
  }
  if (!(await tableHasColumn(db, "refunds", "approved_by_id"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN approved_by_id INTEGER REFERENCES users(id)`);
  }
  if (!(await tableHasColumn(db, "refunds", "review_notes"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN review_notes TEXT`);
  }
  if (!(await tableHasColumn(db, "refunds", "rejected_at"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN rejected_at TEXT`);
  }
  if (!(await tableHasColumn(db, "refunds", "rejected_by_id"))) {
    await db.run(`ALTER TABLE refunds ADD COLUMN rejected_by_id INTEGER REFERENCES users(id)`);
  }
  await db.run(
    `UPDATE refunds SET approved_at = created_at WHERE status = 'approved' AND approved_at IS NULL`
  );
}

async function migrateUsersRoleConstraint(db) {
  const usersMig = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='users__mig' LIMIT 1"
  );
  const usersT = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='users' LIMIT 1"
  );
  if (usersMig && !usersT) {
    // Previous run: copied data into users__mig then stopped before the rename
    await db.run("ALTER TABLE users__mig RENAME TO users");
    return;
  }
  if (usersMig) {
    await db.run("DROP TABLE IF EXISTS users__mig");
  }

  const row = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  );
  if (!row?.sql || !String(row.sql).includes("CHECK (role IN")) return;
  // Must drop `users` while other tables (e.g. transactions) reference it — disable FKs for this swap only.
  await db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE users__mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users__mig (id, username, password, role, created_at)
      SELECT id, username, password, role, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users__mig RENAME TO users;
    PRAGMA foreign_keys = ON;
  `);
}

async function migrateLegacyIfNeeded(db) {
  const u = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  );
  if (!u) return;
  const legacyEmail = await tableHasColumn(db, "users", "email");
  if (!legacyEmail) return;

  await db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS daily_reports;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS users;
    PRAGMA foreign_keys = ON;
  `);
}

async function migrateAuditLogsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER,
      username    TEXT,
      role        TEXT,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   INTEGER,
      old_value   TEXT,
      new_value   TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
  `);
}

async function migrateProductPriceHistoryTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_price_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id         INTEGER NOT NULL REFERENCES products(id),
      old_price          REAL,
      new_price          REAL NOT NULL,
      changed_by_user_id INTEGER REFERENCES users(id),
      reason             TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_price_history(product_id);
    CREATE INDEX IF NOT EXISTS idx_price_history_created ON product_price_history(created_at);
  `);
}

async function migrateInventoryLedgerTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL REFERENCES products(id),
      movement_type  TEXT NOT NULL CHECK (movement_type IN (
        'sale','refund','purchase_receive','supplier_return',
        'manual_adjustment','warehouse_transfer_in','warehouse_transfer_out',
        'stock_count_correction','expiry_writeoff'
      )),
      quantity_delta INTEGER NOT NULL,
      qty_before     INTEGER,
      qty_after      INTEGER,
      reference_type TEXT,
      reference_id   INTEGER,
      notes          TEXT,
      user_id        INTEGER,
      store_id       INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_ledger_product ON inventory_ledger(product_id);
    CREATE INDEX IF NOT EXISTS idx_inv_ledger_ref ON inventory_ledger(reference_type, reference_id);
    CREATE INDEX IF NOT EXISTS idx_inv_ledger_created ON inventory_ledger(created_at);
  `);
}

async function migrateEntityCodeSequencesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_code_sequences (
      entity_type TEXT PRIMARY KEY,
      last_seq    INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function migrateReceiptSequencesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_sequences (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      year     INTEGER NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE(store_id, year)
    );
  `);
  if (!(await tableHasColumn(db, "transactions", "receipt_number"))) {
    await db.run("ALTER TABLE transactions ADD COLUMN receipt_number TEXT");
  }
  if (!(await tableHasColumn(db, "transactions", "status"))) {
    await db.run(
      "ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"
    );
  }
  if (!(await tableHasColumn(db, "transactions", "store_id"))) {
    await db.run("ALTER TABLE transactions ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1");
  }
  // Server-side checkout idempotency: a client-supplied key dedupes retries /
  // double submissions. Unique partial index lets concurrent duplicates fail
  // fast with SQLITE_CONSTRAINT so we can return the original sale.
  if (!(await tableHasColumn(db, "transactions", "idempotency_key"))) {
    await db.run("ALTER TABLE transactions ADD COLUMN idempotency_key TEXT");
  }
  await db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_receipt_number ON transactions(receipt_number) WHERE receipt_number IS NOT NULL"
  );
  await db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL"
  );
}

async function migrateShiftReconciliationExtended(db) {
  const cols = [
    ["actual_cash", "REAL"],
    ["card_total", "REAL"],
    ["refund_total", "REAL"],
    ["closing_notes", "TEXT"],
    ["manager_approved_by", "INTEGER REFERENCES users(id)"],
    ["manager_approved_at", "TEXT"],
    ["variance_threshold", "REAL"],
    ["requires_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["store_id", "INTEGER NOT NULL DEFAULT 1"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "cashier_shifts", col))) {
      await db.run(`ALTER TABLE cashier_shifts ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateCashierShiftsPendingStatus(db) {
  const row = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='cashier_shifts'"
  );
  if (!row?.sql || String(row.sql).includes("pending_count")) return;

  const migExists = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='cashier_shifts__mig' LIMIT 1"
  );
  if (migExists) {
    await db.run("DROP TABLE IF EXISTS cashier_shifts__mig");
  }

  await db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE cashier_shifts__mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      start_time TEXT NOT NULL DEFAULT (datetime('now')),
      end_time TEXT,
      opening_cash REAL NOT NULL,
      closing_cash REAL,
      expected_cash REAL,
      variance REAL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_count', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actual_cash REAL,
      card_total REAL,
      refund_total REAL,
      closing_notes TEXT,
      manager_approved_by INTEGER REFERENCES users(id),
      manager_approved_at TEXT,
      variance_threshold REAL,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      store_id INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO cashier_shifts__mig (
      id, cashier_id, start_time, end_time, opening_cash, closing_cash, expected_cash,
      variance, notes, status, created_at, actual_cash, card_total, refund_total,
      closing_notes, manager_approved_by, manager_approved_at, variance_threshold,
      requires_approval, store_id
    )
    SELECT
      id, cashier_id, start_time, end_time, opening_cash, closing_cash, expected_cash,
      variance, notes, status, created_at, actual_cash, card_total, refund_total,
      closing_notes, manager_approved_by, manager_approved_at, variance_threshold,
      requires_approval, COALESCE(store_id, 1)
    FROM cashier_shifts;
    DROP TABLE cashier_shifts;
    ALTER TABLE cashier_shifts__mig RENAME TO cashier_shifts;
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_cashier_status ON cashier_shifts(cashier_id, status);
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_start ON cashier_shifts(start_time);
    PRAGMA foreign_keys = ON;
  `);
}

async function migrateRefundRequestsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      manager_id INTEGER REFERENCES users(id),
      shift_id INTEGER REFERENCES cashier_shifts(id),
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      tax REAL NOT NULL,
      total_amount REAL NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'visa')),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      telegram_message_id TEXT,
      refund_id INTEGER REFERENCES refunds(id),
      review_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      rejected_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_refund_requests_status_created ON refund_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_cashier ON refund_requests(cashier_id);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_tx ON refund_requests(transaction_id);
  `);
}

async function migrateRefundRequestSyncColumns(db) {
  const cols = [
    ["decision_source", "TEXT"],
    ["cashier_notified_at", "TEXT"],
    ["cashier_acknowledged_at", "TEXT"],
  ];
  for (const [col, type] of cols) {
    if (!(await tableHasColumn(db, "refund_requests", col))) {
      await db.run(`ALTER TABLE refund_requests ADD COLUMN ${col} ${type}`);
    }
  }
}

async function migrateLegacyPendingRefundsToRequests(db) {
  const pending = await db.all("SELECT * FROM refunds WHERE status = 'pending'");
  if (!pending.length) return;

  for (const r of pending) {
    const ex = await db.get(
      "SELECT 1 AS x FROM refund_requests WHERE transaction_id = ? AND cashier_id = ? AND status = 'pending' AND created_at = ? LIMIT 1",
      [r.original_transaction_id, r.cashier_id, r.created_at]
    );
    if (ex) continue;
    await db.run(
      `INSERT INTO refund_requests (
        transaction_id, cashier_id, shift_id, items_json, subtotal, tax, total_amount,
        payment_method, reason, status, review_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        r.original_transaction_id,
        r.cashier_id,
        r.shift_id ?? null,
        r.items_json,
        r.subtotal,
        r.tax,
        r.total,
        r.payment_method,
        r.reason,
        r.review_notes ?? null,
        r.created_at,
      ]
    );
  }
  await db.run("DELETE FROM refunds WHERE status = 'pending'");
}

async function migrateMustChangePasswordColumn(db) {
  if (!(await tableHasColumn(db, "users", "must_change_password"))) {
    await db.run(
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"
    );
  }
}

async function migrateStoresTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      name_ar    TEXT,
      branch_code TEXT UNIQUE,
      address    TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await db.run(
    `INSERT OR IGNORE INTO stores (id, name, name_ar, branch_code)
     VALUES (1, 'Main Branch', 'الفرع الرئيسي', 'MAIN')`
  );
}

async function migrateStoreIdColumns(db) {
  const tables = [
    "cashier_shifts",
    "inventory_ledger",
    "receipt_sequences",
  ];
  for (const table of tables) {
    if (!(await tableHasColumn(db, table, "store_id"))) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1`);
    }
  }
}

async function seedUsers(db) {
  const rows = [
    { username: "admin", password: "admin123", role: "admin" },
    { username: "cashier1", password: "cashier123", role: "cashier" },
  ];
  for (const r of rows) {
    const exists = await db.get("SELECT id FROM users WHERE username = ?", [r.username]);
    if (exists) continue;
    const hash = await bcrypt.hash(r.password, 10);
    await db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 1)",
      [r.username, hash, r.role]
    );
  }
}

/**
 * Normalize messy barcodes (": 2100002", "حبة : 631") to a digit code the scanner sends.
 */
function bestDigitBarcodeValue(raw) {
  const s = String(raw ?? "");
  const runs = s.match(/\d{4,14}/g) || s.match(/\d{3,14}/g);
  if (!runs) return null;
  return runs.sort((a, b) => b.length - a.length)[0];
}

/** Strip junk from imported barcodes so scans match stored codes */
async function migrateProductBarcodesDigitsOnly(db) {
  const rows = await db.all("SELECT id, barcode FROM products");
  for (const { id, barcode } of rows) {
    const cleaned = bestDigitBarcodeValue(barcode);
    if (!cleaned || cleaned === String(barcode).trim()) continue;
    const clash = await db.get(
      "SELECT id FROM products WHERE barcode = ? AND id != ?",
      [cleaned, id]
    );
    if (clash) continue;
    await db.run("UPDATE products SET barcode = ? WHERE id = ?", [cleaned, id]);
  }
}

async function seedSampleProducts(db) {
  const count = await db.get("SELECT COUNT(*) as c FROM products");
  if (count.c > 0) return;
  const samples = [
    { b: "1234567890", n: "Coca Cola 500ml", p: 2.5, c: 1.2, cat: "Beverages", s: 100 },
    { b: "1234567891", n: "Water 1L", p: 1.5, c: 0.5, cat: "Beverages", s: 200 },
    { b: "1234567892", n: "Bread White", p: 3.5, c: 1.0, cat: "Bakery", s: 50 },
  ];
  for (const x of samples) {
    await db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [x.b, x.n, x.p, x.c, x.cat, x.s]
    );
  }
}

/**
 * @param {string} dbPath Absolute path to SQLite file
 * @returns {Promise<ReturnType<typeof wrapDb>>}
 */
export async function initDatabase(dbPath) {
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const raw = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, (err) => {
      if (err) reject(err);
      else resolve(d);
    });
  });

  const db = wrapDb(raw);

  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  await migrateLegacyIfNeeded(db);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      category TEXT,
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      tax REAL NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'visa')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- DEPRECATED / NON-AUTHORITATIVE. Kept only for backward compatibility.
    -- No code writes to or reads from this table anymore. All sales/profit
    -- reporting is computed on demand from the source tables (transactions,
    -- transaction_items, refunds) — see backend/routes/reports.js. Do not
    -- treat daily_reports as a source of truth.
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL UNIQUE,
      total_sales REAL NOT NULL DEFAULT 0,
      total_items INTEGER NOT NULL DEFAULT 0,
      cash_count INTEGER NOT NULL DEFAULT 0,
      card_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_phone TEXT,
      contact_email TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      amount REAL NOT NULL,
      paid_on TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'transfer'
        CHECK (payment_method IN ('cash', 'transfer', 'check', 'other')),
      reference_note TEXT,
      recorded_by_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier
      ON supplier_payments(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_payments_paid_on
      ON supplier_payments(paid_on);

    CREATE TABLE IF NOT EXISTS operating_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_on TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'transfer'
        CHECK (payment_method IN ('cash', 'transfer', 'check', 'other')),
      reference_note TEXT,
      recorded_by_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cash_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recon_date TEXT NOT NULL UNIQUE,
      expected_cash REAL NOT NULL,
      expected_card REAL NOT NULL,
      counted_cash REAL NOT NULL,
      over_short REAL NOT NULL,
      note TEXT,
      recorded_by_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      ref_text TEXT,
      amount_total REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      due_on TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      tax REAL NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'visa')),
      reason TEXT,
      cashier_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refunds_tx ON refunds(original_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_date ON refunds(created_at);
  `);

  await migrateUsersRoleConstraint(db);
  await migrateSupplierPaymentInvoiceId(db);
  await migrateCashierShiftsTables(db);
  await migrateTransactionsShiftId(db);
  await migrateRefundsShiftId(db);
  await migrateRefundsWorkflow(db);

  // Phase 1A: VAT + settings
  await migrateAppSettingsTable(db);
  await migrateProductsExtendedColumns(db);
  await migrateTransactionItemsTable(db);
  await migrateTransactionItemsPriceSnapshots(db);

  // Phase 2: inventory counts
  await migrateStockCountTables(db);

  // Phase 3: customers
  await migrateCustomersTable(db);

  // Phase 4: banks, checks, vouchers
  await migrateSuppliersBalance(db);
  await migrateBankAccountsTable(db);
  await migrateVouchersTable(db);

  // Phases 5-13: ERP extension
  await migrateTransactionsDiscount(db);
  await migrateInventoryMovementsTable(db);
  await migrateCustomersErpColumns(db);
  await migrateCustomerBalanceGroups(db);
  await migrateSuppliersErpColumns(db);
  await migratePurchasesTables(db);
  await migrateStockAdjustmentsTables(db);
  await migrateProductBatchesTable(db);
  await migrateExpenseCategoriesTables(db);
  await migrateDeliveriesTables(db);
  await migrateMarketingTables(db);
  await migrateWarehousesTables(db);

  // Production hardening migrations
  await migrateAuditLogsTable(db);
  await migrateProductPriceHistoryTable(db);
  await migrateInventoryLedgerTable(db);
  await migrateReceiptSequencesTable(db);
  await migrateEntityCodeSequencesTable(db);
  await migrateShiftReconciliationExtended(db);
  await migrateCashierShiftsPendingStatus(db);
  await migrateRefundRequestsTable(db);
  await migrateRefundRequestSyncColumns(db);
  await migrateLegacyPendingRefundsToRequests(db);
  await migrateMustChangePasswordColumn(db);
  await migrateStoresTable(db);
  await migrateStoreIdColumns(db);
  await migrateProductBarcodesTable(db);
  await migrateTransactionItemsScannedBarcode(db);
  await migrateAccountStatementIndexes(db);
  await migrateSupplierOpeningBalanceMeta(db);
  await migrateAccountStatementEntries(db);

  await seedUsers(db);
  await seedSampleProducts(db);
  await migrateProductBarcodesDigitsOnly(db);
  await migrateProductBarcodesFromProducts(db);
  await seedDefaultSettings(db);
  await backfillMissingEntityCodes(db);

  await recordSchemaVersion(db);

  return db;
}

/**
 * Applied-schema tracking. init.js is authoritative; the legacy .sql files in
 * database/migrations/archive are never executed. We record the current
 * baseline version so operators can confirm which schema the live DB is on.
 */
const SCHEMA_VERSION = "2026.06-customer-balance-groups";

async function migrateAccountStatementIndexes(db) {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_customer_id ON transactions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_refunds_customer_created ON refunds(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pinv_supplier_date ON purchase_invoices(supplier_id, invoice_date);
    CREATE INDEX IF NOT EXISTS idx_vlines_supplier ON voucher_lines(supplier_id);
  `);
}

async function recordSchemaVersion(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await db.run(
    "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)",
    [SCHEMA_VERSION]
  );
}
