import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { todayISO } from "../utils/format";
import api from "../apiClient";
import { Link } from "react-router-dom";
import { getAuthHeaders } from "../utils/auth";
import {
  buildDashboardAlerts,
  buildDemoChartSeries,
} from "../utils/dashboardHelpers";
import ShiftStatusCard, { ShiftStatusEmpty } from "../components/ShiftStatusCard";
import TodaysSummary from "../components/TodaysSummary";
import CashAlerts from "../components/CashAlerts";
import DashboardChart from "../components/DashboardChart";
import {
  PageHeader,
  PrimaryButton,
  StatCard,
  Card,
  CardBody,
  EmptyState,
  Skeleton,
  ReportToolbar,
} from "../components/ui";
import { qty } from "../utils/format";

const TOP_PRODUCT_COLUMNS = [
  { key: "product_name", header: "المنتج" },
  { key: "quantity", header: "الكمية", value: (p) => qty(p.quantity) },
  { key: "revenue", header: "الإيراد", value: (p) => ils(p.revenue) },
];

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_WIDGET_LIMIT = 12;
const NEAR_EXPIRY_WIDGET_LIMIT = 12;

function formatDaysUntilExpiry(days) {
  const d = Number(days);
  if (!Number.isFinite(d)) return "—";
  if (d < 0) return `منتهي (${Math.abs(d)})`;
  if (d === 0) return "ينتهي اليوم";
  return String(d);
}

