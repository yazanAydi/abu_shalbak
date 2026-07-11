import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { getDatePresets, firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { exportToCsv } from "../utils/reportExport";
import {
  formatDateTimeAr,
  formatHoursAr,
  formatShiftStatus,
} from "../utils/payrollHelpers";
import "./CashierPayroll.css";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  FormField,
  FormGrid,
  Input,
  Select,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  Tabs,
  EmptyState,
  Skeleton,
  StatusBadge,
  useToast,
} from "../components/ui";

const PAGE_TABS = [
  { id: "rates", label: "أجور الساعة" },
  { id: "report", label: "تقرير الرواتب" },
];

const REPORT_SUMMARY_COLUMNS = [
  { key: "username", header: "الكاشير", value: (r) => r.username },
  {
    key: "hourly_rate",
    header: "أجر الساعة",
    value: (r) => (r.hourly_rate > 0 ? ils(r.hourly_rate) : "—"),
  },
  {
    key: "total_hours",
    header: "إجمالي الساعات",
    value: (r) => formatHoursAr(r.total_hours),
  },
  {
    key: "total_pay",
    header: "الراتب",
    value: (r) => ils(r.total_pay),
  },
];

const REPORT_SHIFT_COLUMNS = [
  { key: "username", header: "الكاشير", value: (r) => r.username },
  { key: "shift_id", header: "الوردية", value: (r) => r.shift_id },
  {
    key: "start_time",
    header: "بداية الوردية",
    value: (r) => formatDateTimeAr(r.start_time),
  },
  {
    key: "end_time",
    header: "نهاية الوردية",
    value: (r) => formatDateTimeAr(r.end_time),
  },
  {
    key: "hours",
    header: "الساعات",
    value: (r) => formatHoursAr(r.hours),
  },
  {
    key: "pay",
    header: "المبلغ",
    value: (r) => ils(r.pay),
  },
  {
    key: "status",
    header: "الحالة",
    value: (r) => formatShiftStatus(r.status),
  },
];

