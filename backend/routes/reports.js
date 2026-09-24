import { createSafeRouter } from "../utils/asyncHandler.js";
import { requireAuth, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import {
  snapshotSalesCogsForRange,
  snapshotRefundCogsForRange,
  snapshotSalesCogsByDay,
  snapshotRefundCogsByDay,
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
  fetchRefundsForShopDate,
  fetchRefundsForShopDateRange,
  fetchTransactionsForShopDate,
  fetchTransactionsForShopDateRange,
  shopBusinessDayYmd,
} from "../utils/businessDay.js";
import { addShopDays, shopDateRange, shopTodayYmd } from "../utils/shopTime.js";
import {
  assertBakeryDateRange,
  getBakeryReport,
  parseBakeryRevenueKind,
  presentBakeryCategoryLists,
  saveBakeryReportCategories,
} from "../services/bakeryReportService.js";

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

async function loadItemsByTransaction(db, transactionIds) {
  const itemsByTx = new Map();
  if (!transactionIds.length) return itemsByTx;
  const CHUNK = 400;
  for (let i = 0; i < transactionIds.length; i += CHUNK) {
    const chunk = transactionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const itemRows = await db.all(
      `SELECT transaction_id, name, product_id, quantity, line_gross, line_net, line_tax
       FROM transaction_items
       WHERE transaction_id IN (${placeholders})`,
      chunk
    );
    for (const it of itemRows) {
      const list = itemsByTx.get(it.transaction_id) || [];
      list.push(it);
      itemsByTx.set(it.transaction_id, list);
    }
  }
  return itemsByTx;
}

/** Billed line amount. line_gross is the pre-discount charge; line_net is what was posted. */
function billedLineRevenue(it) {
  if (it.line_net != null && it.line_net !== "" && Number.isFinite(Number(it.line_net))) {
    return round2(Number(it.line_net) + (Number(it.line_tax) || 0));
  }
  return round2(Number(it.line_gross) || 0);
}

async function aggregateDay(db, dateStr) {
  const rows = await fetchTransactionsForShopDate(db, dateStr);

  const paymentAgg = await aggregatePaymentLinesForDate(db, dateStr);
  const itemsByTx = await loadItemsByTransaction(
    db,
    rows.map((r) => r.id)
  );

  let total_sales = 0;
  let total_tax = 0;
  let total_net = 0;
  let change_total = 0;
  let rounding_adjustment = 0;
  let item_revenue = 0;
  let total_transactions = rows.length;
  const productMap = new Map();

  for (const r of rows) {
    total_sales = round2(total_sales + Number(r.total));
    rounding_adjustment = round2(rounding_adjustment + (Number(r.rounding_adjustment) || 0));
    change_total = round2(change_total + Number(r.change_amount || 0));
    total_tax = round2(total_tax + Number(r.tax || 0));
    total_net = round2(total_net + Number(r.subtotal || r.total));

    const txItems = itemsByTx.get(r.id) || [];
    if (txItems.length > 0) {
      for (const it of txItems) {
        const name = it.name || `Product ${it.product_id}`;
        const qty = Number(it.quantity) || 0;
        const prev = productMap.get(name) || { name, quantity: 0, revenue: 0 };
        prev.quantity += qty;
        const lineRevenue = billedLineRevenue(it);
        item_revenue = round2(item_revenue + lineRevenue);
        prev.revenue = round2(prev.revenue + lineRevenue);
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
        const lineRevenue = round2(qty * price);
        item_revenue = round2(item_revenue + lineRevenue);
        prev.quantity += qty;
        prev.revenue = round2(prev.revenue + lineRevenue);
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

  const refundRows = await fetchRefundsForShopDate(db, dateStr);
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
    rounding_adjustment: round2(rounding_adjustment),
    item_revenue: round2(item_revenue),
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
  const unknown = !!(cogsSales.unknown || cogsRef.unknown);
  const cost = unknown ? null : round2((cogsSales.cogs || 0) - (cogsRef.cogs || 0));
  const profit = unknown ? null : round2(base.net_sales - cost);
  return {
    date: dateStr,
    revenue: base.net_sales,
    cost,
    profit,
    cost_unknown: unknown,
    total_sales: base.total_sales,
    net_sales: base.net_sales,
    total_transactions: base.total_transactions,
    refunds_total: base.refunds_total,
    refund_count: base.refund_count,
    items_sold: base.items_sold,
  };
}

function emptyProfitDay(dateStr) {
  return {
    date: dateStr,
    revenue: 0,
    cost: 0,
    profit: 0,
    cost_unknown: false,
    total_sales: 0,
    net_sales: 0,
    total_transactions: 0,
    refunds_total: 0,
    refund_count: 0,
    items_sold: 0,
  };
}

async function aggregateProfitRange(db, fromYmd, toYmd) {
  const dates = shopDateRange(fromYmd, toYmd);
  const days = new Map(dates.map((dateStr) => [dateStr, emptyProfitDay(dateStr)]));
  const [txs, refunds, salesCogs, refundCogs] = await Promise.all([
    fetchTransactionsForShopDateRange(db, fromYmd, toYmd),
    fetchRefundsForShopDateRange(db, fromYmd, toYmd),
    snapshotSalesCogsByDay(db, fromYmd, toYmd),
    snapshotRefundCogsByDay(db, fromYmd, toYmd),
  ]);
  const itemsByTx = await loadItemsByTransaction(
    db,
    txs.map((t) => t.id)
  );

  for (const t of txs) {
    const ymd = shopBusinessDayYmd(t);
    const bucket = days.get(ymd);
    if (!bucket) continue;
    bucket.total_transactions += 1;
    bucket.total_sales = round2(bucket.total_sales + Number(t.total));
    const txItems = itemsByTx.get(t.id) || [];
    if (txItems.length > 0) {
      bucket.items_sold += txItems.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    } else {
      try {
        const items = JSON.parse(t.items_json);
        if (Array.isArray(items)) {
          bucket.items_sold += items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
        }
      } catch {
        /* ignore */
      }
    }
  }

  for (const r of refunds) {
    const ymd = shopBusinessDayYmd(r);
    const bucket = days.get(ymd);
    if (!bucket) continue;
    bucket.refund_count += 1;
    bucket.refunds_total = round2(bucket.refunds_total + Number(r.total));
  }

  for (const dateStr of dates) {
    const bucket = days.get(dateStr);
    const salesDay = salesCogs.get(dateStr) || { known: 0, unknown: false };
    const refundDay = refundCogs.get(dateStr) || { known: 0, unknown: false };
    const unknown = !!(salesDay.unknown || refundDay.unknown);
    const cost = unknown ? null : round2(salesDay.known - refundDay.known);
    bucket.net_sales = round2(bucket.total_sales - bucket.refunds_total);
    bucket.revenue = bucket.net_sales;
    bucket.cost = cost;
    bucket.profit = unknown ? null : round2(bucket.net_sales - cost);
    bucket.cost_unknown = unknown;
  }

  return dates.map((dateStr) => days.get(dateStr));
}

export function createReportsRouter(db) {
  const router = createSafeRouter();
  const dashboard = requireReportsPermission(db, "dashboard");
  const salesReports = requireReportsPermission(db, "sales_reports");
  const expiry = requireReportsPermission(db, "expiry");
  const salesByPrice = requireReportsPermission(db, "sales_by_price");
  const bakery = requireReportsPermission(db, "bakery");
  const bakeryRead = requireAnyReportsPermission(db, "bakery", "bakery_supplies");
  const accountStatement = requireReportsPermission(db, "account_statement");
  const dashboardOrSales = requireAnyReportsPermission(db, "dashboard", "sales_reports");

  router.use(requireAuth);

  router.get("/today", dashboard, async (_req, res) => {
    const dateStr = shopTodayYmd();
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

  router.get("/top-products", dashboard, async (req, res) => {
    const date =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : shopTodayYmd();
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

  router.get("/near-expiry", dashboard, async (req, res) => {
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

  router.get("/low-stock", dashboard, async (req, res) => {
    const threshold = Math.max(0, Number(req.query.threshold) || 5);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const scopeFilter = ` AND COALESCE(inventory_scope, 'retail') = 'retail'`;
    const countRow = await db.get(
      `SELECT COUNT(*) AS total FROM products
       WHERE COALESCE(stock, 0) <= ?${scopeFilter}`,
      [threshold]
    );
    const outOfStockRow = await db.get(
      `SELECT COUNT(*) AS total FROM products
       WHERE COALESCE(stock, 0) <= 0${scopeFilter}`
    );
    const rows = await db.all(
      `SELECT id, name, barcode, stock FROM products
       WHERE COALESCE(stock, 0) <= ?${scopeFilter}
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

  router.get("/last-7-days", dashboard, async (_req, res) => {
    const today = shopTodayYmd();
    const from = addShopDays(today, -6);
    const out = await aggregateProfitRange(db, from, today);
    res.json({ success: true, days: out });
  });

  router.get("/last-30-days", dashboard, async (_req, res) => {
    const today = shopTodayYmd();
    const from = addShopDays(today, -29);
    const out = await aggregateProfitRange(db, from, today);
    res.json({ success: true, days: out });
  });

  router.get("/daily", dashboardOrSales, async (req, res) => {
    const date =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : shopTodayYmd();
    const report = await aggregateDay(db, date);
    const profit = await aggregateDayProfit(db, date);
    res.json({
      ...report,
      cost: profit.cost,
      profit: profit.profit,
      cost_unknown: profit.cost_unknown,
    });
  });

  router.get("/range", salesReports, async (req, res) => {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: "مطلوب معلما from و to بصيغة YYYY-MM-DD" });
    }
    if (from > to) {
      return res.status(400).json({ error: "from يجب أن يسبق to أو يساويه" });
    }
    const dates = shopDateRange(from, to);
    if (dates.length > 366) {
      return res.status(400).json({ error: "الفترة تتجاوز 366 يوماً" });
    }
    let total_sales = 0;
    let total_transactions = 0;
    let items_sold = 0;
    let net_sales = 0;
    let refunds_total = 0;
    let refund_count = 0;
    let cash_total = 0;
    let card_total = 0;
    let on_account_total = 0;
    const profitDays = await aggregateProfitRange(db, from, to);
    const profitByDate = new Map(profitDays.map((d) => [d.date, d]));
    const byDay = [];
    for (const dateStr of dates) {
      const r = await aggregateDay(db, dateStr);
      const p = profitByDate.get(dateStr) || {};
      total_sales = round2(total_sales + r.total_sales);
      total_transactions += r.total_transactions;
      items_sold += r.items_sold;
      net_sales = round2(net_sales + r.net_sales);
      refunds_total = round2(refunds_total + r.refunds_total);
      refund_count += r.refund_count;
      cash_total = round2(cash_total + r.cash_total);
      card_total = round2(card_total + r.card_total);
      on_account_total = round2(on_account_total + r.on_account_total);
      byDay.push({
        date: dateStr,
        total_sales: r.total_sales,
        transactions: r.total_transactions,
        net_sales: r.net_sales,
        refunds_total: r.refunds_total,
        refund_count: r.refund_count,
        items_sold: r.items_sold,
        cash_total: r.cash_total,
        card_total: r.card_total,
        on_account_total: r.on_account_total,
        cost: p.cost ?? null,
        profit: p.profit ?? null,
        cost_unknown: !!p.cost_unknown,
      });
    }
    const rangeUnknown = byDay.some((d) => d.cost_unknown);
    const cost = rangeUnknown
      ? null
      : round2(byDay.reduce((s, d) => s + (Number(d.cost) || 0), 0));
    const profit = rangeUnknown
      ? null
      : round2(byDay.reduce((s, d) => s + (Number(d.profit) || 0), 0));
    res.json({
      success: true,
      from,
      to,
      total_sales,
      total_transactions,
      items_sold,
      net_sales,
      refunds_total,
      refund_count,
      cash_total,
      card_total,
      on_account_total,
      cost,
      profit,
      cost_unknown: rangeUnknown,
      by_day: byDay,
    });
  });

  router.get("/daily-series", dashboard, async (req, res) => {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: "مطلوب معلما from و to بصيغة YYYY-MM-DD" });
    }
    if (from > to) {
      return res.status(400).json({ error: "from يجب أن يسبق to أو يساويه" });
    }
    const dates = shopDateRange(from, to);
    if (dates.length > 366) {
      return res.status(400).json({ error: "الفترة تتجاوز 366 يوماً" });
    }
    const out = await aggregateProfitRange(db, from, to);
    res.json({ success: true, from, to, days: out });
  });

  router.get("/last7days", dashboard, async (_req, res) => {
    const today = shopTodayYmd();
    const from = addShopDays(today, -6);
    const days = await aggregateProfitRange(db, from, today);
    res.json({
      success: true,
      days: days.map((r) => ({
        date: r.date,
        total_sales: r.total_sales,
        total_transactions: r.total_transactions,
        items_sold: r.items_sold,
        refunds_total: r.refunds_total,
        net_sales: r.net_sales,
      })),
    });
  });

  router.get("/bakery", bakeryRead, async (req, res) => {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (req.query.from && !from) {
      return res.status(400).json({ error: "from يجب أن يكون بصيغة YYYY-MM-DD", code: "VALIDATION_ERROR" });
    }
    if (req.query.to && !to) {
      return res.status(400).json({ error: "to يجب أن يكون بصيغة YYYY-MM-DD", code: "VALIDATION_ERROR" });
    }
    const fromYmd = from || shopTodayYmd();
    const toYmd = to || fromYmd;
    assertBakeryDateRange(fromYmd, toYmd);

    const productId = req.query.product_id ? parsePositiveInt(req.query.product_id) : null;
    if (req.query.product_id && !productId) {
      return res.status(400).json({ error: "product_id غير صالح", code: "VALIDATION_ERROR" });
    }

    if (req.query.revenue_kind && !parseBakeryRevenueKind(req.query.revenue_kind)) {
      return res.status(400).json({ error: "revenue_kind غير صالح", code: "VALIDATION_ERROR" });
    }

    const report = await getBakeryReport(db, {
      from: fromYmd,
      to: toYmd,
      productId,
      q: req.query.q,
      sort: req.query.sort,
      dir: req.query.dir,
      revenueKind: req.query.revenue_kind,
    });
    res.json({ success: true, ...report });
  });

  router.put("/bakery/categories", bakery, async (req, res) => {
    const resolved = await saveBakeryReportCategories(db, req.body?.category_ids);
    const presented = await presentBakeryCategoryLists(db, resolved);
    res.json({
      success: true,
      needs_configuration: resolved.needs_configuration,
      configuration_source: resolved.source,
      selected_categories: presented.selected_categories,
      available_categories: presented.available_categories,
      uncategorized_product_count: presented.uncategorized_product_count,
    });
  });

  router.get("/products/:productId/sales-by-price", salesByPrice, async (req, res) => {
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

  router.get("/account-statement", accountStatement, async (req, res) => {
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

  router.get("/account-statement/excel", accountStatement, async (req, res) => {
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
