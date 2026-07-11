import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { getDatePresets, todayYmd, firstOfCurrentMonthYmd } from "../utils/reportDates";
import {
  TOP_PRODUCT_COLUMNS,
  RANGE_BY_DAY_COLUMNS,
  buildDailySummaryItems,
  buildCollectionSummaryItems,
  buildRangeSummaryItems,
  getTopProductsFromDaily,
} from "../utils/salesReportHelpers";
import { printSalesDailyReport, printSalesRangeReport } from "../utils/salesReportPrint";
import { exportToCsv } from "../utils/reportExport";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  FormField,
  FormGrid,
  Input,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  Tabs,
  EmptyState,
  Skeleton,
  useToast,
} from "../components/ui";

const MODE_TABS = [
  { id: "day", label: "يوم واحد" },
  { id: "range", label: "فترة" },
];

function parseYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

function mapColumnsForTable(columns) {
  return columns.map((c) => ({
    ...c,
    render: (row) => (typeof c.value === "function" ? c.value(row) : row[c.key]),
  }));
}

export default function SalesReports() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialDate = parseYmd(searchParams.get("date")) || todayYmd();
  const initialFrom = parseYmd(searchParams.get("from")) || "";
  const initialTo = parseYmd(searchParams.get("to")) || "";
  const initialMode =
    initialFrom && initialTo ? "range" : searchParams.get("mode") === "range" ? "range" : "day";

  const [mode, setMode] = useState(initialMode);
  const [date, setDate] = useState(initialDate);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);

  const [dailyReport, setDailyReport] = useState(null);
  const [rangeReport, setRangeReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const presets = useMemo(() => getDatePresets(), []);

  const loadDaily = useCallback(async () => {
    if (!date) return;
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/api/reports/daily", {
        params: { date },
        headers: getAuthHeaders(),
      });
      setDailyReport(data);
      setRangeReport(null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر تحميل التقرير");
      setDailyReport(null);
    } finally {
      setLoading(false);
    }
  }, [date]);

  const loadRange = useCallback(async () => {
    if (!from || !to) {
      setErr("حدد تاريخ البداية والنهاية");
      setLoading(false);
      return;
    }
    if (from > to) {
      setErr("تاريخ البداية يجب أن يسبق النهاية");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/api/reports/range", {
        params: { from, to },
        headers: getAuthHeaders(),
      });
      setRangeReport(data);
      setDailyReport(null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر تحميل التقرير");
      setRangeReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (mode === "day") loadDaily();
    else loadRange();
  }, [mode, loadDaily, loadRange]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (mode === "day") {
      params.set("date", date);
    } else {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("mode", "range");
    }
    setSearchParams(params, { replace: true });
  }, [mode, date, from, to, setSearchParams]);

  function onModeChange(nextMode) {
    setMode(nextMode);
    if (nextMode === "range" && !from && !to) {
      setFrom(firstOfCurrentMonthYmd());
      setTo(todayYmd());
    }
  }

  function applyPreset(preset) {
    if (preset.mode === "day") {
      setMode("day");
      setDate(preset.date || todayYmd());
    } else {
      setMode("range");
      setFrom(preset.from || "");
      setTo(preset.to || todayYmd());
    }
  }

  const topProducts = useMemo(() => getTopProductsFromDaily(dailyReport), [dailyReport]);

  const dailyStatCards = useMemo(() => {
    if (!dailyReport) return [];
    return [
      { label: "صافي المبيعات", value: ils(dailyReport.net_sales), tone: "green" },
      { label: "عدد العمليات", value: String(dailyReport.total_transactions ?? 0) },
      { label: "الاسترجاعات", value: ils(dailyReport.refunds_total), tone: "orange" },
      { label: "القطع المباعة", value: String(dailyReport.items_sold ?? 0) },
    ];
  }, [dailyReport]);

  const rangeStatCards = useMemo(() => {
    if (!rangeReport) return [];
    return [
      { label: "صافي المبيعات", value: ils(rangeReport.net_sales), tone: "green" },
      { label: "عدد العمليات", value: String(rangeReport.total_transactions ?? 0) },
      { label: "الاسترجاعات", value: ils(rangeReport.refunds_total), tone: "orange" },
      { label: "القطع المباعة", value: String(rangeReport.items_sold ?? 0) },
    ];
  }, [rangeReport]);

  function onPrint() {
    if (mode === "day" && dailyReport) {
      printSalesDailyReport({
        date,
        summaryItems: buildDailySummaryItems(dailyReport),
        collectionItems: buildCollectionSummaryItems(dailyReport),
        productColumns: TOP_PRODUCT_COLUMNS,
        products: topProducts,
      });
      return;
    }
    if (mode === "range" && rangeReport) {
      printSalesRangeReport({
        from,
        to,
        summaryItems: buildRangeSummaryItems(rangeReport),
        dayColumns: RANGE_BY_DAY_COLUMNS,
        byDay: rangeReport.by_day || [],
      });
    }
  }

  function onExportCsv() {
    if (mode === "day" && topProducts.length > 0) {
      exportToCsv(`sales-daily-${date}`, TOP_PRODUCT_COLUMNS, topProducts);
      return;
    }
    if (mode === "range" && rangeReport?.by_day?.length) {
      exportToCsv(`sales-range-${from}-${to}`, RANGE_BY_DAY_COLUMNS, rangeReport.by_day);
      return;
    }
    toast.info("لا توجد بيانات للتصدير");
  }

  const canPrint =
    (mode === "day" && dailyReport) || (mode === "range" && rangeReport?.by_day?.length);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تقارير المبيعات"
        subtitle="تقرير يومي أو لفترة — للطباعة والأرشفة"
        icon="finance"
        actions={
          <>
            <SecondaryButton type="button" onClick={onPrint} disabled={!canPrint}>
              طباعة
            </SecondaryButton>
            <SecondaryButton type="button" onClick={onExportCsv} disabled={!canPrint}>
              تصدير CSV
            </SecondaryButton>
            <PrimaryButton
              type="button"
              onClick={() => (mode === "day" ? loadDaily() : loadRange())}
              disabled={loading}
            >
              {loading ? "جاري التحميل…" : "تحديث"}
            </PrimaryButton>
          </>
        }
      />

      <Tabs tabs={MODE_TABS} active={mode} onChange={onModeChange} />

      <Card className="ui-mt-md">
        <CardBody>
          <FormGrid columns={mode === "day" ? 1 : 2}>
            {mode === "day" ? (
              <FormField label="تاريخ التقرير">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </FormField>
            ) : (
              <>
                <FormField label="من">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </FormField>
                <FormField label="إلى">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </FormField>
              </>
            )}
          </FormGrid>

          <div className="sales-report-presets" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {presets.map((p) => (
              <SecondaryButton key={p.id} type="button" onClick={() => applyPreset(p)}>
                {p.label}
              </SecondaryButton>
            ))}
          </div>
        </CardBody>
      </Card>

      {err ? (
        <EmptyState title={err} className="ui-mt-md" />
      ) : loading ? (
        <div className="ui-mt-md">
          <Skeleton style={{ height: 120, marginBottom: 16 }} />
          <Skeleton style={{ height: 240 }} />
        </div>
      ) : mode === "day" && dailyReport ? (
        <>
          <div className="ui-stat-grid ui-mt-md">
            {dailyStatCards.map((c) => (
              <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} icon="finance" />
            ))}
          </div>

          <Card className="ui-mt-md">
            <CardBody>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <h2 className="dashboard-section-title" style={{ margin: 0, border: "none", padding: 0 }}>
                  تفاصيل الدفع والتحصيل
                </h2>
                <Link to={`/shift-audit?date_from=${date}&date_to=${date}`} className="dashboard-inline-link">
                  عرض الورديات لهذا اليوم
                </Link>
              </div>
              <div className="ui-stat-grid ui-mt-sm">
                <StatCard label="نقد (إجمالي)" value={ils(dailyReport.cash_total)} icon="finance" />
                <StatCard label="بطاقة (إجمالي)" value={ils(dailyReport.card_total)} icon="finance" />
                <StatCard label="مبيعات الذمة" value={ils(dailyReport.on_account_total)} icon="vouchers" />
                <StatCard label="صافي النقد" value={ils(dailyReport.net_cash_total)} icon="finance" />
                <StatCard label="صافي البطاقة" value={ils(dailyReport.net_card_total)} icon="finance" />
                <StatCard label="الباقي المُرجَع" value={ils(dailyReport.change_total)} icon="finance" />
              </div>
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardBody>
              <h2 className="dashboard-section-title" style={{ margin: 0, border: "none", padding: 0 }}>
                أفضل المنتجات
              </h2>
              {topProducts.length === 0 ? (
                <p className="dashboard-meta-line muted ui-mt-sm">لا مبيعات في هذا اليوم</p>
              ) : (
                <DataTable columns={mapColumnsForTable(TOP_PRODUCT_COLUMNS)} rows={topProducts} />
              )}
            </CardBody>
          </Card>
        </>
      ) : mode === "range" && rangeReport ? (
        <>
          <div className="ui-stat-grid ui-mt-md">
            {rangeStatCards.map((c) => (
              <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} icon="finance" />
            ))}
          </div>

          <Card className="ui-mt-md">
            <CardBody>
              <h2 className="dashboard-section-title" style={{ margin: 0, border: "none", padding: 0 }}>
                التفصيل اليومي
              </h2>
              {(rangeReport.by_day || []).length === 0 ? (
                <p className="dashboard-meta-line muted ui-mt-sm">لا مبيعات في هذه الفترة</p>
              ) : (
                <DataTable
                  columns={[
                    ...mapColumnsForTable(RANGE_BY_DAY_COLUMNS),
                    {
                      key: "actions",
                      header: "",
                      render: (row) => (
                        <Link to={`/sales-reports?date=${row.date}`} className="dashboard-inline-link">
                          تفاصيل
                        </Link>
                      ),
                    },
                  ]}
                  rows={rangeReport.by_day}
                />
              )}
            </CardBody>
          </Card>
        </>
      ) : (
        <EmptyState title="لا توجد بيانات" className="ui-mt-md" />
      )}
    </div>
  );
}
