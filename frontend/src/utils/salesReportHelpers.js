import { ils, qty } from "./format";

const ilsCell = (n) => ils(n);

export const TOP_PRODUCT_COLUMNS = [
  { key: "name", header: "المنتج", value: (p) => p.name || p.product_name },
  { key: "quantity", header: "الكمية", value: (p) => qty(p.quantity) },
  { key: "revenue", header: "الإيراد", value: (p) => ilsCell(p.revenue) },
];

export const RANGE_BY_DAY_COLUMNS = [
  { key: "date", header: "التاريخ" },
  { key: "transactions", header: "العمليات" },
  { key: "total_sales", header: "إجمالي المبيعات", value: (r) => ilsCell(r.total_sales) },
  { key: "refunds_total", header: "الاسترجاعات", value: (r) => ilsCell(r.refunds_total) },
  { key: "net_sales", header: "صافي المبيعات", value: (r) => ilsCell(r.net_sales) },
  { key: "items_sold", header: "القطع", value: (r) => qty(r.items_sold) },
  { key: "cash_total", header: "نقد", value: (r) => ilsCell(r.cash_total) },
  { key: "card_total", header: "بطاقة", value: (r) => ilsCell(r.card_total) },
];

/**
 * @param {object | null} report — /api/reports/daily payload
 * @returns {{ label: string, value: string }[]}
 */
export function buildDailySummaryItems(report) {
  if (!report) return [];
  return [
    { label: "صافي المبيعات", value: ils(report.net_sales) },
    { label: "إجمالي المبيعات", value: ils(report.total_sales) },
    { label: "عدد العمليات", value: String(report.total_transactions ?? 0) },
    { label: "الاسترجاعات", value: `${report.refund_count ?? 0} (${ils(report.refunds_total)})` },
    { label: "القطع المباعة", value: String(report.items_sold ?? 0) },
    { label: "نقد (إجمالي)", value: ils(report.cash_total) },
    { label: "بطاقة (إجمالي)", value: ils(report.card_total) },
    { label: "مبيعات الذمة", value: ils(report.on_account_total) },
    { label: "الباقي المُرجَع", value: ils(report.change_total) },
    { label: "صافي النقد", value: ils(report.net_cash_total) },
    { label: "صافي البطاقة", value: ils(report.net_card_total) },
  ];
}

/**
 * @param {object | null} report
 * @returns {{ label: string, value: string }[]}
 */
export function buildCollectionSummaryItems(report) {
  const collections = Array.isArray(report?.collections_by_currency)
    ? report.collections_by_currency
    : [];
  if (collections.length === 0) return [];
  const items = collections.map((c) => ({
    label: c.name || c.code,
    value: `${c.symbol || "₪"}${Number(c.original_total || 0).toFixed(2)}${
      String(c.code).toUpperCase() !== "NIS"
        ? ` (₪${Number(c.nis_total || 0).toFixed(2)})`
        : ""
    }`,
  }));
  if (report?.collections_grand_total_nis != null) {
    items.push({
      label: "القيمة المحاسبية (₪)",
      value: ils(report.collections_grand_total_nis),
    });
  }
  return items;
}

/**
 * @param {object | null} report — /api/reports/range payload
 * @returns {{ label: string, value: string }[]}
 */
export function buildRangeSummaryItems(report) {
  if (!report) return [];
  return [
    { label: "من", value: report.from || "—" },
    { label: "إلى", value: report.to || "—" },
    { label: "صافي المبيعات", value: ils(report.net_sales) },
    { label: "إجمالي المبيعات", value: ils(report.total_sales) },
    { label: "عدد العمليات", value: String(report.total_transactions ?? 0) },
    { label: "الاسترجاعات", value: `${report.refund_count ?? 0} (${ils(report.refunds_total)})` },
    { label: "القطع المباعة", value: String(report.items_sold ?? 0) },
    { label: "نقد (إجمالي)", value: ils(report.cash_total) },
    { label: "بطاقة (إجمالي)", value: ils(report.card_total) },
  ];
}

/**
 * Normalize top products from daily report payload.
 * @param {object | null} report
 */
export function getTopProductsFromDaily(report) {
  const raw = report?.top_products;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    name: p.name,
    quantity: p.quantity,
    revenue: p.revenue,
  }));
}
