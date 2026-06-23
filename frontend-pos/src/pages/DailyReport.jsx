import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { Link, useNavigate } from "react-router-dom";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { isAdminRole, canViewReports } from "../utils/roles";
import {
  buildDashboardAlerts,
  buildDemoChartSeries,
} from "../utils/dashboardHelpers";
import ShiftStatusCard, { ShiftStatusEmpty } from "../components/ShiftStatusCard";
import TodaysSummary from "../components/TodaysSummary";
import CashAlerts from "../components/CashAlerts";
import DashboardChart from "../components/DashboardChart";
import "./DailyReport.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_WIDGET_LIMIT = 12;

export default function DailyReport() {
  const navigate = useNavigate();
  const reportUser = getUser();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);

  const [today, setToday] = useState(null);
  const [topProducts, setTopProducts] = useState([]);
  const [chartSeries, setChartSeries] = useState([]);
  const [chartIsDemo, setChartIsDemo] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [shiftDetailsById, setShiftDetailsById] = useState({});
  const [lastClosedShift, setLastClosedShift] = useState(null);
  const [recon, setRecon] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [lowStockTotal, setLowStockTotal] = useState(0);
  const [lowStockOutOfStock, setLowStockOutOfStock] = useState(0);

  function logout() {
    removeToken();
    navigate("/login", { replace: true });
  }

  const loadDashboard = useCallback(async (opts = { initial: true }) => {
    const initial = opts.initial !== false;
    if (initial) {
      setLoading(true);
      setErr(null);
    } else {
      setRefreshing(true);
    }

    const headers = getAuthHeaders();
    const todayStr = new Date().toISOString().slice(0, 10);

    try {
      const reconPromise = api
        .get(`/api/finance/cash/reconciliation?date=${todayStr}`, { headers })
        .then((r) => r.data)
        .catch((e) => {
          if (e.response?.status === 404) return null;
          return null;
        });

      const [
        todayRes,
        chartRes,
        productsRes,
        openShiftsRes,
        closedShiftsRes,
        lowStockRes,
        reconData,
      ] = await Promise.all([
        api.get("/api/reports/today", { headers }),
        api.get("/api/reports/last-7-days", { headers }),
        api.get(`/api/reports/top-products?date=${todayStr}`, { headers }),
        api.get("/api/shifts?status=open", { headers }),
        api.get(`/api/shifts?status=closed&date_to=${todayStr}`, { headers }),
        api.get(
          `/api/reports/low-stock?threshold=${LOW_STOCK_THRESHOLD}&limit=${LOW_STOCK_WIDGET_LIMIT}`,
          { headers }
        ),
        reconPromise,
      ]);

      setToday(todayRes.data);
      const { series, isDemo } = buildDemoChartSeries(chartRes.data?.days || []);
      setChartSeries(series);
      setChartIsDemo(isDemo);
      setTopProducts(productsRes.data?.products || []);

      const open = Array.isArray(openShiftsRes.data) ? openShiftsRes.data : [];
      setOpenShifts(open);

      const details = {};
      await Promise.all(
        open.map(async (s) => {
          try {
            const d = await api.get(`/api/shifts/${s.id}`, { headers });
            details[s.id] = d.data;
          } catch {
            details[s.id] = null;
          }
        })
      );
      setShiftDetailsById(details);

      const closed = Array.isArray(closedShiftsRes.data) ? closedShiftsRes.data : [];
      setLastClosedShift(closed[0] || null);

      const lowStockPayload = lowStockRes.data;
      const lowStockProducts = Array.isArray(lowStockPayload?.products)
        ? lowStockPayload.products
        : Array.isArray(lowStockPayload)
          ? lowStockPayload
          : [];
      const apiTotal = Number(lowStockPayload?.total_count);
      const hasApiTotal =
        lowStockPayload &&
        typeof lowStockPayload === "object" &&
        "total_count" in lowStockPayload &&
        Number.isFinite(apiTotal);

      setLowStock(lowStockProducts);
      setLowStockTotal(hasApiTotal ? apiTotal : lowStockProducts.length);
      setLowStockOutOfStock(Number(lowStockPayload?.out_of_stock_count) || 0);
      setRecon(reconData);
      setLastUpdated(new Date());
      setErr(null);
    } catch (e) {
      if (initial) {
        setErr(e.response?.data?.error || e.message || "تعذّر التحميل");
      }
    } finally {
      if (initial) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard({ initial: true });
  }, [loadDashboard]);

  useEffect(() => {
    const t = setInterval(() => loadDashboard({ initial: false }), 30_000);
    return () => clearInterval(t);
  }, [loadDashboard]);

  useEffect(() => {
    const i = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);

  const secondsAgo = useMemo(() => {
    if (lastUpdated == null) return null;
    return Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
  }, [lastUpdated, tick]);

  const lowStockDisplayTotal = Math.max(lowStockTotal, lowStock.length);

  const alerts = buildDashboardAlerts({
    lastClosedShift,
    reconOverShort: recon?.over_short,
    refundCount: today?.refund_count,
    openShiftsWithDuration: openShifts,
    lowStockCount: lowStockDisplayTotal,
  });

  if (loading && !today) {
    return (
      <div className="report-page dashboard-page" dir="rtl" lang="ar">
        <p>جاري التحميل…</p>
      </div>
    );
  }

  if (err && !today) {
    return (
      <div className="report-page dashboard-page" dir="rtl" lang="ar">
        <p className="report-err">{err}</p>
        <button type="button" className="report-refresh" onClick={() => loadDashboard({ initial: true })}>
          إعادة المحاولة
        </button>
      </div>
    );
  }

  const hasTodayActivity =
    today && (Number(today.transaction_count) > 0 || Number(today.revenue) > 0);

  return (
    <div className="report-page dashboard-page" dir="rtl" lang="ar">
      <div className="dashboard-top">
        <div className="report-top-nav">
          <Link to="/finance" className="report-nav-link">
            المالية ودفعات الموردين
          </Link>
        {canViewReports(reportUser?.role) ? (
          <>
            <Link to="/shift-audit" className="report-nav-link">
              تدقيق الورديات
            </Link>
            <Link to="/refunds" className="report-nav-link">
              الاسترجاعات
            </Link>
          </>
        ) : null}
          {isAdminRole(reportUser?.role) ? (
            <>
              <Link to="/checkout" className="report-nav-link">
                الكاشير
              </Link>
              <Link to="/manage-products" className="report-nav-link">
                المنتجات
              </Link>
              <Link to="/manage-users" className="report-nav-link">
                الحسابات
              </Link>
            </>
          ) : null}
          <button type="button" className="report-nav-link" onClick={logout}>
            خروج
          </button>
        </div>

        <div className="dashboard-quick-actions">
          <span className="dashboard-quick-label">إجراءات سريعة:</span>
          <Link to="/shift-audit" className="dashboard-qbtn">
            📋 كل الورديات
          </Link>
          <Link to="/finance" className="dashboard-qbtn">
            🔄 تسوية النقد
          </Link>
          <a href="#trends" className="dashboard-qbtn">
            📊 الاتجاهات
          </a>
          {isAdminRole(reportUser?.role) ? (
            <Link to="/manage-products" className="dashboard-qbtn">
              ⚙️ الإعدادات
            </Link>
          ) : null}
          <button
            type="button"
            className="dashboard-qbtn dashboard-qbtn--ghost"
            onClick={() => loadDashboard({ initial: false })}
            disabled={refreshing}
          >
            {refreshing ? "…" : "🔄 تحديث"}
          </button>
        </div>
      </div>

      {!hasTodayActivity ? (
        <div className="dashboard-demo-banner">
          💡 <strong>ترحيباً:</strong> لا توجد مبيعات اليوم بعد. البطاقات تعرض «—» حتى تبدأ العمليات. يمكنك تجربة{" "}
          <Link to="/checkout">الكاشير</Link> بعد بدء وردية.
        </div>
      ) : null}

      <section className="dashboard-section" aria-labelledby="dash-shifts-title">
        <h2 id="dash-shifts-title" className="dashboard-section-title">
          1 — حالة الورديات
        </h2>
        {openShifts.length === 0 ? (
          <ShiftStatusEmpty />
        ) : (
          <div className="shift-status-grid">
            {openShifts.map((s) => (
              <ShiftStatusCard key={s.id} listRow={s} detail={shiftDetailsById[s.id]} />
            ))}
          </div>
        )}
      </section>

      <section className="dashboard-section" aria-labelledby="dash-today-title">
        <h2 id="dash-today-title" className="dashboard-section-title">
          2 — ملخص اليوم
        </h2>
        <TodaysSummary today={today} />
      </section>

      <div className="dashboard-mid-columns">
        <section className="dashboard-section" aria-labelledby="dash-cash-title">
          <h2 id="dash-cash-title" className="dashboard-section-title">
            3 — النقد والتنبيهات
          </h2>
          <CashAlerts alerts={alerts} />

          <div className="dashboard-cash-meta">
            <h3 className="dashboard-subtitle">تسوية النقد اليوم</h3>
            {recon ? (
              <p className="dashboard-meta-line">
                متوقع: {ils(recon.expected_cash)} — المعّدل: {ils(recon.counted_cash)} — فرق:{" "}
                <span className={Math.abs(Number(recon.over_short)) >= 50 ? "dash-warn-num" : ""}>
                  {ils(recon.over_short)}
                </span>
              </p>
            ) : (
              <p className="dashboard-meta-line muted">لا توجد تسوية مسجّلة لهذا اليوم.</p>
            )}

            <h3 className="dashboard-subtitle">آخر وردية مغلقة</h3>
            {lastClosedShift ? (
              <p className="dashboard-meta-line">
                {lastClosedShift.cashier_name} — انتهت {lastClosedShift.end_time?.slice(0, 16) || "—"} — فرق:{" "}
                {lastClosedShift.variance != null ? (
                  <span
                    className={
                      Math.abs(Number(lastClosedShift.variance)) >= 50 ? "dash-warn-num" : ""
                    }
                  >
                    {ils(lastClosedShift.variance)}
                  </span>
                ) : (
                  "—"
                )}{" "}
                <Link to="/shift-audit" className="dashboard-inline-link">
                  عرض
                </Link>
              </p>
            ) : (
              <p className="dashboard-meta-line muted">لا يوجد سجل ورديات مغلقة بعد.</p>
            )}
          </div>
        </section>

        <section className="dashboard-section dashboard-section--stock" aria-labelledby="dash-stock-title">
          <h2 id="dash-stock-title" className="dashboard-section-title dashboard-section-title--with-badge">
            مخزون منخفض
            {lowStockDisplayTotal > 0 ? (
              <span className="dashboard-stock-badge" aria-label={`${lowStockDisplayTotal} منتج`}>
                {lowStockDisplayTotal}
              </span>
            ) : null}
          </h2>
          {lowStock.length === 0 ? (
            <p className="dashboard-meta-line muted">
              لا منتجات تحت عتبة المخزون (≤{LOW_STOCK_THRESHOLD}).
            </p>
          ) : (
            <>
              <div className="dashboard-stock-list-header">
                <span>
                  يعرض {lowStock.length} من {lowStockDisplayTotal} منتج
                </span>
                {lowStockOutOfStock > 0 ? (
                  <span className="dashboard-stock-badge dashboard-stock-badge--danger">
                    نافد: {lowStockOutOfStock}
                  </span>
                ) : null}
              </div>
              <div className="dashboard-stock-list-wrap">
                <ul className="dashboard-stock-list">
                  {lowStock.map((p) => (
                    <li key={p.id} title={p.name}>
                      <span>{p.name}</span>
                      <span
                        className={`dashboard-stock-qty${
                          Number(p.stock) <= 0 ? " dashboard-stock-qty--zero" : ""
                        }`}
                      >
                        {p.stock}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {lowStockTotal > lowStock.length ? (
                <p className="dashboard-stock-more">
                  + {lowStockTotal - lowStock.length} منتجات أخرى غير معروضة هنا
                </p>
              ) : null}
            </>
          )}
          <div className="dashboard-stock-footer">
            {isAdminRole(reportUser?.role) ? (
              <Link to="/manage-products" className="dashboard-inline-link">
                {lowStockTotal > 0 ? `عرض الكل (${lowStockTotal})` : "إدارة المنتجات"}
              </Link>
            ) : null}
          </div>
        </section>
      </div>

      <section className="dashboard-section" id="trends" aria-labelledby="dash-trends-title">
        <h2 id="dash-trends-title" className="dashboard-section-title">
          4 — الاتجاهات وأفضل المنتجات
        </h2>
        <DashboardChart data={chartSeries} isDemo={chartIsDemo} />

        <h3 className="dashboard-subtitle">أفضل المنتجات (اليوم)</h3>
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>المنتج</th>
                <th>الكمية</th>
                <th>الإيراد</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.length === 0 ? (
                <tr>
                  <td colSpan={3} className="dashboard-table-empty">
                    لا مبيعات مسجّلة اليوم — الجدول يمتلئ تلقائياً.
                  </td>
                </tr>
              ) : (
                topProducts.map((p, idx) => (
                  <tr key={`${p.product_name}-${idx}`}>
                    <td>{p.product_name}</td>
                    <td>{p.quantity}</td>
                    <td>{ils(p.revenue)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="dashboard-footer">
        {secondsAgo != null ? (
          <span>
            آخر تحديث: منذ {secondsAgo} ثانية
            {refreshing ? " (جاري التحديث…)" : ""}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
