import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, ilsKnown } from "../utils/format";
import { getDatePresets, firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { exportToCsv } from "../utils/reportExport";
import {
  formatDateTimeAr,
  formatHoursAr,
  formatShiftStatus,
} from "../utils/payrollHelpers";
import { attendanceInstantFromFields, fieldsFromStoredInstant } from "../utils/attendanceDateTime";
import FaceEnrollmentPanel from "../components/FaceEnrollmentPanel";
import EmployeeRecordsPanel from "./EmployeeRecordsPanel";
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
import { useRegisterPageRefresh } from "../components/layout/PageRefreshContext";

const ROLE_LABELS = {
  cashier: "كاشير",
  bakery_employee: "موظف مخبز",
  shelves_employee: "موظف رفوف",
};

const PAGE_TABS = [
  { id: "records", label: "الموظفون" },
  { id: "rates", label: "أجور الساعة (كاشير/كشك)" },
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
    value: (r) => (r.missing_rate || r.total_pay == null ? "غير مكتمل" : ils(r.total_pay)),
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
  const [punchSaving, setPunchSaving] = useState(false);
  const [editingPunchId, setEditingPunchId] = useState(null);
  const [editPunchTime, setEditPunchTime] = useState("");
  const [editPunchType, setEditPunchType] = useState("in");
  const [editPunchPin, setEditPunchPin] = useState(null);
  const [editPunchAmbiguous, setEditPunchAmbiguous] = useState(null);

  const presets = useMemo(() => getDatePresets(), []);

  const loadEmployees = useCallback(async () => {
    setRatesLoading(true);
    setRatesErr("");
    try {
      const { data } = await api.get("/api/payroll/employees", { headers: getAuthHeaders() });
      setEmployees(Array.isArray(data) ? data : []);
    } catch (e) {
      setRatesErr(apiErrorMessage(e, "فشل تحميل الموظفين"));
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
      setReportErr(apiErrorMessage(e, "فشل تحميل التقرير"));
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

  const refreshTab = useCallback(async () => {
    if (tab === "report") await loadReport();
    else if (tab === "rates") await loadEmployees();
  }, [tab, loadReport, loadEmployees]);
  useRegisterPageRefresh(refreshTab);

  useEffect(() => {
    cancelEditPunch();
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
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
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
    const wall = fieldsFromStoredInstant(sqlTime);
    if (!wall) return "";
    return `${wall.ymd}T${wall.time}`;
  }

  function punchInstantFromEditor(value, pinMs = editPunchPin) {
    if (!value) return { empty: true };
    const [ymd, time] = String(value).split("T");
    return attendanceInstantFromFields({ ymd, time, pinMs });
  }

  function fromDatetimeLocalValue(value, pinMs = editPunchPin) {
    const instant = punchInstantFromEditor(value, pinMs);
    if (!instant || instant.empty || instant.error || !Number.isFinite(instant.ms)) return "";
    return new Date(instant.ms).toISOString().replace("T", " ").slice(0, 19);
  }

  const expandedEmployee = useMemo(
    () => report?.employees?.find((e) => e.user_id === expandedUser) || null,
    [report, expandedUser]
  );

  function startEditPunch(punch) {
    const wall = fieldsFromStoredInstant(punch.punch_time);
    setEditingPunchId(punch.id);
    setEditPunchTime(wall ? `${wall.ymd}T${wall.time}` : "");
    setEditPunchType(punch.type);
    setEditPunchPin(wall?.pinMs ?? null);
    setEditPunchAmbiguous(null);
  }

  function cancelEditPunch() {
    setEditingPunchId(null);
    setEditPunchTime("");
    setEditPunchType("in");
    setEditPunchPin(null);
    setEditPunchAmbiguous(null);
  }

  async function saveEditPunch() {
    const instant = punchInstantFromEditor(editPunchTime);
    if (instant?.ambiguous) setEditPunchAmbiguous(instant.ambiguous);
    if (!editingPunchId || !editPunchTime || instant?.empty || instant?.error || !Number.isFinite(instant?.ms)) {
      toast.error(instant?.error || "حدد وقت التسجيل");
      return;
    }
    const punchTime = new Date(instant.ms).toISOString().replace("T", " ").slice(0, 19);
    setPunchSaving(true);
    try {
      await api.patch(
        `/api/attendance/punch/${editingPunchId}`,
        {
          punch_time: punchTime,
          type: editPunchType,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تم تحديث التسجيل");
      cancelEditPunch();
      loadReport();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحديث التسجيل"));
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
      toast.error(apiErrorMessage(e, "فشل حذف التسجيل"));
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
          <div className="ui-table__actions">
            <SecondaryButton size="sm" type="button" onClick={() => startEditRate(c)}>
              تعديل
            </SecondaryButton>
          </div>
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
        title="أجور الساعة والدوام"
        subtitle="حسابات الموظفين وكشف الحساب والرواتب في القوائم الجانبية. هذه الصفحة لأجور الساعة وتسجيل الوجه وتقرير الساعات فقط."
        icon="shifts"
        actions={
          tab === "report" ? (
            <SecondaryButton type="button" onClick={onExportCsv} disabled={!flatSessionRows.length}>
              تصدير CSV
            </SecondaryButton>
          ) : null
        }
      />

      <Tabs tabs={PAGE_TABS} active={tab} onChange={setTab} />

      {tab === "records" ? <EmployeeRecordsPanel /> : null}

      {tab === "rates" ? (
        <Card className="ui-mt-md">
          <CardBody>
            <p className="ui-text-muted" style={{ marginTop: 0 }}>
              حدّد أجر الساعة لكل موظف. يُنسخ إلى الوردية عند فتحها فقط. تغيير أجر اليوم لا يغيّر وردية أُغلقت بأجر محفوظ، ووردية بلا أجر محفوظ تبقى غير مكتملة.
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
      ) : tab === "report" ? (
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
                <StatCard
                  label="إجمالي الرواتب"
                  value={ilsKnown(report.grand_total_pay, report.pay_incomplete)}
                />
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
                              key: "pay",
                              header: "الأجر",
                              value: (s) => (s.pay != null ? ils(s.pay) : "—"),
                            },
                            {
                              key: "auto",
                              header: "ملاحظة",
                              value: (s) =>
                                s.payroll_discrepancy
                                  ? s.payroll_discrepancy_note || "فرق بعد الترحيل"
                                  : s.auto_checkout_label || (s.corrected ? "مصحّح" : "—"),
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

                        {expandedEmployee?.hours_source === "punch" || expandedEmployee?.hours_source === "hourly_session" ? (
                          <p className="ui-text-muted ui-mt-md">
                            تسجيل الحضور والانصراف من صفحة{" "}
                            <Link to="/employee-attendance">تسجيل الحضور</Link>.
                          </p>
                        ) : null}

                        {expandedEmployee?.hours_source === "punch" ? (
                          <div className="ui-mt-md">
                            <h4 style={{ marginTop: 24 }}>تسجيلات الحضور</h4>
                            <DataTable
                              columns={[
                                {
                                  key: "punch_time",
                                  header: "الوقت",
                                  render: (p) =>
                                    editingPunchId === p.id ? (
                                      <div onClick={(e) => e.stopPropagation()}>
                                        <Input
                                          type="datetime-local"
                                          value={editPunchTime}
                                          onChange={(e) => {
                                            setEditPunchTime(e.target.value);
                                            setEditPunchPin(null);
                                            setEditPunchAmbiguous(null);
                                          }}
                                        />
                                        {editPunchAmbiguous?.length ? (
                                          <div role="group" aria-label="اختيار التوقيت">
                                            {editPunchAmbiguous.map((option) => (
                                              <button
                                                key={option.ms}
                                                type="button"
                                                onClick={() => {
                                                  setEditPunchPin(option.ms);
                                                  setEditPunchAmbiguous(null);
                                                }}
                                              >
                                                {option.offset === "+03" ? "توقيت صيفي" : "توقيت شتوي"} {option.offset}
                                              </button>
                                            ))}
                                          </div>
                                        ) : null}
                                      </div>
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
      ) : null}
    </div>
  );
}
