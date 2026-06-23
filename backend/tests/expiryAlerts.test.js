import { buildExpiryAlertMessages, isExpiryTelegramConfigured, isRefundTelegramConfigured } from "../utils/telegram.js";
import { fetchNearExpiryItems, sendExpiryAlert } from "../services/expiryAlertService.js";
import { initDatabase } from "../database/init.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("expiry alerts", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `expiry-alert-${Date.now()}.db`);
    db = await initDatabase(dbPath);
  });

  afterEach(async () => {
    if (db?.close) await db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  test("fetchNearExpiryItems returns products and batches within window", async () => {
    const ins = await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date) VALUES (?, ?, ?, ?, ?)`,
      ["111", "لبن", 5, 10, "2099-01-01"]
    );
    const farId = ins.lastID;
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date) VALUES (?, ?, ?, ?, ?)`,
      ["222", "زبادي", 3, 5, "2000-01-01"]
    );
    await db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)`,
      [farId, "B1", "2099-06-01", 20]
    );

    const { products, batches } = await fetchNearExpiryItems(db, 30);
    expect(products.some((p) => p.name === "زبادي")).toBe(true);
    expect(products.some((p) => p.name === "لبن")).toBe(false);
    expect(batches.length).toBe(0);
  });

  test("buildExpiryAlertMessages formats Arabic summary", () => {
    const messages = buildExpiryAlertMessages(
      {
        products: [
          {
            name: "حليب",
            barcode: "123",
            days_until_expiry: 3,
            expiry_date: "2026-06-07",
            stock: 12,
          },
        ],
        batches: [],
      },
      7
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("تنبيه صلاحية");
    expect(messages[0]).toContain("حليب");
    expect(messages[0]).toContain("3 يوم");
  });

  test("sendExpiryAlert skips when expiry bot not configured", async () => {
    const prevExpiryToken = process.env.TELEGRAM_EXPIRY_BOT_TOKEN;
    const prevRefundToken = process.env.TELEGRAM_REFUND_BOT_TOKEN;
    const prevLegacyToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_MANAGER_CHAT_ID;
    delete process.env.TELEGRAM_EXPIRY_BOT_TOKEN;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_MANAGER_CHAT_ID;

    expect(isExpiryTelegramConfigured()).toBe(false);
    expect(isRefundTelegramConfigured()).toBe(false);

    const result = await sendExpiryAlert(db);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("telegram_not_configured");

    if (prevExpiryToken) process.env.TELEGRAM_EXPIRY_BOT_TOKEN = prevExpiryToken;
    if (prevRefundToken) process.env.TELEGRAM_REFUND_BOT_TOKEN = prevRefundToken;
    if (prevLegacyToken) process.env.TELEGRAM_BOT_TOKEN = prevLegacyToken;
    if (prevChat) process.env.TELEGRAM_MANAGER_CHAT_ID = prevChat;
  });

  test("refund bot uses legacy TELEGRAM_BOT_TOKEN fallback", () => {
    const prevRefund = process.env.TELEGRAM_REFUND_BOT_TOKEN;
    const prevLegacy = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_MANAGER_CHAT_ID;
    delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "legacy-refund-token";
    process.env.TELEGRAM_MANAGER_CHAT_ID = "12345";

    expect(isRefundTelegramConfigured()).toBe(true);
    expect(isExpiryTelegramConfigured()).toBe(false);

    if (prevRefund) process.env.TELEGRAM_REFUND_BOT_TOKEN = prevRefund;
    else delete process.env.TELEGRAM_REFUND_BOT_TOKEN;
    if (prevLegacy) process.env.TELEGRAM_BOT_TOKEN = prevLegacy;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (prevChat) process.env.TELEGRAM_MANAGER_CHAT_ID = prevChat;
    else delete process.env.TELEGRAM_MANAGER_CHAT_ID;
  });
});
