import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import api, { createAbortController } from "../apiClient";
import { Link, useNavigate } from "react-router-dom";
import { getAuthHeaders } from "../utils/auth";
import {
  buildDashboardAlerts,
  buildDemoChartSeries,
} from "../utils/dashboardHelpers";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { dateOnly, ils } from "../utils/format";
import {
  TOP_PRODUCT_COLUMNS,
  buildDailySummaryItems,
  buildCollectionSummaryItems,
  getTopProductsFromDaily,
} from "../utils/salesReportHelpers";
import { printSalesDailyReport } from "../utils/salesReportPrint";
import { exportToCsv } from "../utils/reportExport";
import ShiftStatusCard, { ShiftStatusEmpty } from "../components/ShiftStatusCard";
import TodaysSummary from "../components/TodaysSummary";
import CashAlerts from "../components/CashAlerts";
import {
  PageHeader,
  PrimaryButton,
  StatCard,
  Card,
  CardBody,
  EmptyState,
  Skeleton,
  SecondaryButton,
} from "../components/ui";

// recharts is ~385 KB minified and only this one widget needs it, so it loads
// alongside the chart data rather than blocking the rest of the dashboard.
const DashboardChart = lazy(() => import("../components/DashboardChart"));

const chartLoadingMessage = (
  <p style={{ color: "var(--office-text-muted)", textAlign: "center", padding: "3rem" }}>
    جاري تحميل الرسم…
  </p>
);

const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_WIDGET_LIMIT = 12;
const NEAR_EXPIRY_WIDGET_LIMIT = 12;
const CHART_PERIOD_STORAGE_KEY = "dashboardChartPeriod";
const VALID_CHART_PERIODS = ["week", "rolling30", "calendarMonth"];

function readStoredChartPeriod() {
  try {
    const value = localStorage.getItem(CHART_PERIOD_STORAGE_KEY);
    if (VALID_CHART_PERIODS.includes(value)) return value;
  } catch {
    /* ignore */
  }
  return "week";
}

function mapDailyToTodaySummary(daily) {
  if (!daily) return null;
  return {
    transaction_count: daily.total_transactions,
    revenue: daily.net_sales,
    refund_count: daily.refund_count,
    refund_amount: daily.refunds_total,
    on_account_total: daily.on_account_total,
    items_sold: daily.items_sold,
    collections_by_currency: daily.collections_by_currency,
  };
}

function formatDaysUntilExpiry(days) {
  const d = Number(days);
  if (!Number.isFinite(d)) return "—";
  if (d < 0) return `منتهي (${Math.abs(d)})`;
  if (d === 0) return "ينتهي اليوم";
  return String(d);
}

function mapDailyTopProducts(daily) {
  const fromHelper = getTopProductsFromDaily(daily);
  if (fromHelper.length) {
    return fromHelper.map((p) => ({
      product_name: p.name,
      quantity: p.quantity,
      revenue: p.revenue,
    }));
  }
  return [];
}

function UpdatedAgo({ lastUpdated, refreshing }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (lastUpdated == null) return null;
  const secondsAgo = Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
  void tick;
  return `آخر تحديث: منذ ${secondsAgo} ثانية${refreshing ? " (جاري التحديث…)" : ""}`;
}

