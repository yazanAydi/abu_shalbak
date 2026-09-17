import { ils, qty } from "../utils/format";

export const BAKERY_CLASSIFICATION_NOTE =
  "التصنيف حسب التصنيف الحالي للمنتج (لا يُحفظ التصنيف عند البيع). تغيير تصنيف المنتج يغيّر نتائج تقرير المخبز للفترات السابقة.";

export function formatQtyWithUnit(quantity, unit) {
  const unitLabel = String(unit || "").trim();
  return unitLabel ? `${qty(quantity)} ${unitLabel}` : qty(quantity);
}

export function formatQtyByUnit(list) {
  if (!Array.isArray(list) || list.length === 0) return "0";
  return list.map((row) => formatQtyWithUnit(row.quantity, row.unit)).join(" · ");
}

export function categoryOptionLabel(cat) {
  const count = Number(cat?.product_count) || 0;
  const inactive = Number(cat?.active) === 0 ? " (غير نشط)" : "";
  return `${cat?.name || "—"} — ${count} صنف${inactive}`;
}

export function emptySelectedCatalogCopy(report) {
  const selected = report?.selected_categories || [];
  const names = selected.map((c) => `${c.name} (${Number(c.product_count) || 0} صنف)`).join("، ");
  const uncategorized = Number(report?.uncategorized_product_count) || 0;
  const uncategorizedLine =
    uncategorized > 0
      ? ` يوجد ${uncategorized} منتجاً بلا تصنيف حالياً — لن يظهر في هذا التقرير حتى يُحفظ له تصنيف.`
      : "";
  return {
    title: "لا توجد منتجات في التصنيفات المحددة",
    hint:
      (names
        ? `التصنيفات المحددة: ${names}. `
        : "لم تُطابق التصنيفات المحددة أي منتج. ") +
      "مواد المخبز منفصلة عن أصناف البيع ما لم تُختر عمداً. اختر تصنيفاً بعدد أصناف، أو صنّف المنتجات من تنظيم المنتجات." +
      uncategorizedLine,
  };
}

export function bakeryRevenueKindLabel(kind) {
  return kind === "material" ? "مادة" : "صنف بيع";
}

export const BAKERY_MATERIAL_SALES_EMPTY =
  "لا مبيعات لمواد أُتيحت للكاشير في هذه الفترة";

export function bakerySummaryItems(kpis, options = {}) {
  if (!kpis) return [];
  const slice = options.slice;
  const revenueItems =
    slice === "material"
      ? [{ label: "إيراد بيع المواد", value: ils(kpis.material_net_revenue ?? kpis.net_revenue) }]
      : [
          { label: "إيرادات المخبز", value: ils(kpis.net_revenue) },
          { label: "إيراد أصناف البيع", value: ils(kpis.finished_net_revenue ?? 0) },
          { label: "إيراد بيع المواد", value: ils(kpis.material_net_revenue ?? 0) },
        ];
  return [
    ...revenueItems,
    { label: "الكمية المباعة", value: formatQtyByUnit(kpis.sold_quantity_by_unit) },
    { label: "الكمية المرتجعة", value: formatQtyByUnit(kpis.refunded_quantity_by_unit) },
    { label: "صافي الكمية المباعة", value: formatQtyByUnit(kpis.net_quantity_by_unit) },
    { label: "عدد الفواتير", value: String(kpis.invoice_count ?? 0) },
  ];
}

export function bakeryExportColumns() {
  return [
    { key: "name", header: "المنتج" },
    { key: "revenue_kind", header: "النوع", value: (r) => bakeryRevenueKindLabel(r.revenue_kind) },
    { key: "barcode", header: "الباركود", value: (r) => r.barcode || "" },
    { key: "unit", header: "الوحدة" },
    { key: "stock", header: "المخزون الحالي", value: (r) => formatQtyWithUnit(r.stock, r.unit) },
    {
      key: "sold_quantity",
      header: "الكمية المباعة",
      value: (r) => formatQtyWithUnit(r.sold_quantity, r.unit),
    },
    {
      key: "refunded_quantity",
      header: "الكمية المرتجعة",
      value: (r) => formatQtyWithUnit(r.refunded_quantity, r.unit),
    },
    {
      key: "net_quantity",
      header: "صافي الكمية المباعة",
      value: (r) => formatQtyWithUnit(r.net_quantity, r.unit),
    },
    { key: "net_revenue", header: "صافي المبيعات", value: (r) => ils(r.net_revenue) },
    { key: "invoice_count", header: "عدد الفواتير" },
  ];
}

export function bakeryPrintMeta({ from, to, report }) {
  return [
    `الفترة: ${from} — ${to}`,
    report?.stock_note || "المخزون الحالي — لا يتأثر بالفترة المختارة",
    report?.classification_note || report?.classification?.note || BAKERY_CLASSIFICATION_NOTE,
    report?.invoice_count_note || "",
  ].filter(Boolean);
}
