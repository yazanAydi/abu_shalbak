import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";

export default function ExpiryReports() {
  const [rows, setRows] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [days, setDays] = useState(30);
  const [threshold, setThreshold] = useState(10);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("expiry");
  const [error, setError] = useState(null);

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

  return (
    <div className="page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>تقارير المخزون</h1>
        <div className="header-actions">
          <Link to="/inventory" className="nav-pill">جلسات الجرد</Link>
          <Link to="/checkout" className="nav-pill">← الكاشير</Link>
        </div>
      </div>

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
