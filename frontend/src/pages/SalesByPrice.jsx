import { useCallback, useState } from "react";
import api from "../apiClient";
import ProductPicker from "../components/ProductPicker";
import { PageHeader, StatCard, EmptyState, ReportToolbar } from "../components/ui";
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
  const [product, setProduct] = useState(null);
  const [allHistory, setAllHistory] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [includeRefunds, setIncludeRefunds] = useState(true);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadReport = useCallback(async () => {
    if (!product?.id) {
      setError("اختر منتجاً أولاً");
      return;
    }
    if (!allHistory && dateFrom && dateTo && dateFrom > dateTo) {
      setError("تاريخ البداية يجب أن يسبق تاريخ النهاية");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = { include_refunds: includeRefunds };
      if (!allHistory) {
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;
      }

      const { data } = await api.get(
        `/api/reports/products/${product.id}/sales-by-price`,
        { params }
      );
      setRows(data.rows || []);
      setSummary(data.summary || null);
    } catch (e) {
      setError(e.message || "تعذّر تحميل التقرير");
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [product, allHistory, dateFrom, dateTo, includeRefunds]);

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

      {error && <div className="error-banner">{error}</div>}

      <div className="filter-row" style={{ marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div style={{ minWidth: 280, flex: 1 }}>
          <ProductPicker
            onPick={(p) => {
              setProduct(p);
              setRows([]);
              setSummary(null);
              setError(null);
            }}
            placeholder="ابحث عن منتج…"
          />
          {product ? (
            <p style={{ margin: "8px 0 0", color: "var(--office-panel-muted)" }}>
              المنتج المحدد: <strong>{product.name}</strong> (باركود {product.barcode})
            </p>
          ) : null}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={allHistory}
            onChange={(e) => setAllHistory(e.target.checked)}
          />
          كل سجل المبيعات
        </label>
        <label style={{ opacity: allHistory ? 0.5 : 1 }}>
          من تاريخ:
          <input
            type="date"
            value={dateFrom}
            disabled={allHistory}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label style={{ opacity: allHistory ? 0.5 : 1 }}>
          إلى تاريخ:
          <input
            type="date"
            value={dateTo}
            disabled={allHistory}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={includeRefunds}
            onChange={(e) => setIncludeRefunds(e.target.checked)}
          />
          تضمين الاسترجاعات
        </label>
        <button className="btn-primary" type="button" onClick={loadReport} disabled={loading || !product}>
          {loading ? "جاري التحميل…" : "عرض التقرير"}
        </button>
      </div>

      {summary ? (
        <div
          className="ui-stat-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <StatCard label="إجمالي الكمية" value={qty(summary.total_quantity)} icon="inventory" />
          <StatCard label="إجمالي المبيعات" value={ils(summary.total_revenue)} icon="finance" tone="green" />
          <StatCard label="إجمالي الربح" value={ils(summary.total_profit)} icon="finance" tone="teal" />
          <StatCard label="عدد الأسعار المختلفة" value={String(summary.distinct_prices)} icon="products" tone="orange" />
        </div>
      ) : null}

      {loading ? (
        <p>جاري التحميل…</p>
      ) : rows.length === 0 && product && !error ? (
        <EmptyState
          title={
            allHistory
              ? "لا توجد مبيعات مسجّلة لهذا المنتج"
              : "لا توجد مبيعات لهذا المنتج في الفترة المحددة"
          }
        />
      ) : rows.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>سعر البيع</th>
                <th>الكمية المباعة</th>
                <th>الكمية المسترجعة</th>
                <th>صافي الكمية</th>
                <th>عدد الفواتير</th>
                <th>إجمالي المبيعات</th>
                <th>إجمالي الربح</th>
                <th>أول عملية بيع</th>
                <th>آخر عملية بيع</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.unit_price_at_sale}>
                  <td>{ils(row.unit_price_at_sale)}</td>
                  <td>{qty(row.sold_quantity)}</td>
                  <td>{qty(row.refunded_quantity)}</td>
                  <td>{qty(row.net_quantity_sold)}</td>
                  <td>{row.number_of_transactions}</td>
                  <td>{ils(row.total_revenue)}</td>
                  <td>{ils(row.total_profit)}</td>
                  <td>{dateTime(row.first_sale_date)}</td>
                  <td>{dateTime(row.last_sale_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