export default function DailyReport() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [today, setToday] = useState(null);
  const [dailyDetail, setDailyDetail] = useState(null);
  const [topProducts, setTopProducts] = useState([]);
  const [chartPeriod, setChartPeriod] = useState(readStoredChartPeriod);
  const chartPeriodRef = useRef(chartPeriod);
  chartPeriodRef.current = chartPeriod;
  const [chartSeries, setChartSeries] = useState([]);
  const [chartIsDemo, setChartIsDemo] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [lastClosedShift, setLastClosedShift] = useState(null);
  const [recon, setRecon] = useState(null);
  const [lowStockTotal, setLowStockTotal] = useState(0);
  const [nearExpiryItems, setNearExpiryItems] = useState([]);
  const [nearExpiryTotal, setNearExpiryTotal] = useState(0);
  const [nearExpiryDays, setNearExpiryDays] = useState(7);

  const dashboardAbortRef = useRef(null);
  const dashboardReqRef = useRef(0);

  const fetchChartData = useCallback(async (period, signal) => {
    const headers = getAuthHeaders();
    let days = [];
    let pointCount = 7;

    if (period === "rolling30") {
      const { data } = await api.get("/api/reports/last-30-days", { headers, signal });
      days = data?.days || [];
      pointCount = 30;
    } else if (period === "calendarMonth") {
      const from = firstOfCurrentMonthYmd();
      const to = todayYmd();
      const { data } = await api.get("/api/reports/daily-series", {
        headers,
        signal,
        params: { from, to },
      });
      days = data?.days || [];
      pointCount = Math.max(days.length, 1);
    } else {
      const { data } = await api.get("/api/reports/last-7-days", { headers, signal });
      days = data?.days || [];
      pointCount = 7;
    }

    return buildDemoChartSeries(days, { pointCount });
  }, []);

  const applyChart = useCallback((result) => {
    setChartSeries(result.series);
    setChartIsDemo(result.isDemo);
  }, []);

  const loadDashboard = useCallback(
    async (opts = { initial: true }) => {
      const initial = opts.initial !== false;
      dashboardAbortRef.current?.abort();
      const ac = createAbortController();
      dashboardAbortRef.current = ac;
      const signal = ac.signal;
      const reqId = ++dashboardReqRef.current;
      if (initial) {
        setLoading(true);
        setErr(null);
      } else {
        setRefreshing(true);
      }

      const headers = getAuthHeaders();
      const todayStr = todayYmd();
      // The summary now paints before the chart data arrives, so keep the chart
      // in its loading state instead of briefly drawing an empty axis.
      setChartLoading(true);

      try {
        // Every request starts now so they still travel in parallel, but the
        // first paint waits only on the daily summary instead of on the slowest
        // of eight calls. The remaining panels fill in behind it.
        const dailyPromise = api.get(`/api/reports/daily?date=${todayStr}`, { headers, signal });
        const openShiftsPromise = api
          .get("/api/shifts?status=open", { headers, signal })
          .catch(() => ({ data: [] }));
        const closedShiftsPromise = api
          .get(`/api/shifts?status=closed&date_to=${todayStr}`, { headers, signal })
          .catch(() => ({ data: [] }));
        const lowStockPromise = api
          .get(
            `/api/reports/low-stock?threshold=${LOW_STOCK_THRESHOLD}&limit=${LOW_STOCK_WIDGET_LIMIT}`,
            { headers, signal }
          )
          .catch(() => ({ data: { products: [], total_count: 0, out_of_stock_count: 0 } }));
        const nearExpiryPromise = api
          .get(`/api/reports/near-expiry?limit=${NEAR_EXPIRY_WIDGET_LIMIT}`, { headers, signal })
          .catch(() => ({ data: { items: [], total_count: 0, days_threshold: 7 } }));
        const reconPromise = api
          .get(`/api/finance/cash/reconciliation?date=${todayStr}`, { headers, signal })
          .then((r) => r.data)
          .catch(() => null);
        const chartPromise = fetchChartData(chartPeriodRef.current, signal).catch(() => ({
          series: [],
          isDemo: false,
        }));

        const dailyPayload = (await dailyPromise).data;
        if (reqId !== dashboardReqRef.current) return;
        setDailyDetail(dailyPayload);
        setToday(mapDailyToTodaySummary(dailyPayload));
        setTopProducts(mapDailyTopProducts(dailyPayload));
        setErr(null);
        if (initial) setLoading(false);

        const [openShiftsRes, closedShiftsRes, lowStockRes, nearExpiryRes, reconData, chartResult] =
          await Promise.all([
            openShiftsPromise,
            closedShiftsPromise,
            lowStockPromise,
            nearExpiryPromise,
            reconPromise,
            chartPromise,
          ]);

        if (reqId !== dashboardReqRef.current) return;
        applyChart(chartResult);
        setChartLoading(false);

        const open = Array.isArray(openShiftsRes.data) ? openShiftsRes.data : [];
        setOpenShifts(open);

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
        if (e.code === "ERR_CANCELED" || e.name === "CanceledError") return;
        if (reqId !== dashboardReqRef.current) return;
        if (initial) {
          setErr(e.response?.data?.error || e.message || "تعذّر التحميل");
        }
      } finally {
        if (initial) setLoading(false);
        setChartLoading(false);
        setRefreshing(false);
      }
    },
    [applyChart, fetchChartData]
  );

  async function onChartPeriodChange(period) {
    if (period === chartPeriod) return;
    setChartPeriod(period);
    try {
      localStorage.setItem(CHART_PERIOD_STORAGE_KEY, period);
    } catch {
      /* ignore */
    }
    setChartLoading(true);
    try {
      applyChart(await fetchChartData(period));
    } catch {
      /* keep previous series */
    } finally {
      setChartLoading(false);
    }
  }

  function onChartDayClick(date) {
    if (!date) return;
    navigate(`/sales-reports?date=${date}`);
  }

  function onPrintDailyReport() {
    if (!dailyDetail) return;
    printSalesDailyReport({
      title: "لوحة التحكم — ملخص اليوم",
      date: todayYmd(),
      summaryItems: buildDailySummaryItems(dailyDetail),
      collectionItems: buildCollectionSummaryItems(dailyDetail),
      productColumns: TOP_PRODUCT_COLUMNS,
      products: getTopProductsFromDaily(dailyDetail),
    });
  }

  function onExportTopProducts() {
    const rows = topProducts.map((p) => ({
      name: p.product_name,
      quantity: p.quantity,
      revenue: p.revenue,
    }));
    if (rows.length === 0) return;
    exportToCsv(`dashboard-top-products-${todayYmd()}`, TOP_PRODUCT_COLUMNS, rows);
  }

  useEffect(() => {
    loadDashboard({ initial: true });
    return () => dashboardAbortRef.current?.abort();
  }, [loadDashboard]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      loadDashboard({ initial: false });
    }, 30_000);
    return () => clearInterval(t);
  }, [loadDashboard]);

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
        subtitle={<UpdatedAgo lastUpdated={lastUpdated} refreshing={refreshing} />}
        icon="dashboard"
        actions={
          <>
            <SecondaryButton type="button" onClick={onPrintDailyReport} disabled={!dailyDetail}>
              طباعة
            </SecondaryButton>
            <SecondaryButton type="button" onClick={onExportTopProducts} disabled={topProducts.length === 0}>
              تصدير CSV
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => navigate(`/sales-reports?date=${todayYmd()}`)}>
              عرض تقرير اليوم
            </SecondaryButton>
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
                      <td>{dateOnly(item.expiry_date)}</td>
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
              chartLoadingMessage
            ) : (
              <Suspense fallback={chartLoadingMessage}>
                <DashboardChart
                  data={chartSeries}
                  isDemo={chartIsDemo}
                  period={chartPeriod}
                  onPeriodChange={onChartPeriodChange}
                  onDayClick={onChartDayClick}
                />
              </Suspense>
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
                <ShiftStatusCard key={s.id} listRow={s} />
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
