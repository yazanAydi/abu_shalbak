import { getAppSettings } from "../utils/settings.js";
import { attachSupplierBreakdown } from "./stockSourceService.js";
import {
  isExpiryTelegramConfigured,
  buildExpiryAlertMessages,
  sendExpiryAlertMessages,
} from "../utils/telegram.js";

export async function resolveExpiryAlertDays(db) {
  const settings = await getAppSettings(db);
  const envDays = Number(process.env.TELEGRAM_EXPIRY_DAYS);
  return (
    settings.expiry_alert_days ??
    (Number.isFinite(envDays) && envDays > 0 ? envDays : 7)
  );
}

export async function resolveExpiryAlertDaysDairy(db) {
  const settings = await getAppSettings(db);
  const envDays = Number(process.env.TELEGRAM_EXPIRY_DAYS_DAIRY);
  const n =
    settings.expiry_alert_days_dairy ??
    (Number.isFinite(envDays) && envDays > 0 ? envDays : 3);
  return Math.max(1, Math.min(365, Math.floor(Number(n) || 3)));
}

export async function resolveDairyCategories(db) {
  const settings = await getAppSettings(db);
  return Array.isArray(settings.expiry_dairy_categories) ? settings.expiry_dairy_categories : [];
}

function buildCategoryClause(categories, mode, column = "category") {
  if (!categories?.length) return { sql: "", params: [] };
  const placeholders = categories.map(() => "?").join(", ");
  if (mode === "include") {
    return {
      sql: ` AND TRIM(${column}) IN (${placeholders})`,
      params: categories,
    };
  }
  return {
    sql: ` AND (${column} IS NULL OR TRIM(${column}) = '' OR TRIM(${column}) NOT IN (${placeholders}))`,
    params: categories,
  };
}

export async function fetchNearExpiryItems(db, days, options = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 7));
  const { categories, mode } = options;
  const categoryClause =
    categories?.length && (mode === "include" || mode === "exclude")
      ? buildCategoryClause(categories, mode, "category")
      : { sql: "", params: [] };

  const products = await db.all(
    `SELECT id, barcode, name, unit,
       (stock - COALESCE((
          SELECT SUM(b.quantity) FROM product_batches b
          WHERE b.product_id = products.id
            AND b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
       ), 0)) AS stock,
       expiry_date, category,
       CAST(julianday(expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM products
     WHERE expiry_date IS NOT NULL AND expiry_date != ''
       AND (stock - COALESCE((
          SELECT SUM(b.quantity) FROM product_batches b
          WHERE b.product_id = products.id
            AND b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
       ), 0)) > 0
       AND julianday(expiry_date) <= julianday('now', '+' || ? || ' days')
       ${categoryClause.sql}
     ORDER BY expiry_date ASC`,
    [d, ...categoryClause.params]
  );

  const batchCategoryClause =
    categories?.length && (mode === "include" || mode === "exclude")
      ? buildCategoryClause(categories, mode, "p.category")
      : { sql: "", params: [] };

  const batches = await db.all(
    `SELECT b.id, b.batch_no, b.expiry_date, b.quantity,
       p.name AS product_name, p.barcode, p.category,
       CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.expiry_date IS NOT NULL AND b.expiry_date != ''
       AND b.quantity > 0
       AND julianday(b.expiry_date) <= julianday('now', '+' || ? || ' days')
       ${batchCategoryClause.sql}
     ORDER BY b.expiry_date ASC`,
    [d, ...batchCategoryClause.params]
  );

  return { products, batches, daysThreshold: d };
}

/**
 * Office expiry report.
 * Same inclusion window as alerts: a real expiry on or before today+N,
 * remaining quantity above zero, including dates already past.
 * Dated lots are listed by their own remaining quantity. A product-level
 * expiry covers only the undated remainder (on-hand minus every dated lot),
 * so units already on a lot are not listed again. A remainder at or below
 * zero is omitted; dated quantities are not rewritten to hide it.
 */