export default function CashierPayroll() {
  const toast = useToast();
  const [tab, setTab] = useState("rates");

  const [cashiers, setCashiers] = useState([]);
  const [ratesLoading, setRatesLoading] = useState(true);
  const [ratesErr, setRatesErr] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editRate, setEditRate] = useState("");
  const [savingRate, setSavingRate] = useState(false);

  const [from, setFrom] = useState(firstOfCurrentMonthYmd());
  const [to, setTo] = useState(todayYmd());
  const [cashierFilter, setCashierFilter] = useState("");
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportErr, setReportErr] = useState("");
  const [expandedCashier, setExpandedCashier] = useState(null);

  const presets = useMemo(() => getDatePresets(), []);

  const loadCashiers = useCallback(async () => {
    setRatesLoading(true);
    setRatesErr("");
    try {
      const { data } = await api.get("/api/payroll/cashiers", { headers: getAuthHeaders() });
      setCashiers(Array.isArray(data) ? data : []);
    } catch (e) {
      setRatesErr(e.response?.data?.error || e.message || "فشل تحميل الكاشير");
    } finally {
      setRatesLoading(false);
    }
  }, []);

  const loadReport = useCallback(async () => {
    if (!from || !to) {
      setReportErr("حدد تاريخ البداية والنهاية");
      return;
    }
    setReportLoading(true);
    setReportErr("");
    try {
      const params = { date_from: from, date_to: to };
      if (cashierFilter) params.cashier_id = cashierFilter;
      const { data } = await api.get("/api/payroll/report", {
        params,
        headers: getAuthHeaders(),
      });
      setReport(data);
      setExpandedCashier(null);
    } catch (e) {
      setReport(null);
      setReportErr(e.response?.data?.error || e.message || "فشل تحميل التقرير");
    } finally {
      setReportLoading(false);
    }
  }, [from, to, cashierFilter]);

  useEffect(() => {
    loadCashiers();
  }, [loadCashiers]);

  useEffect(() => {
    if (tab === "report") loadReport();
  }, [tab, loadReport]);

  function startEditRate(c) {
    setEditingId(c.id);
    setEditRate(c.hourly_rate != null && c.hourly_rate > 0 ? String(c.hourly_rate) : "");
  }

  function cancelEditRate() {
    setEditingId(null);
    setEditRate("");
  }

  async function saveRate(id) {
    const rate = Number(editRate);
    if (!Number.isFinite(rate) || rate < 0) {
      toast.error("أجر الساعة يجب أن يكون رقماً موجباً أو صفراً");
      return;
    }
    setSavingRate(true);
    try {
      await api.patch(
        `/api/payroll/cashiers/${id}`,
        { hourly_rate: rate },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تم حفظ أجر الساعة");
      cancelEditRate();
      loadCashiers();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setSavingRate(false);
    }
  }

  function applyPreset(p) {
    if (p.mode === "day" && p.date) {
      setFrom(p.date);
      setTo(p.date);
    } else if (p.from && p.to) {
      setFrom(p.from);
      setTo(p.to);
    }
  }

  const flatShiftRows = useMemo(() => {
    if (!report?.employees?.length) return [];
    const rows = [];
    for (const emp of report.employees) {
      for (const shift of emp.shifts || []) {
        rows.push({
          ...shift,
          username: emp.username,
          hourly_rate: emp.hourly_rate,
        });
      }
    }
    return rows;
  }, [report]);

  function onExportCsv() {
    if (!flatShiftRows.length) {
      toast.info("لا توجد بيانات للتصدير");
      return;
    }
    exportToCsv(`cashier-payroll-${from}-${to}`, REPORT_SHIFT_COLUMNS, flatShiftRows);
  }

  const rateColumns = [
    {
      key: "username",
      header: "الكاشير",
      value: (c) => c.username,
    },
    {
      key: "hourly_rate",
      header: "أجر الساعة (₪/ساعة)",
      render: (c) =>
        editingId === c.id ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={editRate}
            onChange={(e) => setEditRate(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 140 }}
          />
        ) : (
          <span className="num">
            {c.hourly_rate != null && c.hourly_rate > 0 ? ils(c.hourly_rate) : "—"}
          </span>
        ),
    },
    {
      key: "actions",
      header: "إجراءات",
      render: (c) =>
        editingId === c.id ? (
          <div className="ui-table__actions" onClick={(e) => e.stopPropagation()}>
            <PrimaryButton size="sm" type="button" onClick={() => saveRate(c.id)} disabled={savingRate}>
              حفظ
            </PrimaryButton>
            <SecondaryButton size="sm" type="button" onClick={cancelEditRate}>
              إلغاء
            </SecondaryButton>
          </div>
        ) : (
          <SecondaryButton size="sm" type="button" onClick={() => startEditRate(c)}>
            تعديل
          </SecondaryButton>
        ),
    },
  ];

  const summaryTableColumns = REPORT_SUMMARY_COLUMNS.map((c) => ({
    ...c,
    render: (row) => {
      if (c.key === "hourly_rate" && row.missing_rate) {
        return (
          <StatusBadge tone="amber" title="لم يُحدَّد أجر الساعة">
            —
          </StatusBadge>
        );
      }
      return typeof c.value === "function" ? c.value(row) : row[c.key];
    },
  }));

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="رواتب الكاشير"
        subtitle="ساعات العمل من الورديات وأجور الساعة لكل كاشير"
        icon="shifts"
        actions={
          tab === "report" ? (
            <>
              <SecondaryButton type="button" onClick={onExportCsv} disabled={!flatShiftRows.length}>
                تصدير CSV
              </SecondaryButton>
              <PrimaryButton type="button" onClick={loadReport} disabled={reportLoading}>
                {reportLoading ? "جاري التحميل…" : "تحديث"}
              </PrimaryButton>
            </>
          ) : (
            <SecondaryButton type="button" onClick={loadCashiers} disabled={ratesLoading}>
              تحديث
            </SecondaryButton>
          )
        }
      />

      <Tabs tabs={PAGE_TABS} active={tab} onChange={setTab} />

      {tab === "rates" ? (
        <Card className="ui-mt-md">
          <CardBody>
            <p className="ui-text-muted" style={{ marginTop: 0 }}>
              حدّد أجر الساعة لكل كاشير — يُستخدم لحساب الراتب في تقرير الورديات.
            </p>
            {ratesLoading ? (
              <Skeleton style={{ height: 200 }} />
            ) : ratesErr ? (
              <EmptyState title={ratesErr} className="ui-mt-md" />
            ) : cashiers.length === 0 ? (
              <EmptyState title="لا يوجد كاشير مسجّل" />
            ) : (
              <DataTable columns={rateColumns} rows={cashiers} keyField="id" />
            )}
          </CardBody>
        </Card>
      ) : (
        <>
          <Card className="ui-mt-md payroll-report-filters-card">
            <CardBody className="payroll-report-filters">
              <FormGrid columns={3}>
                <FormField label="من">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </FormField>
                <FormField label="إلى">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </FormField>
                <FormField label="الكاشير">
                  <Select value={cashierFilter} onChange={(e) => setCashierFilter(e.target.value)}>
                    <option value="">الكل</option>
                    {cashiers.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.username}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </FormGrid>
              <div className="payroll-report-presets">
                {presets.map((p) => (
                  <SecondaryButton key={p.id} type="button" onClick={() => applyPreset(p)}>
                    {p.label}
                  </SecondaryButton>
                ))}
              </div>
            </CardBody>
          </Card>

          {reportErr ? (
            <EmptyState title={reportErr} className="ui-mt-md" />
          ) : reportLoading ? (
            <div className="ui-mt-md">
              <Skeleton style={{ height: 100, marginBottom: 16 }} />
              <Skeleton style={{ height: 240 }} />
            </div>
          ) : report ? (
            <>
              <div
                className="ui-stat-grid ui-mt-md"
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}
              >
                <StatCard label="إجمالي الساعات" value={formatHoursAr(report.grand_total_hours)} />
                <StatCard label="إجمالي الرواتب" value={ils(report.grand_total_pay)} />
                <StatCard label="عدد الكاشير" value={String(report.employees?.length ?? 0)} />
              </div>

              {report.employees?.length === 0 ? (
                <EmptyState
                  title="لا توجد ورديات منتهية في هذه الفترة"
                  subtitle="تُحسب فقط الورديات التي أُغلقت (بانتظار العد أو مغلقة)"
                  className="ui-mt-md"
                />
              ) : (
                <>
                  <Card className="ui-mt-md">
                    <CardBody>
                      <h3 style={{ marginTop: 0 }}>ملخص حسب الكاشير</h3>
                      <DataTable
                        columns={summaryTableColumns}
                        rows={report.employees}
                        keyField="cashier_id"
                        onRowClick={(row) =>
                          setExpandedCashier((prev) =>
                            prev === row.cashier_id ? null : row.cashier_id
                          )
                        }
                      />
                    </CardBody>
                  </Card>

                  {expandedCashier != null ? (
                    <Card className="ui-mt-md">
                      <CardBody>
                        <h3 style={{ marginTop: 0 }}>
                          تفاصيل الورديات —{" "}
                          {report.employees.find((e) => e.cashier_id === expandedCashier)?.username}
                        </h3>
                        <DataTable
                          columns={[
                            { key: "shift_id", header: "الوردية", value: (s) => s.shift_id },
                            {
                              key: "start_time",
                              header: "البداية",
                              value: (s) => formatDateTimeAr(s.start_time),
                            },
                            {
                              key: "end_time",
                              header: "النهاية",
                              value: (s) => formatDateTimeAr(s.end_time),
                            },
                            {
                              key: "hours",
                              header: "الساعات",
                              value: (s) => formatHoursAr(s.hours),
                            },
                            { key: "pay", header: "المبلغ", value: (s) => ils(s.pay) },
                            {
                              key: "status",
                              header: "الحالة",
                              value: (s) => formatShiftStatus(s.status),
                            },
                          ]}
                          rows={
                            report.employees.find((e) => e.cashier_id === expandedCashier)?.shifts ||
                            []
                          }
                          keyField="shift_id"
                        />
                      </CardBody>
                    </Card>
                  ) : null}
                </>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
