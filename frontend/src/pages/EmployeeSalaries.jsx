import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { reconcileStaffEmployees } from "../utils/reconcileStaffEmployees";
import {
  formatHoursAr,
  formatDateTimeAr,
  formatShiftStatus,
  formatShiftFlags,
  recordedHoursOf,
  eligibleHoursOf,
  estimatedCashierPay,
  estimatedShiftPay,
  payableHoursOf,
} from "../utils/payrollHelpers";
import { allocatePayrollDeductions } from "../utils/payrollPayout";
import {
  PageHeader,
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  FilterBar,
  FormField,
  FormGrid,
  Input,
  Select,
  Modal,
  Notice,
  StatusPill,
  StatCard,
  useToast,
} from "../components/ui";
import { apiErrorMessage } from "../utils/apiError";
import "./EmployeeSalaries.css";

function lastOfMonth(ymd) {
  if (!ymd) return todayYmd();
  const [y, m] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

const PAY_METHODS = [
  { value: "cash", label: "نقد" },
  { value: "transfer", label: "تحويل" },
  { value: "check", label: "شيك" },
  { value: "other", label: "أخرى" },
];

function PayFormulaCell({ label, value, tone }) {
  const cls = tone === "minus" ? "pay-formula__cell pay-formula__cell--minus" : "pay-formula__cell";
  return (
    <div className={cls}>
      <span className="pay-formula__label">{label}</span>
      <span className="pay-formula__value">{value}</span>
    </div>
  );
}

function PayFormula({ allocation, ready }) {
  const money = (n) => (ready ? ils(n) : "—");
  return (
    <div className="pay-formula" role="group" aria-label="حساب الدفعة">
      <div className="pay-formula__row">
        <PayFormulaCell label="المبلغ" value={money(allocation.payment)} />
        <span className="pay-formula__op" aria-hidden>
          −
        </span>
        <PayFormulaCell label="سلف" value={money(allocation.advanceDeducted)} tone="minus" />
        <span className="pay-formula__op" aria-hidden>
          −
        </span>
        <PayFormulaCell label="ذمم" value={money(allocation.debtDeducted)} tone="minus" />
      </div>
      <div className="pay-formula__net">
        <span className="pay-formula__label">يُدفع للموظف</span>
        <span className="pay-formula__net-value">{money(allocation.cashPaid)}</span>
      </div>
    </div>
  );
}

export default function EmployeeSalaries() {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [periodFrom, setPeriodFrom] = useState(firstOfCurrentMonthYmd());
  const [periodTo, setPeriodTo] = useState(lastOfMonth(firstOfCurrentMonthYmd()));
  const [asOf, setAsOf] = useState(todayYmd());
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("transfer");
  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showShifts, setShowShifts] = useState(false);
  const [hourlyRateDraft, setHourlyRateDraft] = useState("");
  const [savingRate, setSavingRate] = useState(false);

  const loadEmployees = useCallback(async () => {
    try {
      await reconcileStaffEmployees();
      const { data } = await api.get("/api/employees", { headers: getAuthHeaders() });
      setEmployees(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل الموظفين"));
    }
  }, [toast]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  const loadPreview = useCallback(async () => {
    if (!employeeId || !periodFrom || !periodTo) {
      setPreview(null);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get(`/api/employees/${employeeId}/payroll-preview`, {
        headers: getAuthHeaders(),
        params: { period_from: periodFrom, period_to: periodTo, as_of: asOf },
      });
      setPreview(data);
      const live = data?.hours?.live_hourly_rate;
      setHourlyRateDraft(live != null && Number(live) > 0 ? String(live) : "");
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل السلف والذمم"));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [employeeId, periodFrom, periodTo, asOf, toast]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    if (!preview || payAmount !== "") return;
    const net = preview.summary?.net_payable;
    if (net != null && Number(net) > 0) {
      setPayAmount(String(net));
      return;
    }
    const estimated = estimatedCashierPay(preview.hours, preview.live_hourly_rate);
    if (estimated != null && estimated > 0) {
      setPayAmount(String(estimated));
    }
  }, [preview, payAmount]);

  const summary = preview?.summary;
  const deductionAdvances = useMemo(
    () => preview?.summary?.advances || preview?.advances || [],
    [preview]
  );
  const deductionDebts = useMemo(
    () => preview?.summary?.debts || preview?.debts || [],
    [preview]
  );
  const allocation = useMemo(
    () => allocatePayrollDeductions(payAmount, deductionAdvances, deductionDebts),
    [payAmount, deductionAdvances, deductionDebts]
  );
  const hours = preview?.hours;
  const isCashier = preview?.kind === "cashier";
  const cashierUserId = hours?.cashier_user_id;
  const liveHourlyRate = hours?.live_hourly_rate ?? preview?.live_hourly_rate;
  const missingSnapshot = Number(hours?.missing_snapshot_count || 0) > 0;
  const liveRateMissing = liveHourlyRate == null || Number(liveHourlyRate) <= 0;
  const showRateEditor = isCashier && hours?.applicable && (missingSnapshot || liveRateMissing);
  const estimatedPay = isCashier ? estimatedCashierPay(hours, liveHourlyRate) : null;
  const payableHours = isCashier ? payableHoursOf(hours, liveHourlyRate) : 0;
  const typed = payAmount === "" ? null : Number(payAmount);
  const knownPay = Number.isFinite(typed) && typed > 0 ? typed : null;

  function openConfirm() {
    if (knownPay == null) {
      toast.error("أدخل المبلغ المراد دفعه");
      return;
    }
    if (allocation.cashPaid <= 0 && allocation.deductions.length === 0) {
      toast.error("أدخل مبلغاً أكبر من صفر");
      return;
    }
    setConfirmOpen(true);
  }

  async function saveLiveHourlyRate() {
    if (!cashierUserId) return;
    const rate = Number(hourlyRateDraft);
    if (!Number.isFinite(rate) || rate < 0) {
      toast.error("أجر الساعة يجب أن يكون رقماً موجباً أو صفراً");
      return;
    }
    setSavingRate(true);
    try {
      await api.patch(
        `/api/payroll/cashiers/${cashierUserId}`,
        { hourly_rate: rate },
        { headers: getAuthHeaders() }
      );
      toast.success("تم حفظ أجر الساعة — يُستخدم من الوردية التالية");
      await loadPreview();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل حفظ أجر الساعة"));
    } finally {
      setSavingRate(false);
    }
  }

  async function submitPayout() {
    setSaving(true);
    try {
      const payload = {
        period_from: periodFrom,
        period_to: periodTo,
        occurred_on: asOf,
        cash_paid: allocation.cashPaid,
        payment_method: allocation.cashPaid > 0 ? paymentMethod : undefined,
        deductions: allocation.deductions.map(({ label: _label, ...row }) => row),
        reference_note: note.trim() || undefined,
        idempotency_key: `payout-${employeeId}-${periodFrom}-${periodTo}-${Date.now()}`,
      };
      await api.post(`/api/employees/${employeeId}/payroll-payouts`, payload, {
        headers: getAuthHeaders(),
      });
      toast.success("سُجّلت الدفعة بعد حسم السلف والذمم");
      setConfirmOpen(false);
      setPayAmount("");
      setNote("");
      await loadPreview();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تسجيل الدفعة"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader title="رواتب الموظفين" subtitle="ادفع بعد حسم السلف والذمم" icon="shifts" />

      <FilterBar>
        <FormGrid>
          <FormField label="الموظف" required>
            <Select
              value={employeeId}
              onChange={(e) => {
                setEmployeeId(e.target.value);
                setPayAmount("");
                setShowShifts(false);
              }}
            >
              <option value="">— اختر موظفاً —</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                  {emp.kind === "cashier" ? " · كاشير" : ""}
                  {emp.user_username ? ` (${emp.user_username})` : ""}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="من فترة الراتب" required>
            <Input
              type="date"
              value={periodFrom}
              onChange={(e) => {
                setPeriodFrom(e.target.value);
                setPayAmount("");
              }}
            />
          </FormField>
          <FormField label="إلى" required>
            <Input
              type="date"
              value={periodTo}
              onChange={(e) => {
                setPeriodTo(e.target.value);
                setPayAmount("");
              }}
            />
          </FormField>
          <FormField label="حتى تاريخ">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </FormField>
        </FormGrid>
      </FilterBar>
      <p className="ui-text-muted">
        <Link to="/employee-statements">كشف حساب الموظفين</Link>
        {" · "}
        <Link to="/cashier-payroll">أجور الساعة والدوام</Link>
        {" · "}
        <Link to="/device-attendance">جهاز البصمة</Link>
      </p>
      {employees.find((emp) => String(emp.id) === String(employeeId))?.employment_duration ? (
        <p className="ui-text-muted">
          مدة العمل: {employees.find((emp) => String(emp.id) === String(employeeId)).employment_duration}
        </p>
      ) : null}

      {preview?.summary ? (
        <Card className="ui-mt-md">
          <CardBody>
            <h3 className="ui-card__title">ملخص الراتب للفترة</h3>
            <div className="ui-stat-grid">
              <StatCard
                label={summary.basis === "daily" ? "الأيام المستحقة" : "الساعات المستحقة"}
                value={
                  summary.basis === "daily"
                    ? summary.payable_days == null
                      ? "—"
                      : String(summary.payable_days)
                    : formatHoursAr(summary.payable_hours)
                }
                icon="shifts"
              />
              <StatCard
                label={summary.rate_unit === "day" ? "الأجر اليومي" : "أجر الساعة"}
                value={summary.rate != null ? ils(summary.rate) : "—"}
                icon="finance"
              />
              <StatCard
                label="الراتب المستحق قبل الخصم"
                value={summary.gross_known ? ils(summary.gross_salary) : "—"}
                icon="finance"
              />
              <StatCard label="إجمالي السلف" value={ils(summary.advances_total || 0)} icon="finance" tone="orange" />
              <StatCard label="إجمالي الذمم" value={ils(summary.debts_total || 0)} icon="alert" tone="orange" />
            </div>
            <div className="payroll-net">
              <div className="payroll-net__label">صافي المستحق للدفع</div>
              <div className="payroll-net__value num">
                {summary.net_payable == null ? "—" : ils(summary.net_payable)}
              </div>
            </div>
            {summary.note ? <p className="ui-text-muted ui-mt-md">{summary.note}</p> : null}
            {summary.pos_hours != null && summary.pay_from_attendance_hours ? (
              <p className="ui-text-muted">
                مدة وردية نقطة البيع: {formatHoursAr(summary.pos_hours)} — لا تُضاف إلى الراتب.
              </p>
            ) : null}
            {(summary.warnings || []).length ? (
              <Notice tone="warning">{summary.warnings.join(" · ")}</Notice>
            ) : null}
            <DataTable
              columns={
                summary.basis === "daily"
                  ? [
                      { key: "date", header: "التاريخ", render: (row) => row.date || "—" },
                      {
                        key: "in_at",
                        header: "حضور",
                        render: (row) => (row.in_at ? formatDateTimeAr(row.in_at) : "—"),
                      },
                      {
                        key: "out_at",
                        header: "انصراف",
                        render: (row) => (row.out_at ? formatDateTimeAr(row.out_at) : "—"),
                      },
                      {
                        key: "payable",
                        header: "اليوم المستحق",
                        render: () => "غير محتسب تلقائياً",
                      },
                      { key: "amount", header: "المبلغ اليومي", render: () => "—" },
                    ]
                  : [
                      { key: "date", header: "التاريخ", render: (row) => row.date || "—" },
                      {
                        key: "in_at",
                        header: "حضور",
                        render: (row) => (row.in_at ? formatDateTimeAr(row.in_at) : "—"),
                      },
                      {
                        key: "out_at",
                        header: "انصراف",
                        render: (row) => (row.out_at ? formatDateTimeAr(row.out_at) : "—"),
                      },
                      { key: "hours", header: "الساعات", render: (row) => formatHoursAr(row.hours) },
                      {
                        key: "amount",
                        header: "المبلغ",
                        render: (row) => (row.amount == null ? "—" : ils(row.amount)),
                      },
                      {
                        key: "status",
                        header: "الحالة",
                        render: (row) =>
                          row.status === "closed"
                            ? "مغلقة"
                            : row.status === "open"
                              ? "مفتوحة"
                              : row.status === "missing_checkout"
                                ? "بلا انصراف"
                                : row.status || "—",
                      },
                    ]
              }
              rows={summary.lines || []}
              empty="لا توجد بنود أجر في الفترة"
            />
          </CardBody>
        </Card>
      ) : null}

      {preview ? (
        <>
          {isCashier && hours?.applicable ? (
            <Card className="ui-mt-md">
              <CardBody>
                <h3 className="ui-card__title" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  ساعات الكاشير
                  {preview.calculation_final ? (
                    <StatusPill tone="green">جاهز للحساب</StatusPill>
                  ) : (
                    <StatusPill tone="orange">غير نهائي</StatusPill>
                  )}
                </h3>
                <p>
                  الساعات المسجّلة: {formatHoursAr(recordedHoursOf(hours))} — المحسوبة للأجر:{" "}
                  {formatHoursAr(payableHours)}
                  {eligibleHoursOf(hours) !== payableHours
                    ? ` — المؤهلة للترحيل: ${formatHoursAr(eligibleHoursOf(hours))}`
                    : ""}
                </p>
                {hours.attendance_authoritative ? (
                  <>
                    <p>
                      ساعات الحضور المحتسبة للراتب: <strong className="num">{formatHoursAr(hours.attendance_hours)}</strong>
                      {hours.shift_hours ? ` — ساعات الورديات قبل الاعتماد: ${formatHoursAr(hours.shift_hours)}` : ""}
                    </p>
                    <p>
                      مدة وردية نقطة البيع: <strong className="num">{formatHoursAr(hours.pos_hours)}</strong>
                      <span className="ui-text-muted"> — لا تُضاف إلى الراتب بعد {hours.cutover}</span>
                    </p>
                    {(hours.warning_labels || []).length ? (
                      <Notice tone="warning">{hours.warning_labels.join(" · ")}</Notice>
                    ) : null}
                  </>
                ) : null}
                <p>
                  أجر الفترة:{" "}
                  {estimatedPay != null ? (
                    <strong className="num">{ils(estimatedPay)}</strong>
                  ) : (
                    "—"
                  )}
                  {!preview.calculation_final && estimatedPay != null ? (
                    <span className="ui-text-muted"> — غير نهائي</span>
                  ) : null}
                </p>
                <p className="ui-text-muted">
                  {hours.attendance_authoritative
                    ? hours.comparison_note
                    : "الأجر = ساعات كل وردية مغلقة × أجرها. الورديات المفتوحة خارج الحساب. يمكنك تعديل المبلغ قبل الدفع."}
                </p>
                {showRateEditor ? (
                  <div className="ui-mt-md">
                    <Notice tone="warning">
                      أجر الساعة الحالي يُستخدم من الوردية التالية. وردية أُغلقت بلا أجر محفوظ تبقى غير مكتملة ولا يُنسخ عليها أجر اليوم.
                    </Notice>
                    <FormGrid>
                      <FormField label="أجر الساعة (₪)">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={hourlyRateDraft}
                          onChange={(e) => setHourlyRateDraft(e.target.value)}
                        />
                      </FormField>
                    </FormGrid>
                    <div className="ui-toolbar" style={{ gap: 8, marginTop: 8 }}>
                      <Button onClick={saveLiveHourlyRate} disabled={savingRate}>
                        حفظ أجر الساعة
                      </Button>
                    </div>
                  </div>
                ) : null}
                {(hours.review_flag_labels || hours.review_flags || []).length ? (
                  <Notice tone="warning">
                    يحتاج مراجعة:{" "}
                    {(hours.review_flag_labels || []).join("، ") || (hours.review_flags || []).join("، ")}
                  </Notice>
                ) : null}
                <Button variant="secondary" onClick={() => setShowShifts((v) => !v)}>
                  {showShifts
                    ? "إخفاء التفاصيل"
                    : hours.attendance_authoritative
                      ? "عرض جلسات الحضور"
                      : "عرض الورديات"}
                </Button>
                {showShifts && hours.attendance_authoritative ? (
                  <DataTable
                    loading={loading}
                    columns={[
                      { key: "check_in_at", header: "حضور", render: (s) => formatDateTimeAr(s.check_in_at) },
                      {
                        key: "check_out_at",
                        header: "انصراف",
                        render: (s) => (s.check_out_at ? formatDateTimeAr(s.check_out_at) : "—"),
                      },
                      { key: "hours", header: "الساعات", render: (s) => formatHoursAr(s.hours) },
                      { key: "pay", header: "الأجر", render: (s) => (s.pay > 0 ? ils(s.pay) : "0") },
                      {
                        key: "status",
                        header: "الحالة",
                        render: (s) =>
                          `${s.status === "closed" ? "مغلقة" : s.status === "open" ? "مفتوحة" : "بلا انصراف"}${
                            s.manual ? " · تصحيح يدوي" : ""
                          }`,
                      },
                    ]}
                    rows={hours.attendance_sessions || []}
                    empty="لا توجد جلسات حضور في الفترة"
                  />
                ) : null}
                {showShifts && !hours.attendance_authoritative ? (
                  <DataTable
                    loading={loading}
                    columns={[
                      { key: "start_time", header: "البداية", render: (s) => formatDateTimeAr(s.start_time) },
                      {
                        key: "end_time",
                        header: "النهاية",
                        render: (s) => (s.end_time ? formatDateTimeAr(s.end_time) : "—"),
                      },
                      { key: "hours", header: "المدة", render: (s) => formatHoursAr(s.hours) },
                      {
                        key: "hourly_rate",
                        header: "أجر الساعة",
                        render: (s) => (s.hourly_rate != null ? ils(s.hourly_rate) : "—"),
                      },
                      {
                        key: "pay",
                        header: "الأجر",
                        render: (s) => {
                          const pay = estimatedShiftPay(s, liveHourlyRate);
                          return pay > 0 ? ils(pay) : "—";
                        },
                      },
                      {
                        key: "status",
                        header: "الحالة",
                        render: (s) => (
                          <>
                            {formatShiftStatus(s.status)}
                            {s.flags?.length ? ` (${formatShiftFlags(s.flags, s.flag_labels)})` : ""}
                          </>
                        ),
                      },
                    ]}
                    rows={hours.shifts || []}
                    empty="لا توجد ورديات في الفترة"
                  />
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {!isCashier && hours?.attendance_informational ? (
            <Card className="ui-mt-md">
              <CardBody>
                <h3 className="ui-card__title">حضور الجهاز — للعرض</h3>
                <p>
                  المدة المسجّلة: {formatHoursAr(hours.attendance_hours)}
                  {hours.daily_rate != null ? ` — أجر اليوم: ${ils(hours.daily_rate)}` : ""}
                </p>
                <p className="ui-text-muted">
                  الأجر اليومي لا يُحسب من ساعات الحضور. الجلسات هنا للمراجعة فقط.
                </p>
                {(hours.attendance_warning_labels || []).length ? (
                  <Notice tone="warning">{hours.attendance_warning_labels.join(" · ")}</Notice>
                ) : null}
                <DataTable
                  columns={[
                    { key: "check_in_at", header: "حضور", render: (s) => formatDateTimeAr(s.check_in_at) },
                    {
                      key: "check_out_at",
                      header: "انصراف",
                      render: (s) => (s.check_out_at ? formatDateTimeAr(s.check_out_at) : "—"),
                    },
                    { key: "hours", header: "المدة", render: (s) => formatHoursAr(s.hours) },
                    {
                      key: "status",
                      header: "الحالة",
                      render: (s) =>
                        `${s.status === "closed" ? "مغلقة" : s.status === "open" ? "مفتوحة" : "بلا انصراف"}${
                          s.manual ? " · تصحيح يدوي" : ""
                        }`,
                    },
                  ]}
                  rows={hours.informational_sessions || []}
                  empty="لا توجد جلسات حضور في الفترة"
                />
              </CardBody>
            </Card>
          ) : null}

          {!isCashier && hours?.attendance_authoritative ? (
            <Card className="ui-mt-md">
              <CardBody>
                <h3 className="ui-card__title">ساعات الحضور</h3>
                <p>
                  الساعات المحتسبة: {formatHoursAr(hours.attendance_hours)} — الأجر:{" "}
                  <strong className="num">{ils(hours.posted_pay || 0)}</strong>
                  {hours.shift_hours ? ` — قبل الاعتماد: ${formatHoursAr(hours.shift_hours)}` : ""}
                </p>
                <p className="ui-text-muted">{hours.comparison_note}</p>
                {(hours.warning_labels || []).length ? (
                  <Notice tone="warning">{hours.warning_labels.join(" · ")}</Notice>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <div className="ui-stat-grid ui-mt-md">
            <StatCard
              label="سلف الفترة"
              value={ils(summary?.advances_total || 0)}
              hint={
                preview.advances_outstanding_total !== summary?.advances_total
                  ? "السلف خارج الفترة لا تُحسب في هذا الملخص"
                  : ""
              }
              icon="finance"
              tone="orange"
            />
            <StatCard
              label="ذمم الفترة"
              value={ils(summary?.debts_total || 0)}
              hint={
                preview.debts_outstanding_total !== summary?.debts_total
                  ? "الذمم خارج الفترة لا تُحسب في هذا الملخص"
                  : ""
              }
              icon="alert"
              tone="orange"
            />
          </div>

          <Card className="ui-mt-md">
            <CardHeader title="تفاصيل السلف" />
            <CardBody>
              <DataTable
                loading={loading}
                columns={[
                  { key: "date", header: "التاريخ" },
                  { key: "amount", header: "الأصل", render: (r) => ils(r.amount), className: "num" },
                  { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                  { key: "reason", header: "السبب", render: (r) => r.reason || "—" },
                ]}
                rows={deductionAdvances}
                empty="لا توجد سلف قائمة"
              />
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardHeader title="تفاصيل الذمم" />
            <CardBody>
              {preview.debts?.length ? (
                <DataTable
                  loading={loading}
                  columns={[
                    { key: "date", header: "التاريخ" },
                    {
                      key: "description",
                      header: "الفاتورة",
                      render: (r) => r.description || r.invoice_no || `#${r.source_id}`,
                    },
                    { key: "original", header: "الأصل", render: (r) => ils(r.original), className: "num" },
                    { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                  ]}
                  rows={deductionDebts}
                  empty="لا توجد ذمم قائمة"
                />
              ) : (
                <p className="ui-text-muted">
                  {preview.customer_linked ? "لا توجد ذمم قائمة" : "لا يوجد حساب ذمة لهذا الموظف."}
                </p>
              )}
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardHeader title="دفع راتب" />
            <CardBody>
              <FormGrid>
                <FormField label="المبلغ" required hint="المبلغ الذي تريد دفعه هذه المرة، قبل حسم السلف والذمم">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                </FormField>
                <FormField label="طريقة الدفع">
                  <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                    {PAY_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="ملاحظة" className="ui-field--full">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} />
                </FormField>
              </FormGrid>
              <PayFormula allocation={allocation} ready={knownPay != null} />
              {knownPay == null ? (
                <p className="ui-text-muted">أدخل المبلغ ليُحسب المدفوع بعد السلف والذمم.</p>
              ) : null}
              <Button onClick={openConfirm} disabled={saving || loading || knownPay == null}>
                دفع الراتب
              </Button>
            </CardBody>
          </Card>
        </>
      ) : null}

      <Modal
        open={confirmOpen}
        title="تأكيد الدفعة"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button onClick={submitPayout} disabled={saving}>
              تأكيد الحفظ
            </Button>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              إلغاء
            </Button>
          </>
        }
      >
        <PayFormula allocation={allocation} ready />
        {allocation.debtDeducted > 0 ? (
          <Notice tone="info">تسوية الذمة من الراتب — لا حركة درج للذمة</Notice>
        ) : null}
        {allocation.cashPaid === 0 ? (
          <p className="ui-text-muted">لا تُنشأ حركة نقد إذا غطّى الحسم المبلغ بالكامل.</p>
        ) : null}
      </Modal>
    </div>
  );
}