export async function listOfficeExpiryReport(db, {
  days = 30,
  membershipSql = "",
  membershipParams = [],
  limit = 500,
  offset = 0,
} = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const cap = Math.max(1, Number(limit) || 500);
  const skip = Math.max(0, Number(offset) || 0);

  const batches = await db.all(
    `SELECT b.id AS batch_id, b.batch_no, b.expiry_date, b.quantity,
            p.id AS product_id, p.barcode, p.name, p.unit, p.stock AS product_stock,
            CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     WHERE b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
       AND b.quantity > 0
       AND julianday(b.expiry_date) <= julianday('now', '+' || ? || ' days')
       ${membershipSql}
     ORDER BY b.expiry_date ASC, b.id ASC`,
    [d, ...membershipParams]
  );

  const products = await db.all(
    `SELECT p.id, p.barcode, p.name, p.unit, p.stock, p.expiry_date,
            CAST(julianday(p.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry,
            COALESCE((
              SELECT SUM(b.quantity) FROM product_batches b
              WHERE b.product_id = p.id
                AND b.expiry_date IS NOT NULL AND TRIM(b.expiry_date) != ''
            ), 0) AS dated_qty
     FROM products p
     WHERE p.expiry_date IS NOT NULL AND TRIM(p.expiry_date) != ''
       AND p.stock > 0
       AND julianday(p.expiry_date) <= julianday('now', '+' || ? || ' days')
       ${membershipSql}
     ORDER BY p.expiry_date ASC, p.id ASC`,
    [d, ...membershipParams]
  );

  const rows = [];
  for (const row of products) {
    const onHand = Number(row.stock) || 0;
    const dated = Number(row.dated_qty) || 0;
    const undated = onHand - dated;
    if (!(undated > 1e-9)) continue;
    rows.push({
      id: row.id,
      row_key: `product:${row.id}`,
      source: "product",
      product_id: row.id,
      barcode: row.barcode,
      name: row.name,
      unit: row.unit,
      stock: undated,
      product_stock: onHand,
      expiry_date: row.expiry_date,
      days_until_expiry: row.days_until_expiry,
      batch_id: null,
      batch_no: null,
    });
  }
  for (const row of batches) {
    rows.push({
      id: `batch:${row.batch_id}`,
      row_key: `batch:${row.batch_id}`,
      source: "batch",
      product_id: row.product_id,
      barcode: row.barcode,
      name: row.name,
      unit: row.unit,
      stock: Number(row.quantity),
      product_stock: Number(row.product_stock) || 0,
      expiry_date: row.expiry_date,
      days_until_expiry: row.days_until_expiry,
      batch_id: row.batch_id,
      batch_no: row.batch_no,
    });
  }

  rows.sort((a, b) => {
    const dayDiff = Number(a.days_until_expiry) - Number(b.days_until_expiry);
    if (dayDiff !== 0) return dayDiff;
    const dateDiff = String(a.expiry_date).localeCompare(String(b.expiry_date));
    if (dateDiff !== 0) return dateDiff;
    return String(a.name).localeCompare(String(b.name));
  });
  return attachSupplierBreakdown(db, rows.slice(skip, skip + cap));
}

function summarizeItems(items) {
  const count = items.products.length + items.batches.length;
  return {
    count,
    products: items.products.length,
    batches: items.batches.length,
    daysThreshold: items.daysThreshold,
  };
}

async function sendExpiryGroup(items, daysThreshold, title) {
  const messages = buildExpiryAlertMessages(items, daysThreshold, { title });
  if (!messages.length) {
    return { sent: false, reason: "no_items", ...summarizeItems(items), messageParts: 0 };
  }
  await sendExpiryAlertMessages(messages);
  return {
    sent: true,
    ...summarizeItems(items),
    messageParts: messages.length,
  };
}

export async function sendExpiryAlert(db) {
  if (!isExpiryTelegramConfigured()) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  const dairyCategories = await resolveDairyCategories(db);

  if (!dairyCategories.length) {
    const days = await resolveExpiryAlertDays(db);
    const items = await fetchNearExpiryItems(db, days);
    const result = await sendExpiryGroup(
      items,
      days,
      `⚠️ تنبيه صلاحية — أصناف تنتهي خلال ${days} يوم`
    );
    if (!result.sent) {
      return { ...result, count: result.count ?? 0 };
    }
    return {
      sent: true,
      count: result.count,
      products: result.products,
      batches: result.batches,
      daysThreshold: result.daysThreshold,
      messageParts: result.messageParts,
    };
  }

  const daysDairy = await resolveExpiryAlertDaysDairy(db);
  const daysOther = await resolveExpiryAlertDays(db);

  const dairyItems = await fetchNearExpiryItems(db, daysDairy, {
    categories: dairyCategories,
    mode: "include",
  });
  const otherItems = await fetchNearExpiryItems(db, daysOther, {
    categories: dairyCategories,
    mode: "exclude",
  });

  const dairySummary = summarizeItems(dairyItems);
  const otherSummary = summarizeItems(otherItems);
  const totalCount = dairySummary.count + otherSummary.count;

  if (totalCount === 0) {
    return {
      sent: false,
      reason: "no_items",
      count: 0,
      dairy: { ...dairySummary, sent: false, reason: "no_items", messageParts: 0 },
      other: { ...otherSummary, sent: false, reason: "no_items", messageParts: 0 },
    };
  }

  const dairyMessages = buildExpiryAlertMessages(dairyItems, daysDairy, {
    title: `🥛 تنبيه صلاحية — منتجات الألبان — تنتهي خلال ${daysDairy} يوم`,
  });
  const otherMessages = buildExpiryAlertMessages(otherItems, daysOther, {
    title: `⚠️ تنبيه صلاحية — أصناف أخرى — تنتهي خلال ${daysOther} يوم`,
  });
  const messages = [...dairyMessages, ...otherMessages];

  if (!messages.length) {
    return {
      sent: false,
      reason: "no_items",
      count: 0,
      dairy: { ...dairySummary, sent: false, reason: "no_items", messageParts: 0 },
      other: { ...otherSummary, sent: false, reason: "no_items", messageParts: 0 },
    };
  }

  await sendExpiryAlertMessages(messages);

  return {
    sent: true,
    count: totalCount,
    messageParts: messages.length,
    dairy: {
      ...dairySummary,
      sent: dairySummary.count > 0,
      messageParts: dairyMessages.length,
    },
    other: {
      ...otherSummary,
      sent: otherSummary.count > 0,
      messageParts: otherMessages.length,
    },
  };
}
