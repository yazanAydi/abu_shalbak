import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, ilsKnown, INCOMPLETE_PROFIT_AR } from "../utils/format";
import { getDatePresets, todayYmd, firstOfCurrentMonthYmd } from "../utils/reportDates";
import {
  TOP_PRODUCT_COLUMNS,
  RANGE_BY_DAY_COLUMNS,
  buildDailySummaryItems,
  buildCollectionSummaryItems,
  buildRangeSummaryItems,
  getTopProductsFromDaily,
  incompleteProfitNote,
} from "../utils/salesReportHelpers";
import { printSalesDailyReport, printSalesRangeReport } from "../utils/salesReportPrint";
import { exportToCsv } from "../utils/reportExport";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  FilterBar,
  FormField,
  DateField,
  SecondaryButton,
  StatCard,
  Tabs,
  EmptyState,
  Skeleton,
  Notice,
  useToast,
} from "../components/ui";
import { useRegisterPageRefresh } from "../components/layout/PageRefreshContext";

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
      setErr(apiErrorMessage(e, "تعذّر تحميل التقرير"));
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
      setErr(apiErrorMessage(e, "تعذّر تحميل التقرير"));
      setRangeReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (mode === "day") loadDaily();
    else loadRange();
  }, [mode, loadDaily, loadRange]);

  const refreshReport = useCallback(
    () => (mode === "day" ? loadDaily() : loadRange()),
    [mode, loadDaily, loadRange]
  );
  useRegisterPageRefresh(refreshReport);

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
      { label: "إجمالي المبيعات", value: ils(dailyReport.total_sales) },
      { label: "إيراد الأصناف", value: ils(dailyReport.item_revenue) },
      { label: "تقريب الفواتير", value: ils(dailyReport.rounding_adjustment) },
      { label: "عدد العمليات", value: String(dailyReport.total_transactions ?? 0) },
      { label: "الاسترجاعات", value: ils(dailyReport.refunds_total), tone: "orange" },
      { label: "القطع المباعة", value: String(dailyReport.items_sold ?? 0) },
      { label: "تكلفة المبيعات", value: ilsKnown(dailyReport.cost, dailyReport.cost_unknown) },
      {
        label: "الربح",
        value: ilsKnown(dailyReport.profit, dailyReport.cost_unknown),
        tone: dailyReport.cost_unknown ? "orange" : "teal",
      },
    ];
  }, [dailyReport]);

  const rangeStatCards = useMemo(() => {
    if (!rangeReport) return [];
    return [
      { label: "صافي المبيعات", value: ils(rangeReport.net_sales), tone: "green" },
      { label: "إجمالي المبيعات", value: ils(rangeReport.total_sales) },
      { label: "إيراد الأصناف", value: ils(rangeReport.item_revenue) },
      { label: "تقريب الفواتير", value: ils(rangeReport.rounding_adjustment) },
      { label: "عدد العمليات", value: String(rangeReport.total_transactions ?? 0) },
      { label: "الاسترجاعات", value: ils(rangeReport.refunds_total), tone: "orange" },
      { label: "القطع المباعة", value: String(rangeReport.items_sold ?? 0) },
      { label: "تكلفة المبيعات", value: ilsKnown(rangeReport.cost, rangeReport.cost_unknown) },
      {
        label: "الربح",
        value: ilsKnown(rangeReport.profit, rangeReport.cost_unknown),
        tone: rangeReport.cost_unknown ? "orange" : "teal",
      },
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
          </>
        }
      />

      <Tabs tabs={MODE_TABS} active={mode} onChange={onModeChange} />

      <FilterBar
        className="ui-mt-md"
        actions={
          <>
            {presets.map((p) => (
              <SecondaryButton key={p.id} type="button" onClick={() => applyPreset(p)}>
                {p.label}
              </SecondaryButton>
            ))}
          </>
        }
      >
        {mode === "day" ? (
          <FormField label="تاريخ التقرير" className="ui-field--date">
            <DateField value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        ) : (
          <>
            <FormField label="من" className="ui-field--date">
              <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
            <FormField label="إلى" className="ui-field--date">
              <DateField value={to} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </>
        )}
      </FilterBar>

      {err ? (
        <EmptyState title={err} className="ui-mt-md" />
      ) : loading ? (
        <div className="ui-mt-md">
          <Skeleton style={{ height: 120, marginBottom: 16 }} />
          <Skeleton style={{ height: 240 }} />
        </div>
      ) : mode === "day" && dailyReport ? (
        <>
          {incompleteProfitNote(dailyReport) ? (
            <Notice tone="warn" className="ui-mt-md">{INCOMPLETE_PROFIT_AR}</Notice>
          ) : null}
          <div className="ui-stat-grid ui-mt-md">
            {dailyStatCards.map((c) => (
              <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} icon="finance" />
            ))}
          </div>

          <Card className="ui-mt-md">
            <CardHeader
              title="تفاصيل الدفع والتحصيل"
              actions={
                <Link to={`/shift-audit?date_from=${date}&date_to=${date}`} className="dashboard-inline-link">
                  عرض الورديات لهذا اليوم
                </Link>
              }
            />
            <CardBody>
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
            <CardHeader title="أفضل المنتجات" />
            <CardBody>
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
          {incompleteProfitNote(rangeReport) ? (
            <Notice tone="warn" className="ui-mt-md">{INCOMPLETE_PROFIT_AR}</Notice>
          ) : null}
          <div className="ui-stat-grid ui-mt-md">
            {rangeStatCards.map((c) => (
              <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} icon="finance" />
            ))}
          </div>

          <Card className="ui-mt-md">
            <CardHeader title="التفصيل اليومي" />
            <CardBody>
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
