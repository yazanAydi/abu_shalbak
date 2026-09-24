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
    const estimated = estimatedCashierPay(preview.hours, preview.live_hourly_rate);
    if (estimated != null && estimated > 0) {
      setPayAmount(String(estimated));
    }
  }, [preview, payAmount]);

  const allocation = useMemo(
    () => allocatePayrollDeductions(payAmount, preview?.advances || [], preview?.debts || []),
    [payAmount, preview]
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
      </p>

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
                  الأجر = ساعات كل وردية مغلقة × أجرها. الورديات المفتوحة خارج الحساب. يمكنك تعديل
                  المبلغ قبل الدفع.
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
                  {showShifts ? "إخفاء الورديات" : "عرض الورديات"}
                </Button>
                {showShifts ? (
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

          <div className="ui-stat-grid ui-mt-md">
            <StatCard
              label="إجمالي سلف قائمة"
              value={ils(preview.advances_outstanding_total || 0)}
              icon="finance"
              tone="orange"
            />
            <StatCard
              label="إجمالي ذمم قائمة"
              value={ils(preview.debts_outstanding_total || 0)}
              hint={preview.customer_linked ? "" : "لا يوجد حساب ذمة لهذا الموظف"}
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
                rows={preview.advances || []}
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
                  rows={preview.debts || []}
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
