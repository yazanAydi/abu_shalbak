import { useCallback, useMemo, useState } from "react";
import api from "../apiClient";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader,
  StatCard,
  DataTable,
  FilterBar,
  Button,
  FormField,
  Input,
  ReportToolbar,
  useToast,
} from "../components/ui";
import { ils, qty, dateTime } from "../utils/format";

const SALES_COLUMNS = [
  { key: "unit_price_at_sale", header: "سعر البيع", value: (r) => ils(r.unit_price_at_sale) },
  { key: "sold_quantity", header: "الكمية المباعة", value: (r) => qty(r.sold_quantity) },
  { key: "refunded_quantity", header: "الكمية المسترجعة", value: (r) => qty(r.refunded_quantity) },
  { key: "net_quantity_sold", header: "صافي الكمية", value: (r) => qty(r.net_quantity_sold) },
  { key: "number_of_transactions", header: "عدد الفواتير" },
  { key: "total_revenue", header: "إجمالي المبيعات", value: (r) => ils(r.total_revenue) },
  { key: "total_profit", header: "إجمالي الربح", value: (r) => ils(r.total_profit) },
  { key: "first_sale_date", header: "أول عملية بيع", value: (r) => dateTime(r.first_sale_date) },
  { key: "last_sale_date", header: "آخر عملية بيع", value: (r) => dateTime(r.last_sale_date) },
];

export default function SalesByPrice() {
  const toast = useToast();
  const [product, setProduct] = useState(null);
  const [allHistory, setAllHistory] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [includeRefunds, setIncludeRefunds] = useState(true);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    if (!product?.id) {
      toast.error("اختر منتجاً أولاً");
      return;
    }
    if (!allHistory && dateFrom && dateTo && dateFrom > dateTo) {
      toast.error("تاريخ البداية يجب أن يسبق تاريخ النهاية");
      return;
    }
    setLoading(true);
    try {
      const params = { include_refunds: includeRefunds };
      if (!allHistory) {
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;
      }

      const { data } = await api.get(`/api/reports/products/${product.id}/sales-by-price`, { params });
      setRows(data.rows || []);
      setSummary(data.summary || null);
    } catch (e) {
      toast.error(e.message || "تعذّر تحميل التقرير");
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [product, allHistory, dateFrom, dateTo, includeRefunds, toast]);

  const tableColumns = useMemo(
    () => [
      { key: "unit_price_at_sale", header: "سعر البيع", className: "num", render: (r) => ils(r.unit_price_at_sale) },
      { key: "sold_quantity", header: "الكمية المباعة", className: "num", render: (r) => qty(r.sold_quantity) },
      { key: "refunded_quantity", header: "الكمية المسترجعة", className: "num", render: (r) => qty(r.refunded_quantity) },
      { key: "net_quantity_sold", header: "صافي الكمية", className: "num", render: (r) => qty(r.net_quantity_sold) },
      { key: "number_of_transactions", header: "عدد الفواتير", className: "num" },
      { key: "total_revenue", header: "إجمالي المبيعات", className: "num", render: (r) => ils(r.total_revenue) },
      { key: "total_profit", header: "إجمالي الربح", className: "num", render: (r) => ils(r.total_profit) },
      { key: "first_sale_date", header: "أول عملية بيع", render: (r) => dateTime(r.first_sale_date) },
      { key: "last_sale_date", header: "آخر عملية بيع", render: (r) => dateTime(r.last_sale_date) },
    ],
    []
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="المبيعات حسب سعر البيع"
        subtitle="تتبع الكميات المباعة لكل سعر تاريخي للمنتج"
        icon="finance"
        actions={
          <ReportToolbar
            title="المبيعات حسب سعر البيع"
            subtitle={product ? `المنتج: ${product.name}` : undefined}
            columns={SALES_COLUMNS}
            rows={rows}
            filename="sales-by-price"
            summary={
              summary
                ? [
                    { label: "إجمالي الكمية", value: qty(summary.total_quantity) },
                    { label: "إجمالي المبيعات", value: ils(summary.total_revenue) },
                    { label: "إجمالي الربح", value: ils(summary.total_profit) },
                    { label: "عدد الأسعار المختلفة", value: String(summary.distinct_prices) },
                  ]
                : undefined
            }
            disabled={loading || !product}
          />
        }
      />

      <FilterBar
        actions={
          <Button onClick={loadReport} disabled={loading || !product}>
            {loading ? "جاري التحميل…" : "عرض التقرير"}
          </Button>
        }
      >
        <FormField label="المنتج" className="ui-field--full">
          <ProductPicker
            onPick={(p) => {
              setProduct(p);
              setRows([]);
              setSummary(null);
            }}
            placeholder="ابحث عن منتج…"
          />
          {product ? (
            <span className="ui-field__hint">
              المنتج المحدد: <strong>{product.name}</strong> (باركود {product.barcode})
            </span>
          ) : null}
        </FormField>
        <FormField label=" ">
          <label className="ui-field__label ui-checkbox-label">
            <input type="checkbox" checked={allHistory} onChange={(e) => setAllHistory(e.target.checked)} />
            كل سجل المبيعات
          </label>
        </FormField>
        <FormField label="من تاريخ">
          <Input type="date" value={dateFrom} disabled={allHistory} onChange={(e) => setDateFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى تاريخ">
          <Input type="date" value={dateTo} disabled={allHistory} onChange={(e) => setDateTo(e.target.value)} />
        </FormField>
        <FormField label=" ">
          <label className="ui-field__label ui-checkbox-label">
            <input
              type="checkbox"
              checked={includeRefunds}
              onChange={(e) => setIncludeRefunds(e.target.checked)}
            />
            تضمين الاسترجاعات
          </label>
        </FormField>
      </FilterBar>

      {summary ? (
        <div className="ui-stat-grid">
          <StatCard label="إجمالي الكمية" value={qty(summary.total_quantity)} icon="inventory" />
          <StatCard label="إجمالي المبيعات" value={ils(summary.total_revenue)} icon="finance" tone="green" />
          <StatCard label="إجمالي الربح" value={ils(summary.total_profit)} icon="finance" tone="teal" />
          <StatCard
            label="عدد الأسعار المختلفة"
            value={String(summary.distinct_prices)}
            icon="products"
            tone="orange"
          />
        </div>
      ) : null}

      {product ? (
        <DataTable
          columns={tableColumns}
          rows={rows}
          loading={loading}
          empty={
            allHistory
              ? "لا توجد مبيعات مسجّلة لهذا المنتج"
              : "لا توجد مبيعات لهذا المنتج في الفترة المحددة"
          }
          emptyIcon="finance"
        />
      ) : null}
    </div>
  );
}
