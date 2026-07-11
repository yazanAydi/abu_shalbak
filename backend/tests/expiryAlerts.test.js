import { buildExpiryAlertMessages, isExpiryTelegramConfigured, isRefundTelegramConfigured } from "../utils/telegram.js";
import {
  fetchNearExpiryItems,
  resolveDairyCategories,
  sendExpiryAlert,
} from "../services/expiryAlertService.js";
import { initDatabase } from "../database/init.js";
import { updateAppSettings } from "../utils/settings.js";
import fs from "fs";
import path from "path";
import os from "os";

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

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

  test("buildExpiryAlertMessages uses custom title for dairy alerts", () => {
    const messages = buildExpiryAlertMessages(
      {
        products: [
          {
            name: "لبن",
            barcode: "111",
            days_until_expiry: 2,
            expiry_date: "2026-06-07",
            stock: 5,
          },
        ],
        batches: [],
      },
      3,
      { title: "🥛 تنبيه صلاحية — منتجات الألبان — تنتهي خلال 3 يوم" }
    );
    expect(messages[0]).toContain("منتجات الألبان");
    expect(messages[0]).toContain("لبن");
  });

  test("fetchNearExpiryItems filters dairy vs other categories", async () => {
    const soon = daysFromNow(2);
    const medium = daysFromNow(5);

    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["d1", "لبن", 5, 10, soon, "ألبان"]
    );
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["o1", "عصير", 8, 5, medium, "مشروبات"]
    );
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["d2", "زبادي", 3, 5, medium, "ألبان"]
    );

    const dairyCats = ["ألبان"];
    const dairy = await fetchNearExpiryItems(db, 3, { categories: dairyCats, mode: "include" });
    const other = await fetchNearExpiryItems(db, 7, { categories: dairyCats, mode: "exclude" });

    expect(dairy.products.some((p) => p.name === "لبن")).toBe(true);
    expect(dairy.products.some((p) => p.name === "زبادي")).toBe(false);
    expect(dairy.products.some((p) => p.name === "عصير")).toBe(false);

    expect(other.products.some((p) => p.name === "عصير")).toBe(true);
    expect(other.products.some((p) => p.name === "لبن")).toBe(false);
    expect(other.products.some((p) => p.name === "زبادي")).toBe(false);
  });

  test("fetchNearExpiryItems applies category filter to batches", async () => {
    const soon = daysFromNow(1);
    const ins = await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["d1", "لبن", 5, 10, "2099-01-01", "ألبان"]
    );
    await db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)`,
      [ins.lastID, "B1", soon, 5]
    );

    const dairy = await fetchNearExpiryItems(db, 3, { categories: ["ألبان"], mode: "include" });
    const other = await fetchNearExpiryItems(db, 7, { categories: ["ألبان"], mode: "exclude" });

    expect(dairy.batches.length).toBe(1);
    expect(other.batches.length).toBe(0);
  });

  test("empty dairy categories disables split mode", async () => {
    await updateAppSettings(db, { expiry_dairy_categories: [] });
    const cats = await resolveDairyCategories(db);
    expect(cats).toEqual([]);

    const soon = daysFromNow(2);
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["d1", "لبن", 5, 10, soon, "ألبان"]
    );
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["o1", "عصير", 8, 5, soon, "مشروبات"]
    );

    const all = await fetchNearExpiryItems(db, 7);
    expect(all.products.length).toBe(2);
  });

  test("split alert messages include dairy and other groups", async () => {
    const soon = daysFromNow(2);
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["d1", "لبن", 5, 10, soon, "ألبان"]
    );
    await db.run(
      `INSERT INTO products (barcode, name, price, stock, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`,
      ["o1", "عصير", 8, 5, soon, "مشروبات"]
    );

    const dairyItems = await fetchNearExpiryItems(db, 3, {
      categories: ["ألبان"],
      mode: "include",
    });
    const otherItems = await fetchNearExpiryItems(db, 7, {
      categories: ["ألبان"],
      mode: "exclude",
    });

    const messages = [
      ...buildExpiryAlertMessages(dairyItems, 3, {
        title: "🥛 تنبيه صلاحية — منتجات الألبان — تنتهي خلال 3 يوم",
      }),
      ...buildExpiryAlertMessages(otherItems, 7, {
        title: "⚠️ تنبيه صلاحية — أصناف أخرى — تنتهي خلال 7 يوم",
      }),
    ];

    expect(messages.length).toBe(2);
    expect(messages[0]).toContain("منتجات الألبان");
    expect(messages[0]).toContain("لبن");
    expect(messages[1]).toContain("أصناف أخرى");
    expect(messages[1]).toContain("عصير");
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
