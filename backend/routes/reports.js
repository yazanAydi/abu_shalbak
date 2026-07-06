import { Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import {
  snapshotSalesCogsForRange,
  snapshotRefundCogsForRange,
} from "../utils/cogs.js";
import {
  aggregateSalesByPrice,
  aggregateRefundsByPrice,
  mergeSalesAndRefunds,
} from "../utils/salesByPrice.js";
import { round2 } from "../utils/money.js";
import {
  fetchNearExpiryItems,
  resolveExpiryAlertDays,
} from "../services/expiryAlertService.js";
import {
  getAccountStatement,
  getAccountStatementExport,
  parseStatementDate,
} from "../utils/accountStatementService.js";
import XLSX from "xlsx";
import { aggregatePaymentLinesForDate } from "../utils/salePayments.js";
import {
  TX_BUSINESS_DAY_JOIN,
  txBusinessDayEquals,
  REFUND_BUSINESS_DAY_JOIN,
  refundBusinessDayEquals,
} from "../utils/businessDay.js";

function parseDateParam(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

function parseBoolParam(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const s = String(value).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return defaultValue;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function aggregateDay(db, dateStr) {
  const rows = await db.all(
    `SELECT t.id, t.items_json, t.subtotal, t.tax, t.total, t.change_amount, t.payment_method, t.created_at
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE ${txBusinessDayEquals("?")}`,
    [dateStr]
  );

  const paymentAgg = await aggregatePaymentLinesForDate(db, dateStr);

  let total_sales = 0;
  let total_tax = 0;
  let total_net = 0;
  let change_total = 0;
  let total_transactions = rows.length;
  const productMap = new Map();

  for (const r of rows) {
    total_sales = round2(total_sales + Number(r.total));
    change_total = round2(change_total + Number(r.change_amount || 0));
    total_tax = round2(total_tax + Number(r.tax || 0));
    total_net = round2(total_net + Number(r.subtotal || r.total));

    const txItems = await db.all(
      "SELECT * FROM transaction_items WHERE transaction_id = ?",
      [r.id]
    );
    if (txItems.length > 0) {
      for (const it of txItems) {
        const name = it.name || `Product ${it.product_id}`;
        const qty = Number(it.quantity) || 0;
        const prev = productMap.get(name) || { name, quantity: 0, revenue: 0 };
        prev.quantity += qty;
        prev.revenue = round2(prev.revenue + Number(it.line_gross));
        productMap.set(name, prev);
      }
    } else {
      // Fallback to items_json blob for old transactions
      let items;
      try { items = JSON.parse(r.items_json); } catch { continue; }
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const name = it.name || `Product ${it.product_id}`;
        const qty = Number(it.quantity) || 0;
        const price = Number(it.price) || 0;
        const prev = productMap.get(name) || { name, quantity: 0, revenue: 0 };
        prev.quantity += qty;
        prev.revenue = round2(prev.revenue + qty * price);
        productMap.set(name, prev);
      }
    }
  }

  const items_sold = [...productMap.values()].reduce((s, p) => s + p.quantity, 0);
  const top_products = [...productMap.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)
    .map((p) => ({
      name: p.name,
      quantity: p.quantity,
      revenue: p.revenue,
    }));

  const refundRows = await db.all(
    `SELECT r.total, r.payment_method FROM refunds r
     ${REFUND_BUSINESS_DAY_JOIN}
     WHERE ${refundBusinessDayEquals("?")}`,
    [dateStr]
  );
  let refunds_total = 0;
  let refund_count = refundRows.length;
  let refund_cash = 0;
  let refund_card = 0;
  for (const r of refundRows) {
    refunds_total = round2(refunds_total + Number(r.total));
    if (r.payment_method === "cash") refund_cash = round2(refund_cash + Number(r.total));
    else refund_card = round2(refund_card + Number(r.total));
  }
  const net_sales = round2(total_sales - refunds_total);
  const cash_total = paymentAgg.cash_total;
  const card_total = paymentAgg.card_total;
  const on_account_total = paymentAgg.on_account_total;
  // Change is handed back from the cash drawer, so it reduces net cash on hand.
  const net_cash_total = round2(cash_total - refund_cash - change_total);
  const net_card_total = round2(card_total - refund_card);

  return {
    success: true,
    date: dateStr,
    total_sales: round2(total_sales),
    total_tax: round2(total_tax),
    total_net: round2(total_net),
    total_transactions,
    cash_transactions: paymentAgg.cash_transactions,
    card_transactions: paymentAgg.card_transactions,
    on_account_transactions: paymentAgg.on_account_transactions,
    mixed_sales_count: paymentAgg.mixed_sales_count,
    cash_total: round2(cash_total),
    card_total: round2(card_total),
    on_account_total: round2(on_account_total),
    change_total: round2(change_total),
    collections_by_currency: paymentAgg.collections_by_currency,
    collections_grand_total_nis: paymentAgg.collections_grand_total_nis,
    items_sold,
    top_products,
    refunds_total,
    refund_count,
    net_sales,
    net_cash_total,
    net_card_total,
  };
}

async function aggregateDayProfit(db, dateStr) {
  const base = await aggregateDay(db, dateStr);
  // Historical COGS comes from sale-item snapshots, never current product cost,
  // so changing a cost today cannot alter the profit of an old sale.
  const cogsSales = await snapshotSalesCogsForRange(db, dateStr, dateStr);
  const cogsRef = await snapshotRefundCogsForRange(db, dateStr, dateStr);
  const cost = round2(cogsSales - cogsRef);
  const profit = round2(base.net_sales - cost);
  return {
    date: dateStr,
    revenue: base.net_sales,
    cost,
    profit,
    total_sales: base.total_sales,
    net_sales: base.net_sales,
    total_transactions: base.total_transactions,
    refunds_total: base.refunds_total,
    refund_count: base.refund_count,
    items_sold: base.items_sold,
  };
}

export function createReportsRouter(db) {
  const router = Router();

  router.use(requireAuth, requireRoles("admin", "accountant"));

  router.get("/today", async (_req, res) => {
    const dateStr = new Date().toISOString().slice(0, 10);
    const r = await aggregateDay(db, dateStr);
    res.json({
      date: dateStr,
      revenue: r.net_sales,
      transaction_count: r.total_transactions,
      refund_count: r.refund_count,
      refund_amount: r.refunds_total,
      items_sold: r.items_sold,
      total_sales: r.total_sales,
      net_sales: r.net_sales,
      net_cash_total: r.net_cash_total,
      net_card_total: r.net_card_total,
      cash_total: r.cash_total,
      card_total: r.card_total,
      on_account_total: r.on_account_total,
      change_total: r.change_total,
      collections_by_currency: r.collections_by_currency,
      collections_grand_total_nis: r.collections_grand_total_nis,
    });
  });

  router.get("/top-products", async (req, res) => {
    const date =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : new Date().toISOString().slice(0, 10);
    const r = await aggregateDay(db, date);
    res.json({
      date,
      products: (r.top_products || []).map((p) => ({
        product_name: p.name,
        quantity: p.quantity,
        revenue: p.revenue,
      })),
    });
  });

  router.get("/near-expiry", async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const days = await resolveExpiryAlertDays(db);
    const { products, batches } = await fetchNearExpiryItems(db, days);

    const items = [
      ...products.map((r) => ({
        kind: "product",
        id: r.id,
        name: r.name,
        barcode: r.barcode ?? null,
        unit: r.unit ?? null,
        quantity: Number(r.stock) || 0,
        expiry_date: r.expiry_date,
        days_until_expiry: r.days_until_expiry,
      })),
      ...batches.map((r) => ({
        kind: "batch",
        id: r.id,
        name: r.product_name,
        barcode: r.barcode ?? null,
        batch_no: r.batch_no ?? null,
        quantity: Number(r.quantity) || 0,
        expiry_date: r.expiry_date,
        days_until_expiry: r.days_until_expiry,
      })),
    ].sort((a, b) => {
      const dayDiff = Number(a.days_until_expiry) - Number(b.days_until_expiry);
      if (dayDiff !== 0) return dayDiff;
      return String(a.expiry_date).localeCompare(String(b.expiry_date));
    });

    const totalCount = items.length;
    const expiredCount = items.filter((r) => Number(r.days_until_expiry) < 0).length;

    res.json({
      days_threshold: days,
      limit,
      total_count: totalCount,
      expired_count: expiredCount,
      items: items.slice(0, limit),
    });
  });

  router.get("/low-stock", async (req, res) => {
    const threshold = Math.max(0, Number(req.query.threshold) || 5);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const countRow = await db.get(
      `SELECT COUNT(*) AS total FROM products WHERE COALESCE(stock, 0) <= ?`,
      [threshold]
    );
    const outOfStockRow = await db.get(
      `SELECT COUNT(*) AS total FROM products WHERE COALESCE(stock, 0) <= 0`
    );
    const rows = await db.all(
      `SELECT id, name, barcode, stock FROM products
       WHERE COALESCE(stock, 0) <= ?
       ORDER BY COALESCE(stock, 0) ASC, name ASC
       LIMIT ?`,
      [threshold, limit]
    );
    res.json({
      threshold,
      limit,
      total_count: Number(countRow?.total) || 0,
      out_of_stock_count: Number(outOfStockRow?.total) || 0,
      products: rows,
    });
  });

  router.get("/last-7-days", async (_req, res) => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const dateStr = dt.toISOString().slice(0, 10);
      const row = await aggregateDayProfit(db, dateStr);
      out.push(row);
    }
    res.json({ success: true, days: out });
  });

  router.get("/last-30-days", async (_req, res) => {
    const out = [];
    for (let i = 29; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const dateStr = dt.toISOString().slice(0, 10);
      const row = await aggregateDayProfit(db, dateStr);
      out.push(row);
    }
    res.json({ success: true, days: out });
  });

  router.get("/daily", async (req, res) => {
    const date =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : new Date().toISOString().slice(0, 10);
    const report = await aggregateDay(db, date);
    res.json(report);
  });

  router.get("/range", async (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to || typeof from !== "string" || typeof to !== "string") {
      return res.status(400).json({ error: "مطلوب معلما from و to بصيغة YYYY-MM-DD" });
    }
    const dates = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    let total_sales = 0;
    let total_transactions = 0;
    let items_sold = 0;
    const byDay = [];
    for (const dateStr of dates) {
      const r = await aggregateDay(db, dateStr);
      total_sales = round2(total_sales + r.total_sales);
      total_transactions += r.total_transactions;
      items_sold += r.items_sold;
      byDay.push({
        date: dateStr,
        total_sales: r.total_sales,
        transactions: r.total_transactions,
      });
    }
    res.json({
      success: true,
      from,
      to,
      total_sales,
      total_transactions,
      items_sold,
      by_day: byDay,
    });
  });

  router.get("/last7days", async (_req, res) => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const dateStr = dt.toISOString().slice(0, 10);
      const r = await aggregateDay(db, dateStr);
      out.push({
        date: dateStr,
        total_sales: r.total_sales,
        total_transactions: r.total_transactions,
        items_sold: r.items_sold,
        refunds_total: r.refunds_total,
        net_sales: r.net_sales,
      });
    }
    res.json({ success: true, days: out });
  });

  router.get("/products/:productId/sales-by-price", async (req, res) => {
    const productId = parsePositiveInt(req.params.productId);
    if (!productId) {
      return res.status(400).json({ error: "معرف المنتج غير صالح", code: "VALIDATION_ERROR" });
    }

    const product = await db.get("SELECT id, name FROM products WHERE id = ?", [productId]);
    if (!product) {
      return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    }

    const dateFrom = parseDateParam(req.query.date_from);
    const dateTo = parseDateParam(req.query.date_to);
    if (req.query.date_from && !dateFrom) {
      return res.status(400).json({ error: "date_from يجب أن يكون بصيغة YYYY-MM-DD", code: "VALIDATION_ERROR" });
    }
    if (req.query.date_to && !dateTo) {
      return res.status(400).json({ error: "date_to يجب أن يكون بصيغة YYYY-MM-DD", code: "VALIDATION_ERROR" });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({ error: "date_from يجب أن يسبق date_to", code: "VALIDATION_ERROR" });
    }

    const cashierId = req.query.cashier_id ? parsePositiveInt(req.query.cashier_id) : null;
    if (req.query.cashier_id && !cashierId) {
      return res.status(400).json({ error: "cashier_id غير صالح", code: "VALIDATION_ERROR" });
    }

    const storeId = req.query.store_id ? parsePositiveInt(req.query.store_id) : null;
    if (req.query.store_id && !storeId) {
      return res.status(400).json({ error: "store_id غير صالح", code: "VALIDATION_ERROR" });
    }

    const includeRefunds = parseBoolParam(req.query.include_refunds, true);
    const filters = { dateFrom, dateTo, cashierId, storeId };

    const salesRows = await aggregateSalesByPrice(db, productId, filters);
    const refundByPrice = includeRefunds
      ? await aggregateRefundsByPrice(db, productId, filters)
      : new Map();

    const { rows, summary } = mergeSalesAndRefunds(salesRows, refundByPrice, includeRefunds);

    if (rows.length > 0) {
      for (const row of rows) {
        row.product_id = productId;
        row.product_name = product.name;
      }
    }

    res.json({
      success: true,
      product_id: productId,
      product_name: product.name,
      filters: {
        date_from: dateFrom,
        date_to: dateTo,
        cashier_id: cashierId,
        store_id: storeId,
        include_refunds: includeRefunds,
      },
      rows,
      summary,
    });
  });

  router.get("/account-statement", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const partyType = String(req.query.partyType || req.query.party_type || "").toLowerCase();
    const partyId = Number(req.query.partyId || req.query.party_id);
    const from = parseStatementDate(req.query.from);
    const to = parseStatementDate(req.query.to);
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize || req.query.page_size ? Number(req.query.pageSize || req.query.page_size) : undefined;
    const exportAll = String(req.query.export || "") === "1";

    if (!partyType || !partyId) {
      return res.status(400).json({
        error: "partyType و partyId مطلوبان",
        code: "VALIDATION_ERROR",
      });
    }
    if (req.query.from && !from) {
      return res.status(400).json({ error: "from تاريخ غير صالح", code: "VALIDATION_ERROR" });
    }
    if (req.query.to && !to) {
      return res.status(400).json({ error: "to تاريخ غير صالح", code: "VALIDATION_ERROR" });
    }

    try {
      const fn = exportAll ? getAccountStatementExport : getAccountStatement;
      const report = await fn(db, {
        partyType,
        partyId,
        from,
        to,
        page,
        pageSize: exportAll ? undefined : pageSize ?? 100,
        useDefaultRange: !from && !to,
      });
      res.json(report);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  router.get("/account-statement/excel", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const partyType = String(req.query.partyType || req.query.party_type || "").toLowerCase();
    const partyId = Number(req.query.partyId || req.query.party_id);
    const from = parseStatementDate(req.query.from);
    const to = parseStatementDate(req.query.to);

    if (!partyType || !partyId) {
      return res.status(400).json({ error: "partyType و partyId مطلوبان", code: "VALIDATION_ERROR" });
    }

    try {
      const report = await getAccountStatementExport(db, {
        partyType,
        partyId,
        from,
        to,
        useDefaultRange: !from && !to,
      });
      const sheetRows = [
        ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
        ...report.rows.map((r) => [
          r.referenceNumber || r.line_no || "",
          r.description,
          r.date || "",
          r.debit || 0,
          r.credit || 0,
          r.runningBalanceFormatted || r.runningBalance,
          r.notes || "",
        ]),
        [],
        ["", "", "", report.totals.debit, report.totals.credit, report.totals.finalBalanceFormatted, "الإجمالي"],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!rtl"] = true;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "كشف حساب");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const fname = `account-statement-${partyType}-${partyId}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      res.send(buf);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  return router;
}
