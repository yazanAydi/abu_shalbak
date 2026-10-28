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
  await db.exec("DROP TABLE IF EXISTS telegram_outbound");
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
  const outbound = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='telegram_outbound'"
  );
  const oaIdx = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_on_account_requests_idempotency_key'"
  );
  expect(txFp).toBeTruthy();
  expect(oaKey).toBeTruthy();
  expect(oaFp).toBeTruthy();
  expect(offsets).toBeTruthy();
  expect(failures).toBeTruthy();
  expect(outbound).toBeTruthy();
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

  test("upgrades telegram_outbound twice and startup recovery keeps cooldown and failure state", async () => {
    const { resendPendingTelegramApprovals } = await import("../services/telegramPendingResend.js");
    const { sendPendingTelegram, stopTelegramDeliveryScheduler } = await import("../services/telegramDelivery.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-outbound-mig-"));
    dbPath = path.join(tmpDir, "legacy.db");
    db = await initDatabase(dbPath);
    const cashHash = await bcrypt.hash("cashpass123", 4);
    await db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["outboundcashier", cashHash]
    );
    const cashier = await db.get("SELECT id FROM users WHERE username = 'outboundcashier'");
    const product = await db.get("SELECT id FROM products ORDER BY id LIMIT 1");
    await db.run("UPDATE products SET stock = 12, price = 10, cost = 4 WHERE id = ?", [product.id]);
    const shift = await db.run(
      "INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, 40, 'open')",
      [cashier.id]
    );
    const tx = await db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, discount, payment_method, shift_id, status)
       VALUES (?, '[]', 10, 0, 10, 0, 'cash', ?, 'completed')`,
      [cashier.id, shift.lastID]
    );
    await db.run(
      `INSERT INTO transaction_items
         (transaction_id, product_id, name, quantity, unit_price, line_net, line_tax, line_gross, unit_cost_at_sale, gross_profit)
       VALUES (?, ?, 'صنف', 1, 10, 10, 0, 10, 4, 6)`,
      [tx.lastID, product.id]
    );
    await db.run(
      "INSERT INTO sale_payments (transaction_id, payment_method, amount) VALUES (?, 'cash', 10)",
      [tx.lastID]
    );
    await db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, reference_type, reference_id)
       VALUES (?, 'sale', -1, 12, 11, 'transaction', ?)`,
      [product.id, tx.lastID]
    );
    await db.run("UPDATE products SET stock = 11 WHERE id = ?", [product.id]);
    const approved = await db.run(
      `INSERT INTO advance_requests
         (cashier_id, shift_id, employee_name, amount, status, telegram_message_id, decision_source, manager_id)
       VALUES (?, ?, 'موظف معتمد', 5, 'approved', '55', 'admin', ?)`,
      [cashier.id, shift.lastID, cashier.id]
    );
    const pending = await db.run(
      `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, status)
       VALUES (?, ?, 'موظف معلّق', 3, 'pending')`,
      [cashier.id, shift.lastID]
    );
    const moneyBefore = await snapshotMoneyAndStock(db);
    const decisionsBefore = await db.all(
      "SELECT id, status, amount, telegram_message_id, decision_source FROM advance_requests ORDER BY id"
    );

    await db.exec("DROP TABLE telegram_outbound");
    await closeSqliteConnection(db);
    db = await initDatabase(dbPath);
    await assertReliabilitySchema(db);
    await closeSqliteConnection(db);
    db = await initDatabase(dbPath);
    await assertReliabilitySchema(db);
    expect(await snapshotMoneyAndStock(db)).toEqual(moneyBefore);
    expect(
      await db.all(
        "SELECT id, status, amount, telegram_message_id, decision_source FROM advance_requests ORDER BY id"
      )
    ).toEqual(decisionsBefore);

    const previousFetch = global.fetch;
    let releaseHold = () => {};
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "upgrade-sulaf-token";
    process.env.TELEGRAM_SULAF_CHAT_ID = "6096292831";
    process.env.TELEGRAM_SULAF_WEBHOOK_SECRET = "upgrade-secret";
    let sends = 0;
    global.fetch = async (url) => {
      if (!String(url).includes("/sendMessage")) throw new Error(`unexpected ${url}`);
      sends += 1;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 880 } }) };
    };
    try {
      const recovered = await resendPendingTelegramApprovals(db);
      expect(recovered.sulaf).toBe(1);
      expect(sends).toBe(1);
      const plain = await db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [pending.lastID]);
      expect(plain.status).toBe("pending");
      expect(plain.telegram_message_id).toBe("880");
      const kept = await db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [approved.lastID]);
      expect(kept).toEqual({ status: "approved", telegram_message_id: "55" });

      const cooling = await db.run(
        `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, status)
         VALUES (?, ?, 'موظف انتظار', 2, 'pending')`,
        [cashier.id, shift.lastID]
      );
      const failed = await db.run(
        `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, status)
         VALUES (?, ?, 'موظف فشل', 2, 'pending')`,
        [cashier.id, shift.lastID]
      );
      const deadline = new Date(Date.now() + 300000).toISOString();
      await db.run(
        `INSERT INTO telegram_outbound
           (request_table, request_id, state, attempts, last_error, next_attempt_at)
         VALUES ('advance_requests', ?, 'queued', 2, 'rate limit', ?)`,
        [cooling.lastID, deadline]
      );
      await db.run(
        `INSERT INTO telegram_outbound
           (request_table, request_id, state, attempts, last_error, next_attempt_at)
         VALUES ('advance_requests', ?, 'failed', 5, 'Forbidden', NULL)`,
        [failed.lastID]
      );
      const beforeRestart = await db.all(
        "SELECT request_id, state, attempts, last_error, next_attempt_at FROM telegram_outbound ORDER BY request_id"
      );
      sends = 0;
      await resendPendingTelegramApprovals(db);
      expect(sends).toBe(0);
      expect(
        await db.all(
          "SELECT request_id, state, attempts, last_error, next_attempt_at FROM telegram_outbound ORDER BY request_id"
        )
      ).toEqual(beforeRestart);
      expect((await db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [cooling.lastID])).telegram_message_id).toBeFalsy();
      expect((await db.get("SELECT telegram_message_id FROM advance_requests WHERE id = ?", [failed.lastID])).telegram_message_id).toBeFalsy();

      const interrupted = await db.run(
        `INSERT INTO advance_requests (cashier_id, shift_id, employee_name, amount, status)
         VALUES (?, ?, 'موظف منقطع', 1, 'pending')`,
        [cashier.id, shift.lastID]
      );
      const gate = new Promise((resolve) => {
        releaseHold = resolve;
      });
      let held = 0;
      global.fetch = async () => {
        held += 1;
        if (held === 1) await gate;
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 881 } }) };
      };
      const inflight = sendPendingTelegram(db, "advance_requests", interrupted.lastID, async () => {
        const res = await global.fetch("https://api.telegram.org/botupgrade-sulaf-token/sendMessage");
        const body = await res.json();
        return String(body.result.message_id);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(held).toBe(1);
      stopTelegramDeliveryScheduler();
      global.fetch = async () => {
        held += 1;
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 882 } }) };
      };
      expect((await resendPendingTelegramApprovals(db)).sulaf).toBe(1);
      const stored = await db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [
        interrupted.lastID,
      ]);
      expect(stored.status).toBe("pending");
      expect(stored.telegram_message_id).toBe("882");
      releaseHold();
      await inflight;
      const afterLate = await db.get("SELECT status, telegram_message_id FROM advance_requests WHERE id = ?", [
        interrupted.lastID,
      ]);
      expect(afterLate).toEqual(stored);
      expect(await snapshotMoneyAndStock(db)).toEqual(moneyBefore);
    } finally {
      releaseHold();
      stopTelegramDeliveryScheduler();
      global.fetch = previousFetch;
      delete process.env.TELEGRAM_SULAF_BOT_TOKEN;
      delete process.env.TELEGRAM_SULAF_CHAT_ID;
      delete process.env.TELEGRAM_SULAF_WEBHOOK_SECRET;
    }
  });
});
