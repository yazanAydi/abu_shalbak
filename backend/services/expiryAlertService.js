import { getAppSettings } from "../utils/settings.js";
import {
  isExpiryTelegramConfigured,
  buildExpiryAlertMessages,
  sendExpiryAlertMessages,
} from "../utils/telegram.js";

export async function fetchNearExpiryItems(db, days) {
  const d = Math.max(1, Math.min(365, Number(days) || 7));

  const products = await db.all(
    `SELECT id, barcode, name, unit, stock, expiry_date,
       CAST(julianday(expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM products
     WHERE expiry_date IS NOT NULL AND expiry_date != ''
       AND stock > 0
       AND julianday(expiry_date) <= julianday('now', '+' || ? || ' days')
     ORDER BY expiry_date ASC`,
    [d]
  );

  const batches = await db.all(
    `SELECT b.id, b.batch_no, b.expiry_date, b.quantity,
       p.name AS product_name, p.barcode,
       CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.expiry_date IS NOT NULL AND b.expiry_date != ''
       AND b.quantity > 0
       AND julianday(b.expiry_date) <= julianday('now', '+' || ? || ' days')
     ORDER BY b.expiry_date ASC`,
    [d]
  );

  return { products, batches, daysThreshold: d };
}

export async function sendExpiryAlert(db) {
  if (!isExpiryTelegramConfigured()) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  const settings = await getAppSettings(db);
  const envDays = Number(process.env.TELEGRAM_EXPIRY_DAYS);
  const days =
    settings.expiry_alert_days ??
    (Number.isFinite(envDays) && envDays > 0 ? envDays : 7);

  const items = await fetchNearExpiryItems(db, days);
  const count = items.products.length + items.batches.length;
  if (count === 0) {
    return { sent: false, reason: "no_items", daysThreshold: items.daysThreshold };
  }

  const messages = buildExpiryAlertMessages(items, items.daysThreshold);
  if (!messages.length) {
    return { sent: false, reason: "no_items", daysThreshold: items.daysThreshold };
  }

  await sendExpiryAlertMessages(messages);
  return {
    sent: true,
    count,
    products: items.products.length,
    batches: items.batches.length,
    daysThreshold: items.daysThreshold,
    messageParts: messages.length,
  };
}
