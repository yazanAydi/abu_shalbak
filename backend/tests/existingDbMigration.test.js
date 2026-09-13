import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcrypt";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { createApp } from "../app.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import { login, authHeader } from "./helpers.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-abo-shalbak-tests-only";
process.env.DISABLE_AUTO_BACKUP = "1";

async function snapshotMoneyAndStock(db) {
  const users = await db.all("SELECT id, username, role FROM users ORDER BY id");
  const products = await db.all(
    "SELECT id, barcode, name, price, cost, stock FROM products ORDER BY id"
  );
  const txs = await db.all(
    `SELECT id, cashier_id, subtotal, tax, total, discount, payment_method, idempotency_key, status
     FROM transactions ORDER BY id`
  );
  const items = await db.all(
    `SELECT transaction_id, product_id, quantity, unit_price, unit_cost_at_sale, gross_profit
     FROM transaction_items ORDER BY id`
  );
  const pays = await db.all(
    "SELECT transaction_id, payment_method, amount FROM sale_payments ORDER BY id"
  );
  const oa = await db.all(
    `SELECT id, cashier_id, customer_id, total_amount, on_account_amount, status
     FROM on_account_requests ORDER BY id`
  );
  const ledger = await db.all(
    "SELECT product_id, movement_type, quantity_delta, qty_after FROM inventory_ledger ORDER BY id"
  );
  return { users, products, txs, items, pays, oa, ledger };
}

async function dropColumnIfPresent(db, table, column) {
  const row = await db.get("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ? LIMIT 1", [
    table,
    column,
  ]);
  if (!row) return;
  try {
    await db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    return;
  } catch {
    const cols = await db.all(`PRAGMA table_info("${table}")`);
    const keep = cols.filter((c) => c.name !== column).map((c) => `"${c.name}"`);
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.exec(`CREATE TABLE "${table}__pre" AS SELECT ${keep.join(", ")} FROM "${table}"`);
    await db.exec(`DROP TABLE "${table}"`);
    await db.exec(`ALTER TABLE "${table}__pre" RENAME TO "${table}"`);
    await db.exec("PRAGMA foreign_keys = ON");
  }
}

async function downgradeToPreReliabilitySchema(db) {
  await db.exec("DROP TABLE IF EXISTS telegram_poll_failures");
  await db.exec("DROP TABLE IF EXISTS telegram_poll_offsets");
  await db.exec("DROP INDEX IF EXISTS idx_on_account_requests_idempotency_key");
  await dropColumnIfPresent(db, "transactions", "payload_fingerprint");
  await dropColumnIfPresent(db, "on_account_requests", "payload_fingerprint");
  await dropColumnIfPresent(db, "on_account_requests", "idempotency_key");
}

async function assertReliabilitySchema(db) {
  const txFp = await db.get(
    "SELECT 1 AS x FROM pragma_table_info('transactions') WHERE name = 'payload_fingerprint' LIMIT 1"
  );
  const oaKey = await db.get(
    "SELECT 1 AS x FROM pragma_table_info('on_account_requests') WHERE name = 'idempotency_key' LIMIT 1"
  );
  const oaFp = await db.get(
    "SELECT 1 AS x FROM pragma_table_info('on_account_requests') WHERE name = 'payload_fingerprint' LIMIT 1"
  );
  const offsets = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='telegram_poll_offsets'"
  );
  const failures = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='telegram_poll_failures'"
  );
  const oaIdx = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_on_account_requests_idempotency_key'"
  );
  expect(txFp).toBeTruthy();
  expect(oaKey).toBeTruthy();
  expect(oaFp).toBeTruthy();
  expect(offsets).toBeTruthy();
  expect(failures).toBeTruthy();
  expect(oaIdx?.sql || "").toMatch(/UNIQUE/i);
}