export default function DailyReport() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);

  const [today, setToday] = useState(null);
  const [topProducts, setTopProducts] = useState([]);
  const [chartPeriod, setChartPeriod] = useState("week");
  const chartPeriodRef = useRef(chartPeriod);
  chartPeriodRef.current = chartPeriod;
  const [chartSeries, setChartSeries] = useState([]);
  const [chartIsDemo, setChartIsDemo] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [shiftDetailsById, setShiftDetailsById] = useState({});
  const [lastClosedShift, setLastClosedShift] = useState(null);
  const [recon, setRecon] = useState(null);
  const [lowStockTotal, setLowStockTotal] = useState(0);
  const [nearExpiryItems, setNearExpiryItems] = useState([]);
  const [nearExpiryTotal, setNearExpiryTotal] = useState(0);
  const [nearExpiryDays, setNearExpiryDays] = useState(7);

  const fetchChart = useCallback(async (period) => {
    const headers = getAuthHeaders();
    const url =
      period === "month" ? "/api/reports/last-30-days" : "/api/reports/last-7-days";
    const pointCount = period === "month" ? 30 : 7;
    const { data } = await api.get(url, { headers });
    const { series, isDemo } = buildDemoChartSeries(data?.days || [], { pointCount });
    setChartSeries(series);
    setChartIsDemo(isDemo);
  }, []);

  const loadDashboard = useCallback(
    async (opts = { initial: true }) => {
      const initial = opts.initial !== false;
      if (initial) {
        setLoading(true);
        setErr(null);
      } else {
        setRefreshing(true);
      }

      const headers = getAuthHeaders();
      const todayStr = todayISO();

      try {
        const reconPromise = api
          .get(`/api/finance/cash/reconciliation?date=${todayStr}`, { headers })
          .then((r) => r.data)
          .catch(() => null);

        const [todayRes, productsRes, openShiftsRes, closedShiftsRes, lowStockRes, nearExpiryRes, reconData] =
          await Promise.all([
            api.get("/api/reports/today", { headers }),
            api.get(`/api/reports/top-products?date=${todayStr}`, { headers }),
            api.get("/api/shifts?status=open", { headers }),
            api.get(`/api/shifts?status=closed&date_to=${todayStr}`, { headers }),
            api
              .get(
                `/api/reports/low-stock?threshold=${LOW_STOCK_THRESHOLD}&limit=${LOW_STOCK_WIDGET_LIMIT}`,
                { headers }
              )
              .catch(() => ({ data: { products: [], total_count: 0, out_of_stock_count: 0 } })),
            api
              .get(`/api/reports/near-expiry?limit=${NEAR_EXPIRY_WIDGET_LIMIT}`, { headers })
              .catch(() => ({ data: { items: [], total_count: 0, days_threshold: 7 } })),
            reconPromise,
          ]);

        await fetchChart(chartPeriod);

        setToday(todayRes.data);
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

        setLowStockTotal(hasApiTotal ? apiTotal : lowStockProducts.length);

        const nearExpiryPayload = nearExpiryRes.data;
        const nearExpiryList = Array.isArray(nearExpiryPayload?.items) ? nearExpiryPayload.items : [];
        const nearExpiryApiTotal = Number(nearExpiryPayload?.total_count);
        setNearExpiryItems(nearExpiryList);
        setNearExpiryTotal(
          Number.isFinite(nearExpiryApiTotal) ? nearExpiryApiTotal : nearExpiryList.length
        );
        setNearExpiryDays(Number(nearExpiryPayload?.days_threshold) || 7);

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
    },
    [fetchChart, chartPeriod]
  );

  async function onChartPeriodChange(period) {
    if (period === chartPeriod) return;
    setChartPeriod(period);
    setChartLoading(true);
    try {
      await fetchChart(period);
    } catch {
      /* keep previous series */
    } finally {
      setChartLoading(false);
    }
  }

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

  const lowStockDisplayTotal = lowStockTotal;

  const alerts = buildDashboardAlerts({
    lastClosedShift,
    reconOverShort: recon?.over_short,
    refundCount: today?.refund_count,
    openShiftsWithDuration: openShifts,
    lowStockCount: lowStockDisplayTotal,
    nearExpiryCount: nearExpiryTotal,
  });

  const topProductsPreview = topProducts.slice(0, 5);

  const dashboardSummary = useMemo(() => {
    if (!today) return [];
    return [
      { label: "عدد العمليات", value: String(today.transaction_count ?? 0) },
      { label: "الإيراد", value: ils(today.revenue) },
      { label: "الاسترجاعات", value: String(today.refund_count ?? 0) },
      { label: "ورديات مفتوحة", value: String(openShifts.length) },
      { label: "مخزون منخفض", value: String(lowStockDisplayTotal) },
      { label: "صلاحية قريبة", value: String(nearExpiryTotal) },
    ];
  }, [today, openShifts.length, lowStockDisplayTotal, nearExpiryTotal]);

  if (loading && !today) {
    return (
      <div className="office-page dashboard-page" dir="rtl" lang="ar">
        <Skeleton style={{ height: 32, width: 200, marginBottom: 16 }} />
        <div className="ui-stat-grid">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} style={{ height: 88 }} />
          ))}
        </div>
      </div>
    );
  }

  if (err && !today) {
    return (
      <div className="office-page dashboard-page" dir="rtl" lang="ar">
        <EmptyState title={err} hint="تحقق من الاتصال بالخادم" />
        <PrimaryButton onClick={() => loadDashboard({ initial: true })}>
          إعادة المحاولة
        </PrimaryButton>
      </div>
    );
  }

  const hasTodayActivity =
    today && (Number(today.transaction_count) > 0 || Number(today.revenue) > 0);

  return (
    <div className="office-page dashboard-page" dir="rtl" lang="ar">
      <PageHeader
        title="لوحة التحكم"
        subtitle={
          secondsAgo != null
            ? `آخر تحديث: منذ ${secondsAgo} ثانية${refreshing ? " (جاري التحديث…)" : ""}`
            : undefined
        }
        icon="dashboard"
        actions={
          <>
            <ReportToolbar
              title="لوحة التحكم"
              subtitle="ملخص اليوم"
              columns={TOP_PRODUCT_COLUMNS}
              rows={topProducts}
              filename="dashboard"
              summary={dashboardSummary}
              disabled={!today}
            />
            <PrimaryButton
              onClick={() => loadDashboard({ initial: false })}
              disabled={refreshing}
            >
              {refreshing ? "جاري التحديث…" : "تحديث"}
            </PrimaryButton>
          </>
        }
      />

      <div className="dashboard-kpi-row">
        <TodaysSummary today={today} />
        <div className="dashboard-kpi-extra ui-stat-grid" style={{ marginBottom: 0 }}>
          <StatCard label="ورديات مفتوحة" value={openShifts.length} icon="shifts" />
          <StatCard
            label={`مخزون منخفض (≤${LOW_STOCK_THRESHOLD})`}
            value={lowStockDisplayTotal}
            tone={lowStockDisplayTotal > 0 ? "orange" : "teal"}
            alert={lowStockDisplayTotal > 0}
            icon="inventory"
          />
          <StatCard
            label={`صلاحية قريبة (${nearExpiryDays} يوم)`}
            value={nearExpiryTotal}
            tone={nearExpiryTotal > 0 ? "orange" : "teal"}
            alert={nearExpiryTotal > 0}
            icon="expiry"
          />
        </div>
      </div>

      {nearExpiryTotal > 0 ? (
        <Card className="dashboard-near-expiry-panel">
          <CardBody>
            <div className="dashboard-near-expiry-header">
              <h2 className="dashboard-section-title" style={{ border: "none", padding: 0, margin: 0 }}>
                أصناف قريبة من انتهاء الصلاحية
              </h2>
              <Link to="/expiry" className="dashboard-inline-link">
                تقرير الصلاحية ({nearExpiryTotal})
              </Link>
            </div>
            <p className="dashboard-meta-line muted">
              حسب فترة التنبيه في الإعدادات: {nearExpiryDays} يوم
            </p>
            <table className="data-table dashboard-near-expiry-table">
              <thead>
                <tr>
                  <th>المنتج</th>
                  <th>الباركود</th>
                  <th>الكمية</th>
                  <th>تاريخ الصلاحية</th>
                  <th>الأيام المتبقية</th>
                </tr>
              </thead>
              <tbody>
                {nearExpiryItems.map((item) => {
                  const days = Number(item.days_until_expiry);
                  const rowClass =
                    days < 0 ? "expired" : days <= 7 ? "expiring-soon" : "";
                  const label =
                    item.kind === "batch" && item.batch_no
                      ? `${item.name} (دفعة ${item.batch_no})`
                      : item.name;
                  return (
                    <tr key={`${item.kind}-${item.id}`} className={rowClass}>
                      <td>{label}</td>
                      <td>{item.barcode || "—"}</td>
                      <td>{item.quantity}</td>
                      <td>{item.expiry_date}</td>
                      <td>{formatDaysUntilExpiry(days)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {nearExpiryTotal > nearExpiryItems.length ? (
              <p className="dashboard-top-products-more">
                + {nearExpiryTotal - nearExpiryItems.length} أصناف أخرى —{" "}
                <Link to="/expiry" className="dashboard-inline-link">
                  عرض الكل
                </Link>
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="dashboard-trend-row">
        <Card>
          <CardBody>
            <h2 className="dashboard-section-title" style={{ border: "none", padding: 0 }}>
              اتجاه الإيراد
            </h2>
            {chartLoading ? (
              <p style={{ color: "var(--office-text-muted)", textAlign: "center", padding: "3rem" }}>
                جاري تحميل الرسم…
              </p>
            ) : (
              <DashboardChart
                data={chartSeries}
                isDemo={chartIsDemo}
                period={chartPeriod}
                onPeriodChange={onChartPeriodChange}
              />
            )}
          </CardBody>
        </Card>

        <Card className="dashboard-top-products-panel">
          <CardBody>
            <h2 className="dashboard-section-title">أفضل المنتجات (اليوم)</h2>
            {topProductsPreview.length === 0 ? (
              <p className="dashboard-meta-line muted">لا مبيعات مسجّلة اليوم</p>
            ) : (
              <ul className="dashboard-top-products-list">
                {topProductsPreview.map((p, idx) => (
                  <li key={`${p.product_name}-${idx}`}>
                    <span className="dashboard-top-products-rank">{idx + 1}</span>
                    <span className="dashboard-top-products-name" title={p.product_name}>
                      {p.product_name}
                    </span>
                    <span className="dashboard-top-products-meta">
                      <span className="dashboard-top-products-qty">{p.quantity}</span>
                      <span className="dashboard-top-products-revenue">{ils(p.revenue)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {topProducts.length > topProductsPreview.length ? (
              <p className="dashboard-top-products-more">
                + {topProducts.length - topProductsPreview.length} منتجات أخرى
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {!hasTodayActivity ? (
        <div className="office-card dashboard-demo-banner">
          <strong>ترحيباً:</strong> لا توجد مبيعات اليوم بعد. ستظهر البيانات هنا بعد
          بدء وردية في نقطة البيع.
        </div>
      ) : null}

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">حالة الورديات</h2>
          {openShifts.length === 0 ? (
            <ShiftStatusEmpty />
          ) : (
            <div className="shift-status-grid">
              {openShifts.map((s) => (
                <ShiftStatusCard key={s.id} listRow={s} detail={shiftDetailsById[s.id]} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">النقد والتنبيهات</h2>
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
                {lastClosedShift.cashier_name} — انتهت{" "}
                {lastClosedShift.end_time?.slice(0, 16) || "—"} — فرق:{" "}
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
        </CardBody>
      </Card>
    </div>
  );
}
