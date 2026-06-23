import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { PageHeader, ReportToolbar } from "../components/ui";

const EXPIRY_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "unit", header: "الوحدة", value: (r) => r.unit || "—" },
  { key: "stock", header: "الكمية" },
  { key: "expiry_date", header: "تاريخ الصلاحية" },
  {
    key: "days_until_expiry",
    header: "الأيام المتبقية",
    value: (r) =>
      r.days_until_expiry < 0 ? `منتهي (${r.days_until_expiry})` : String(r.days_until_expiry),
  },
];

const LOW_STOCK_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "category", header: "الفئة", value: (r) => r.category || "—" },
  { key: "unit", header: "الوحدة", value: (r) => r.unit || "—" },
  { key: "stock", header: "الكمية" },
];

const LOW_STOCK_THRESHOLD = 5;

export default function ExpiryReports() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [days, setDays] = useState(30);
  const [threshold, setThreshold] = useState(LOW_STOCK_THRESHOLD);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState(() =>
    searchParams.get("tab") === "lowstock" ? "lowstock" : "expiry"
  );
  const [error, setError] = useState(null);

  useEffect(() => {
    if (searchParams.get("tab") === "lowstock") setTab("lowstock");
    const t = Number(searchParams.get("threshold"));
    if (Number.isFinite(t) && t >= 0) setThreshold(t);
  }, [searchParams]);

  const loadExpiry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/api/inventory/expiry?days=${days}`);
      setRows(data);
    } catch {
      setError("تعذّر تحميل تقرير الصلاحية");
    } finally {
      setLoading(false);
    }
  }, [days]);

  const loadLowStock = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/api/inventory/low-stock?threshold=${threshold}`);
      setLowStock(data);
    } catch {
      setError("تعذّر تحميل تقرير المخزون المنخفض");
    } finally {
      setLoading(false);
    }
  }, [threshold]);

  useEffect(() => {
    if (tab === "expiry") loadExpiry();
    else loadLowStock();
  }, [tab, loadExpiry, loadLowStock]);

  const reportConfig = useMemo(() => {
    if (tab === "expiry") {
      return {
        title: "تقرير الصلاحية",
        subtitle: `الأيام القادمة: ${days}`,
        columns: EXPIRY_COLUMNS,
        rows,
        filename: "expiry-report",
      };
    }
    return {
      title: "تقرير المخزون المنخفض",
      subtitle: `حد المخزون: ≤${threshold}`,
      columns: LOW_STOCK_COLUMNS,
      rows: lowStock,
      filename: "low-stock-report",
    };
  }, [tab, days, threshold, rows, lowStock]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تقارير المخزون"
        subtitle="الصلاحية والمخزون المنخفض"
        icon="expiry"
        actions={
          <ReportToolbar
            title={reportConfig.title}
            subtitle={reportConfig.subtitle}
            columns={reportConfig.columns}
            rows={reportConfig.rows}
            filename={reportConfig.filename}
            disabled={loading}
          />
        }
      />

      {error && <div className="error-banner">{error}</div>}

      <div className="tab-bar">
        <button className={tab === "expiry" ? "tab active" : "tab"} onClick={() => setTab("expiry")}>
          تقرير الصلاحية
        </button>
        <button className={tab === "lowstock" ? "tab active" : "tab"} onClick={() => setTab("lowstock")}>
          المخزون المنخفض
        </button>
      </div>

      {tab === "expiry" && (
        <div>
          <div className="filter-row">
            <label>الأيام القادمة:
              <input type="number" min="1" max="365" value={days}
                onChange={(e) => setDays(Number(e.target.value))} />
            </label>
            <button className="btn-primary" onClick={loadExpiry} disabled={loading}>بحث</button>
          </div>
          {loading ? <p>جاري التحميل…</p> : rows.length === 0 ? (
            <p className="empty-msg">لا توجد منتجات منتهية أو قاربت على الانتهاء في هذه الفترة</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>المنتج</th><th>الباركود</th><th>الوحدة</th>
                  <th>الكمية</th><th>تاريخ الصلاحية</th><th>الأيام المتبقية</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.days_until_expiry < 0 ? "expired" : r.days_until_expiry <= 7 ? "expiring-soon" : ""}>
                    <td>{r.name}</td>
                    <td>{r.barcode}</td>
                    <td>{r.unit || "—"}</td>
                    <td>{r.stock}</td>
                    <td>{r.expiry_date}</td>
                    <td>{r.days_until_expiry < 0 ? `منتهي (${r.days_until_expiry})` : r.days_until_expiry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "lowstock" && (
        <div>
          <div className="filter-row">
            <label>حد المخزون المنخفض:
              <input type="number" min="0" value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))} />
            </label>
            <button className="btn-primary" onClick={loadLowStock} disabled={loading}>بحث</button>
          </div>
          {loading ? <p>جاري التحميل…</p> : lowStock.length === 0 ? (
            <p className="empty-msg">لا توجد منتجات بمخزون منخفض</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>المنتج</th><th>الباركود</th><th>الفئة</th><th>الوحدة</th><th>الكمية</th></tr>
              </thead>
              <tbody>
                {lowStock.map((r) => (
                  <tr key={r.id} className={r.stock === 0 ? "out-of-stock" : ""}>
                    <td>{r.name}</td>
                    <td>{r.barcode}</td>
                    <td>{r.category || "—"}</td>
                    <td>{r.unit || "—"}</td>
                    <td>{r.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