describe("Existing-database migration (disposable pre-reliability schema)", () => {
  let tmpDir;
  let dbPath;
  let db;
  let app;
  let before;

  afterAll(async () => {
    try {
      if (db) await closeSqliteConnection(db);
    } catch {
      /* ignore */
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("migrates twice without changing money/stock; legacy key still checks ownership", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-mig-"));
    dbPath = path.join(tmpDir, "legacy.db");

    db = await initDatabase(dbPath);
    const cashHash = await bcrypt.hash("cashpass123", 4);
    await db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["migcashier", cashHash]
    );
    await db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["migcashier2", cashHash]
    );
    const cashier = await db.get("SELECT id FROM users WHERE username = 'migcashier'");
    const product = await db.get("SELECT id, stock FROM products ORDER BY id LIMIT 1");
    expect(product).toBeTruthy();
    await db.run("UPDATE products SET stock = 20, price = 10, cost = 4 WHERE id = ?", [product.id]);

    const shift = await db.run(
      "INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, 50, 'open')",
      [cashier.id]
    );
    const cust = await db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
       VALUES ('عميل ترحيل', 'MIG1', 0, 0, 5000)`
    );
    const tx = await db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id,
          status, idempotency_key, payload_fingerprint)
       VALUES (?, ?, 10, 0, 10, 0, 'cash', ?, 'completed', 'legacy-owner-key-aaaa', NULL)`,
      [cashier.id, JSON.stringify([{ product_id: product.id, quantity: 1, price: 10 }]), shift.lastID]
    );
    await db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross,
          unit_cost_at_sale, gross_profit)
       VALUES (?, ?, 'صنف ترحيل', 1, 10, 10, 0, 10, 4, 6)`,
      [tx.lastID, product.id]
    );
    await db.run(
      "INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'cash', 10)",
      [tx.lastID]
    );
    await db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, reference_type, reference_id)
       VALUES (?, 'sale', -1, 20, 19, 'transaction', ?)`,
      [product.id, tx.lastID]
    );
    await db.run("UPDATE products SET stock = 19 WHERE id = ?", [product.id]);
    await db.run(
      `INSERT INTO on_account_requests
         (cashier_id, customer_id, sale_snapshot_json, subtotal, tax, total_amount, on_account_amount,
          payment_method, status)
       VALUES (?, ?, ?, 8, 0, 8, 8, 'on_account', 'pending')`,
      [cashier.id, cust.lastID, JSON.stringify({ items: [] })]
    );

    before = await snapshotMoneyAndStock(db);
    expect(before.txs).toHaveLength(1);
    expect(before.oa).toHaveLength(1);
    expect(Number(before.products[0].stock)).toBe(19);

    await downgradeToPreReliabilitySchema(db);
    expect(
      await db.get(
        "SELECT 1 AS x FROM pragma_table_info('transactions') WHERE name = 'payload_fingerprint'"
      )
    ).toBeFalsy();
    expect(
      await db.get(
        "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='telegram_poll_failures'"
      )
    ).toBeFalsy();
    await closeSqliteConnection(db);
    db = null;

    db = await initDatabase(dbPath);
    await assertReliabilitySchema(db);
    expect(await snapshotMoneyAndStock(db)).toEqual(before);
    const fps = await db.all("SELECT payload_fingerprint FROM transactions");
    expect(fps.every((r) => r.payload_fingerprint == null)).toBe(true);

    await closeSqliteConnection(db);
    db = await initDatabase(dbPath);
    await assertReliabilitySchema(db);
    expect(await snapshotMoneyAndStock(db)).toEqual(before);

    app = createApp(db, dbPath);
    const owner = await login(app, "migcashier", "cashpass123", "pos");
    const other = await login(app, "migcashier2", "cashpass123", "pos");
    expect(owner.status).toBe(200);
    expect(other.status).toBe(200);

    await request(app).post("/api/v1/shifts/start").set(authHeader(owner.body.token)).send({});
    await request(app).post("/api/v1/shifts/start").set(authHeader(other.body.token)).send({});

    const stolen = await request(app)
      .post("/api/v1/checkout")
      .set(authHeader(other.body.token))
      .send({
        items: [{ product_id: product.id, quantity: 1, price: 10 }],
        payment_method: "cash",
        idempotency_key: "legacy-owner-key-aaaa",
      });
    expect(stolen.status).toBe(403);
    expect(stolen.body.code).toBe("IDEMPOTENCY_OWNER_MISMATCH");

    const replay = await request(app)
      .post("/api/v1/checkout")
      .set(authHeader(owner.body.token))
      .send({
        items: [{ product_id: product.id, quantity: 1, price: 10 }],
        payment_method: "cash",
        idempotency_key: "legacy-owner-key-aaaa",
      });
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotent_replay).toBe(true);
    expect(replay.body.data.transaction_id).toBe(tx.lastID);

    expect(await snapshotMoneyAndStock(db)).toEqual(before);
  });
});
