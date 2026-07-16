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
import FaceEnrollmentPanel from "../components/FaceEnrollmentPanel";
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

const ROLE_LABELS = {
  cashier: "كاشير",
  bakery_employee: "موظف مخبز",
  shelves_employee: "موظف رفوف",
};

const PAGE_TABS = [
  { id: "rates", label: "أجور الساعة" },
  { id: "enroll", label: "تسجيل الوجه" },
  { id: "report", label: "تقرير الساعات" },
];

const REPORT_SUMMARY_COLUMNS = [
  { key: "username", header: "الموظف", value: (r) => r.username },
  {
    key: "role_label",
    header: "الدور",
    value: (r) => r.role_label || ROLE_LABELS[r.role] || r.role,
  },
  {
    key: "hourly_rate",
    header: "أجر الساعة",
    value: (r) => (r.hourly_rate > 0 ? ils(r.hourly_rate) : "—"),
  },
  {
    key: "hours_source",
    header: "مصدر الساعات",
    value: (r) => (r.hours_source === "shift" ? "ورديات" : "حضور"),
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

export default function CashierPayroll() {
  const toast = useToast();
  const [tab, setTab] = useState("rates");

  const [employees, setEmployees] = useState([]);
  const [ratesLoading, setRatesLoading] = useState(true);
  const [ratesErr, setRatesErr] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editRate, setEditRate] = useState("");
  const [savingRate, setSavingRate] = useState(false);

  const [from, setFrom] = useState(firstOfCurrentMonthYmd());
  const [to, setTo] = useState(todayYmd());
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportErr, setReportErr] = useState("");
  const [expandedUser, setExpandedUser] = useState(null);
  const [manualPunchType, setManualPunchType] = useState("out");
  const [manualPunchTime, setManualPunchTime] = useState("");
  const [punchSaving, setPunchSaving] = useState(false);
  const [editingPunchId, setEditingPunchId] = useState(null);
  const [editPunchTime, setEditPunchTime] = useState("");
  const [editPunchType, setEditPunchType] = useState("in");

  const presets = useMemo(() => getDatePresets(), []);

  const loadEmployees = useCallback(async () => {
    setRatesLoading(true);
    setRatesErr("");
    try {
      const { data } = await api.get("/api/payroll/employees", { headers: getAuthHeaders() });
      setEmployees(Array.isArray(data) ? data : []);
    } catch (e) {
      setRatesErr(e.response?.data?.error || e.message || "فشل تحميل الموظفين");
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
      if (employeeFilter) params.user_id = employeeFilter;
      const { data } = await api.get("/api/attendance/report", {
        params,
        headers: getAuthHeaders(),
      });
      setReport(data);
      setExpandedUser(null);
    } catch (e) {
      setReport(null);
      setReportErr(e.response?.data?.error || e.message || "فشل تحميل التقرير");
    } finally {
      setReportLoading(false);
    }
  }, [from, to, employeeFilter]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    if (tab === "report") loadReport();
  }, [tab, loadReport]);

  useEffect(() => {
    cancelEditPunch();
    setManualPunchTime("");
    setManualPunchType("out");
  }, [expandedUser]);

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
      loadEmployees();
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

  const flatSessionRows = useMemo(() => {
    if (!report?.employees?.length) return [];
    const rows = [];
    for (const emp of report.employees) {
      for (const session of emp.sessions || []) {
        rows.push({
          ...session,
          username: emp.username,
          role_label: emp.role_label,
          hourly_rate: emp.hourly_rate,
        });
      }
    }
    return rows;
  }, [report]);

  function punchTypeLabel(type) {
    return type === "in" ? "حضور" : "انصراف";
  }

  function punchSourceLabel(source) {
    if (source === "manual") return "يدوي";
    if (source === "kiosk") return "كشك";
    return source || "—";
  }

  function toDatetimeLocalValue(sqlTime) {
    if (!sqlTime) return "";
    const normalized = String(sqlTime).trim().replace(" ", "T");
    return normalized.slice(0, 16);
  }

  function fromDatetimeLocalValue(value) {
    if (!value) return "";
    return `${value.replace("T", " ")}:00`.slice(0, 19);
  }

  const expandedEmployee = useMemo(
    () => report?.employees?.find((e) => e.user_id === expandedUser) || null,
    [report, expandedUser]
  );

  async function saveManualPunch() {
    if (!expandedEmployee || expandedEmployee.hours_source !== "punch") return;
    if (!manualPunchTime) {
      toast.error("حدد وقت التسجيل");
      return;
    }
    setPunchSaving(true);
    try {
      await api.post(
        "/api/attendance/manual-punch",
        {
          user_id: expandedEmployee.user_id,
          punch_time: fromDatetimeLocalValue(manualPunchTime),
          type: manualPunchType,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تمت إضافة التسجيل");
      setManualPunchTime("");
      loadReport();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل إضافة التسجيل");
    } finally {
      setPunchSaving(false);
    }
  }

  function startEditPunch(punch) {
    setEditingPunchId(punch.id);
    setEditPunchTime(toDatetimeLocalValue(punch.punch_time));
    setEditPunchType(punch.type);
  }

  function cancelEditPunch() {
    setEditingPunchId(null);
    setEditPunchTime("");
    setEditPunchType("in");
  }

  async function saveEditPunch() {
    if (!editingPunchId || !editPunchTime) {
      toast.error("حدد وقت التسجيل");
      return;
    }
    setPunchSaving(true);
    try {
      await api.patch(
        `/api/attendance/punch/${editingPunchId}`,
        {
          punch_time: fromDatetimeLocalValue(editPunchTime),
          type: editPunchType,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تم تحديث التسجيل");
      cancelEditPunch();
      loadReport();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل تحديث التسجيل");
    } finally {
      setPunchSaving(false);
    }
  }

  async function removePunch(punchId) {
    if (!window.confirm("حذف هذا التسجيل؟")) return;
    setPunchSaving(true);
    try {
      await api.delete(`/api/attendance/punch/${punchId}`, { headers: getAuthHeaders() });
      toast.success("تم حذف التسجيل");
      if (editingPunchId === punchId) cancelEditPunch();
      loadReport();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل حذف التسجيل");
    } finally {
      setPunchSaving(false);
    }
  }

  function onExportCsv() {
    if (!flatSessionRows.length) {
      toast.info("لا توجد بيانات للتصدير");
      return;
    }
    exportToCsv(`employee-hours-${from}-${to}`, [
      { key: "username", header: "الموظف", value: (r) => r.username },
      { key: "role_label", header: "الدور", value: (r) => r.role_label },
      { key: "start_time", header: "البداية", value: (r) => formatDateTimeAr(r.start_time) },
      { key: "end_time", header: "النهاية", value: (r) => formatDateTimeAr(r.end_time) },
      { key: "hours", header: "الساعات", value: (r) => formatHoursAr(r.hours) },
      { key: "status", header: "الحالة", value: (r) => formatShiftStatus(r.status) },
    ], flatSessionRows);
  }

  const rateColumns = [
    {
      key: "username",
      header: "الموظف",
      value: (c) => c.username,
    },
    {
      key: "role",
      header: "الدور",
      value: (c) => ROLE_LABELS[c.role] || c.role,
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
        title="الموظفون"
        subtitle="أجور الساعة، تسجيل الوجه، وتقرير ساعات العمل"
        icon="shifts"
        actions={
          tab === "report" ? (
            <>
              <SecondaryButton type="button" onClick={onExportCsv} disabled={!flatSessionRows.length}>
                تصدير CSV
              </SecondaryButton>
              <PrimaryButton type="button" onClick={loadReport} disabled={reportLoading}>
                {reportLoading ? "جاري التحميل…" : "تحديث"}
              </PrimaryButton>
            </>
          ) : tab === "rates" ? (
            <SecondaryButton type="button" onClick={loadEmployees} disabled={ratesLoading}>
              تحديث
            </SecondaryButton>
          ) : null
        }
      />

      <Tabs tabs={PAGE_TABS} active={tab} onChange={setTab} />

      {tab === "rates" ? (
        <Card className="ui-mt-md">
          <CardBody>
            <p className="ui-text-muted" style={{ marginTop: 0 }}>
              حدّد أجر الساعة لكل موظف — يُستخدم لحساب الراتب في تقرير الساعات.
            </p>
            {ratesLoading ? (
              <Skeleton style={{ height: 200 }} />
            ) : ratesErr ? (
              <EmptyState title={ratesErr} className="ui-mt-md" />
            ) : employees.length === 0 ? (
              <EmptyState title="لا يوجد موظفون مسجّلون" />
            ) : (
              <DataTable columns={rateColumns} rows={employees} keyField="id" />
            )}
          </CardBody>
        </Card>
      ) : tab === "enroll" ? (
        <FaceEnrollmentPanel />
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
                <FormField label="الموظف">
                  <Select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)}>
                    <option value="">الكل</option>
                    {employees.map((c) => (
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
                <StatCard label="عدد الموظفين" value={String(report.employees?.length ?? 0)} />
              </div>

              {report.employees?.length === 0 ? (
                <EmptyState
                  title="لا توجد ساعات عمل في هذه الفترة"
                  subtitle="الكاشير من الورديات، المخبز والرفوف من سجل الحضور"
                  className="ui-mt-md"
                />
              ) : (
                <>
                  <Card className="ui-mt-md">
                    <CardBody>
                      <h3 style={{ marginTop: 0 }}>ملخص حسب الموظف</h3>
                      <DataTable
                        columns={summaryTableColumns}
                        rows={report.employees}
                        keyField="user_id"
                        onRowClick={(row) =>
                          setExpandedUser((prev) => (prev === row.user_id ? null : row.user_id))
                        }
                      />
                    </CardBody>
                  </Card>

                  {expandedUser != null ? (
                    <Card className="ui-mt-md">
                      <CardBody>
                        <h3 style={{ marginTop: 0 }}>
                          التفاصيل — {expandedEmployee?.username}
                        </h3>
                        <DataTable
                          columns={[
                            {
                              key: "source",
                              header: "المصدر",
                              value: (s) => (s.source === "shift" ? "وردية" : "حضور"),
                            },
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
                            {
                              key: "status",
                              header: "الحالة",
                              value: (s) => formatShiftStatus(s.status),
                            },
                          ]}
                          rows={expandedEmployee?.sessions || []}
                          keyField="session_id"
                        />

                        {expandedEmployee?.hours_source === "punch" ? (
                          <div className="ui-mt-md">
                            <h4 style={{ marginTop: 24 }}>تسجيلات الحضور (تصحيح يدوي)</h4>
                            <p className="ui-text-muted" style={{ marginTop: 0 }}>
                              أضف أو عدّل تسجيلات الحضور لإغلاق الجلسات المفتوحة أو تصحيح الأخطاء.
                            </p>

                            <FormGrid columns={3}>
                              <FormField label="نوع التسجيل">
                                <Select
                                  value={manualPunchType}
                                  onChange={(e) => setManualPunchType(e.target.value)}
                                >
                                  <option value="in">حضور</option>
                                  <option value="out">انصراف</option>
                                </Select>
                              </FormField>
                              <FormField label="الوقت">
                                <Input
                                  type="datetime-local"
                                  value={manualPunchTime}
                                  onChange={(e) => setManualPunchTime(e.target.value)}
                                />
                              </FormField>
                              <FormField label=" ">
                                <PrimaryButton
                                  type="button"
                                  onClick={saveManualPunch}
                                  disabled={punchSaving || !manualPunchTime}
                                >
                                  {punchSaving ? "جاري الحفظ…" : "إضافة تسجيل"}
                                </PrimaryButton>
                              </FormField>
                            </FormGrid>

                            <DataTable
                              columns={[
                                {
                                  key: "punch_time",
                                  header: "الوقت",
                                  render: (p) =>
                                    editingPunchId === p.id ? (
                                      <Input
                                        type="datetime-local"
                                        value={editPunchTime}
                                        onChange={(e) => setEditPunchTime(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    ) : (
                                      formatDateTimeAr(p.punch_time)
                                    ),
                                },
                                {
                                  key: "type",
                                  header: "النوع",
                                  render: (p) =>
                                    editingPunchId === p.id ? (
                                      <Select
                                        value={editPunchType}
                                        onChange={(e) => setEditPunchType(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <option value="in">حضور</option>
                                        <option value="out">انصراف</option>
                                      </Select>
                                    ) : (
                                      punchTypeLabel(p.type)
                                    ),
                                },
                                {
                                  key: "source",
                                  header: "المصدر",
                                  value: (p) => punchSourceLabel(p.source),
                                },
                                {
                                  key: "actions",
                                  header: "إجراءات",
                                  render: (p) =>
                                    editingPunchId === p.id ? (
                                      <div className="ui-table__actions" onClick={(e) => e.stopPropagation()}>
                                        <PrimaryButton
                                          size="sm"
                                          type="button"
                                          onClick={saveEditPunch}
                                          disabled={punchSaving}
                                        >
                                          حفظ
                                        </PrimaryButton>
                                        <SecondaryButton size="sm" type="button" onClick={cancelEditPunch}>
                                          إلغاء
                                        </SecondaryButton>
                                      </div>
                                    ) : (
                                      <div className="ui-table__actions" onClick={(e) => e.stopPropagation()}>
                                        <SecondaryButton size="sm" type="button" onClick={() => startEditPunch(p)}>
                                          تعديل
                                        </SecondaryButton>
                                        <SecondaryButton
                                          size="sm"
                                          type="button"
                                          onClick={() => removePunch(p.id)}
                                          disabled={punchSaving}
                                        >
                                          حذف
                                        </SecondaryButton>
                                      </div>
                                    ),
                                },
                              ]}
                              rows={expandedEmployee?.punches || []}
                              keyField="id"
                            />
                          </div>
                        ) : null}
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
