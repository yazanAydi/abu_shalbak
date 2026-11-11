import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { formatDateTimeAr, formatHoursAr } from "../utils/payrollHelpers";
import { Button, Card, CardBody, DataTable, FormField, FormGrid, Input, Notice, useToast } from "./ui";
import { apiErrorMessage } from "../utils/apiError";

export default function AttendancePayrollRepair({ employeeId, refreshKey = "", onChanged }) {
  const toast = useToast();
  const [diag, setDiag] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!employeeId) {
      setDiag(null);
      return;
    }
    const { data } = await api.get(`/api/employees/${employeeId}/attendance-diagnostics`, {
      headers: getAuthHeaders(),
    });
    setDiag(data);
    if (!from && data?.missing_snapshot_dates?.length) {
      const dates = [...data.missing_snapshot_dates].sort();
      setFrom(dates[0]);
      setTo(dates[dates.length - 1]);
    }
  }, [employeeId, from]);

  useEffect(() => {
    setPreview(null);
    load().catch((error) => toast.error(apiErrorMessage(error, "فشل تحميل تشخيص الحضور")));
  }, [employeeId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runPreview() {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/api/employees/${employeeId}/attendance-rate-correction/preview`,
        { from, to, hourly_rate: Number(rate), note: note.trim() },
        { headers: getAuthHeaders() }
      );
      setPreview(data);
    } catch (error) {
      setPreview(null);
      toast.error(apiErrorMessage(error, "فشلت معاينة التصحيح"));
    } finally {
      setBusy(false);
    }
  }

  async function applyPreview() {
    if (!preview?.preview_token) return;
    setBusy(true);
    try {
      const { data } = await api.post(
        `/api/employees/${employeeId}/attendance-rate-correction`,
        { from, to, hourly_rate: Number(rate), note: note.trim(), preview_token: preview.preview_token },
        { headers: getAuthHeaders() }
      );
      toast.success(data.applied_count ? `حُفظ أجر ${data.applied_count} جلسة` : "لا توجد جلسات ناقصة ضمن المعاينة");
      setPreview(null);
      await load();
      if (onChanged) await onChanged();
    } catch (error) {
      toast.error(apiErrorMessage(error, "فشل تطبيق التصحيح"));
    } finally {
      setBusy(false);
    }
  }

  if (!employeeId || !diag) return null;

  return (
    <Card className="ui-mt-md">
      <CardBody>
        <h3 className="ui-card__title">تشخيص الحضور والأجر</h3>
        <p>
          موظف #{diag.employee_id}
          {diag.user_id ? ` · حساب ${diag.username || diag.user_id}` : " · بدون حساب دخول"}
          {diag.device_mapped ? ` · جهاز ${diag.device_user_id}` : " · بلا جهاز"}
        </p>
        <p>
          {diag.wage_basis === "daily"
            ? `أجر يومي${diag.daily_rate != null ? ` ${ils(diag.daily_rate)}` : ""}`
            : diag.hourly_rate != null
              ? `أجر الساعة ${ils(diag.hourly_rate)}`
              : "لا يوجد أجر ساعة"}
          {" · "}
          {diag.payroll_readiness_label}
        </p>
        <p>
          الساعات المسجّلة: {formatHoursAr(diag.recorded_hours)} — المحتسبة للأجر: {formatHoursAr(diag.payable_hours)} — الأجر:{" "}
          {diag.wage_basis === "daily"
            ? "للعلم فقط"
            : diag.missing_snapshots?.length
              ? "—"
              : ils(diag.payable_pay || 0)}
        </p>
        {diag.wage_basis !== "daily" && diag.missing_snapshot_dates?.length ? (
          <Notice tone="warning">جلسات بلا أجر محفوظ في: {diag.missing_snapshot_dates.join("، ")}</Notice>
        ) : null}
        {diag.name_candidates?.length ? (
          <Notice tone="info">
            سجلات بنفس الاسم للمراجعة اليدوية، ولن تُدمج:{" "}
            {diag.name_candidates.map((row) => `#${row.id}`).join("، ")}
          </Notice>
        ) : null}
        {diag.salary_periods?.some((period) => period.salary_saved) ? (
          <p className="ui-text-muted">توجد فترة راتب محفوظة. الجلسات داخلها لا يدخلها تصحيح الأجر.</p>
        ) : null}

        {diag.wage_basis === "daily" ? (
          <p className="ui-text-muted">الأجر اليومي لا يُصحَّح من أجر الساعة. الساعات المسجّلة للمراجعة فقط.</p>
        ) : (
        <>
        <h3 className="ui-card__title">تصحيح أجر الجلسات الناقصة</h3>
        <p className="ui-text-muted">يُطبَّق الأجر الذي تختاره هنا فقط على الجلسات بلا أجر محفوظ. لا يُستخدم أجر اليوم تلقائياً.</p>
        <FormGrid>
          <FormField label="من">
            <Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPreview(null); }} />
          </FormField>
          <FormField label="إلى">
            <Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPreview(null); }} />
          </FormField>
          <FormField label="أجر الساعة التاريخي (₪)">
            <Input type="number" min="0" step="0.01" value={rate} onChange={(event) => { setRate(event.target.value); setPreview(null); }} />
          </FormField>
          <FormField label="ملاحظة">
            <Input value={note} onChange={(event) => { setNote(event.target.value); setPreview(null); }} />
          </FormField>
        </FormGrid>
        <div className="ui-toolbar" style={{ gap: 8, marginTop: 8 }}>
          <Button variant="secondary" onClick={runPreview} disabled={busy}>معاينة</Button>
          <Button onClick={applyPreview} disabled={busy || !preview?.preview_token}>تطبيق التصحيح</Button>
        </div>
        {preview ? (
          <>
            <p>
              جلسات قابلة للتصحيح: {preview.eligible?.length || 0} — الساعات المحتسبة بعد التصحيح:{" "}
              {formatHoursAr(preview.payable_hours_after)} — الأجر بعد التصحيح: {ils(preview.payable_pay_after || 0)}
            </p>
            {preview.blocked?.length ? (
              <Notice tone="warning">مستبعدة لأنها داخل راتب محفوظ: {preview.blocked.length}</Notice>
            ) : null}
            <DataTable
              columns={[
                { key: "shop_start_on", header: "اليوم" },
                { key: "punched_at", header: "حضور", render: (row) => formatDateTimeAr(row.punched_at) },
                { key: "hours", header: "الساعات", render: (row) => formatHoursAr(row.hours) },
                { key: "pay_after", header: "الأجر بعد التصحيح", render: (row) => (row.pay_after > 0 ? ils(row.pay_after) : "—") },
              ]}
              rows={preview.eligible || []}
              empty="لا توجد جلسات ناقصة في هذه الفترة"
            />
          </>
        ) : null}
        </>
        )}
      </CardBody>
    </Card>
  );
}
