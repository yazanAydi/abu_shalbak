import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { formatDateTimeAr, formatHoursAr } from "../utils/payrollHelpers";
import {
  PageHeader,
  Button,
  Card,
  CardBody,
  DataTable,
  FilterBar,
  FormField,
  FormGrid,
  Input,
  Select,
  Notice,
  useToast,
} from "../components/ui";
import { apiErrorMessage } from "../utils/apiError";

function lastOfMonth(ymd) {
  if (!ymd) return todayYmd();
  const [y, m] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function sessionStatus(row) {
  if (row.status === "closed") return "مغلقة";
  if (row.status === "open") return "مفتوحة";
  if (row.status === "missing_checkout") return "بلا انصراف";
  return row.status || "—";
}

const ROLE_LABELS = {
  admin: "مدير",
  accountant: "محاسب",
  cashier: "كاشير",
  bakery_employee: "مخبز",
  shelves_employee: "رفوف",
};

function personKey(person) {
  return person.employee_id ? `e-${person.employee_id}` : `u-${person.user_id}`;
}

function personValue(person) {
  return person.employee_id ? String(person.employee_id) : `user:${person.user_id}`;
}

function personLabel(person) {
  const role = ROLE_LABELS[person.role] || "";
  return role ? `${person.name} · ${role}` : person.name;
}

export default function DeviceAttendance() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [periodFrom, setPeriodFrom] = useState(firstOfCurrentMonthYmd());
  const [periodTo, setPeriodTo] = useState(lastOfMonth(firstOfCurrentMonthYmd()));
  const [cutover, setCutover] = useState("");
  const [detail, setDetail] = useState(null);
  const [manualType, setManualType] = useState("in");
  const [manualAt, setManualAt] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    const deviceRes = await api.get("/api/attendance/device/status", { headers: getAuthHeaders() });
    setStatus(deviceRes.data);
    setCutover(deviceRes.data?.cutover || "");
    const trackable = Array.isArray(deviceRes.data?.trackable_employees) ? deviceRes.data.trackable_employees : [];
    setEmployees(trackable);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!employeeId || !periodFrom || !periodTo) {
      setDetail(null);
      return;
    }
    const { data } = await api.get(`/api/attendance/device/employees/${employeeId}`, {
      headers: getAuthHeaders(),
      params: { from: periodFrom, to: periodTo },
    });
    setDetail(data);
  }, [employeeId, periodFrom, periodTo]);

  useEffect(() => {
    loadStatus().catch((error) => toast.error(apiErrorMessage(error, "فشل تحميل جهاز البصمة")));
  }, [loadStatus, toast]);

  useEffect(() => {
    loadDetail().catch((error) => toast.error(apiErrorMessage(error, "فشل تحميل الحضور")));
  }, [loadDetail, toast]);

  async function saveCutover(nextValue = cutover) {
    setBusy(true);
    try {
      await api.put("/api/attendance/device/cutover", { cutover: nextValue }, { headers: getAuthHeaders() });
      setCutover(nextValue || "");
      toast.success(nextValue ? "تم حفظ تاريخ الاعتماد" : "تم إلغاء تاريخ الاعتماد");
      await loadStatus();
    } catch (error) {
      toast.error(apiErrorMessage(error, "فشل حفظ التاريخ"));
    } finally {
      setBusy(false);
    }
  }

  async function saveMapping(deviceUserId, value) {
    setBusy(true);
    try {
      let body = { device_user_id: deviceUserId, active: false };
      if (value && String(value).startsWith("user:")) {
        body = { device_user_id: deviceUserId, user_id: Number(String(value).slice(5)) };
      } else if (value) {
        body = { device_user_id: deviceUserId, employee_id: Number(value) };
      }
      await api.put("/api/attendance/device/mappings", body, { headers: getAuthHeaders() });
      toast.success("تم حفظ الربط");
      await loadStatus();
      await loadDetail();
    } catch (error) {
      toast.error(apiErrorMessage(error, "فشل حفظ الربط"));
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const { data } = await api.post("/api/attendance/device/sync", {}, { headers: getAuthHeaders() });
      if (data?.ok) toast.success("تمت قراءة الجهاز");
      else if (data?.skipped) toast.error("المزامنة غير مفعّلة. اضبط ZKTECO_ENABLED و ZKTECO_HOST ثم أعد تشغيل الخادم.");
      else toast.error(data?.error || "تعذر قراءة الجهاز");
      await loadStatus();
      await loadDetail();
    } catch (error) {
      toast.error(apiErrorMessage(error, "تعذر قراءة الجهاز"));
    } finally {
      setBusy(false);
    }
  }

  async function addManual() {
    if (!employeeId) return;
    setBusy(true);
    try {
      await api.post(
        "/api/attendance/device/punches",
        {
          employee_id: Number(employeeId),
          punch_type: manualType,
          punched_at: manualAt,
          note: manualNote,
        },
        { headers: getAuthHeaders() }
      );
      setManualNote("");
      toast.success("تم حفظ التصحيح");
      await loadDetail();
    } catch (error) {
      toast.error(apiErrorMessage(error, "فشل التصحيح"));
    } finally {
      setBusy(false);
    }
  }

  async function voidPunch(id) {
    const reason = window.prompt("سبب إلغاء التسجيل");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await api.post(
        `/api/attendance/device/punches/${id}/void`,
        { reason: reason.trim() },
        { headers: getAuthHeaders() }
      );
      toast.success("أُلغي التسجيل دون حذف أصل الجهاز");
      await loadDetail();
    } catch (error) {
      toast.error(apiErrorMessage(error, "فشل الإلغاء"));
    } finally {
      setBusy(false);
    }
  }

  const users = status?.users || [];
  const unmapped = users.filter((row) => !row.mapped);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="جهاز البصمة"
        subtitle="ربط مستخدم الجهاز بالموظف. ساعات الراتب تُؤخذ من الحضور بعد تاريخ الاعتماد."
        icon="shifts"
      />

      <Card>
        <CardBody>
          <p>
            آخر مزامنة ناجحة: {status?.last_success_at ? formatDateTimeAr(status.last_success_at) : "—"}
            {" · "}
            آخر بصمة: {status?.last_punch_at ? formatDateTimeAr(status.last_punch_at) : "—"}
          </p>
          {status?.last_error ? <Notice tone="warning">آخر خطأ: {status.last_error}</Notice> : null}
          <p className="ui-text-muted">
            {status?.enabled
              ? `القراءة مفعّلة${status.host ? ` — ${status.host}:${status.port}` : ""}`
              : "القراءة متوقفة. فعّل ZKTECO_ENABLED في بيئة التشغيل. صفحات الراتب تقرأ قاعدة البيانات المحلية فقط."}
          </p>
          <div className="ui-toolbar" style={{ gap: 8, marginTop: 8 }}>
            <Button onClick={syncNow} disabled={busy}>
              قراءة الجهاز الآن
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card className="ui-mt-md">
        <CardBody>
          <FormGrid>
            <FormField label="تاريخ اعتماد الحضور للراتب" hint="بعد هذا التاريخ تُحتسب أجور الساعة والكاشير من الحضور. الأجر اليومي لا يتغير.">
              <Input type="date" value={cutover} onChange={(event) => setCutover(event.target.value)} />
            </FormField>
          </FormGrid>
          <div className="ui-toolbar" style={{ gap: 8, marginTop: 8 }}>
            <Button onClick={() => saveCutover(cutover)} disabled={busy}>
              حفظ التاريخ
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => saveCutover("")}
            >
              إلغاء الاعتماد
            </Button>
          </div>
        </CardBody>
      </Card>

      {unmapped.length ? (
        <Notice tone="warning">مستخدمون على الجهاز بلا موظف مربوط: {unmapped.map((row) => row.device_user_id).join("، ")}</Notice>
      ) : null}

      <Card className="ui-mt-md">
        <CardBody>
          <DataTable
            columns={[
              { key: "device_user_id", header: "رقم الجهاز" },
              { key: "display_name", header: "الاسم على الجهاز", render: (row) => row.display_name || "—" },
              {
                key: "employee",
                header: "الموظف في النظام",
                render: (row) => (
                  <Select
                    value={row.employee_id || ""}
                    onChange={(event) => saveMapping(row.device_user_id, event.target.value)}
                  >
                    <option value="">— غير مربوط —</option>
                    {employees.map((emp) => (
                      <option key={personKey(emp)} value={personValue(emp)}>
                        {personLabel(emp)}
                      </option>
                    ))}
                  </Select>
                ),
              },
              {
                key: "last_punch_at",
                header: "آخر بصمة",
                render: (row) => (row.last_punch_at ? formatDateTimeAr(row.last_punch_at) : "—"),
              },
              {
                key: "mapped",
                header: "الحالة",
                render: (row) => (row.mapped ? "مربوط" : "غير مربوط"),
              },
            ]}
            rows={users}
            empty="لا يوجد مستخدمون مقروءون من الجهاز بعد"
          />
        </CardBody>
      </Card>

      <FilterBar>
        <FormGrid>
          <FormField label="الموظف">
            <Select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">— اختر موظفاً —</option>
              {employees
                .filter((emp) => emp.employee_id)
                .map((emp) => (
                  <option key={personKey(emp)} value={emp.employee_id}>
                    {personLabel(emp)}
                  </option>
                ))}
            </Select>
          </FormField>
          <FormField label="من">
            <Input type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} />
          </FormField>
          <FormField label="إلى">
            <Input type="date" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} />
          </FormField>
        </FormGrid>
      </FilterBar>

      {detail ? (
        <Card className="ui-mt-md">
          <CardBody>
            <p>
              الساعات المحتسبة: {formatHoursAr(detail.attendance_hours)} — الأجر: {ils(detail.posted_pay || 0)}
            </p>
            {(detail.warning_labels || []).length ? <Notice tone="warning">{detail.warning_labels.join(" · ")}</Notice> : null}
            <DataTable
              columns={[
                { key: "check_in_at", header: "حضور", render: (row) => formatDateTimeAr(row.check_in_at) },
                {
                  key: "check_out_at",
                  header: "انصراف",
                  render: (row) => (row.check_out_at ? formatDateTimeAr(row.check_out_at) : "—"),
                },
                { key: "hours", header: "الساعات", render: (row) => formatHoursAr(row.hours) },
                { key: "pay", header: "الأجر", render: (row) => ils(row.pay || 0) },
                {
                  key: "status",
                  header: "الحالة",
                  render: (row) => `${sessionStatus(row)}${row.manual ? " · تصحيح يدوي" : ""}`,
                },
              ]}
              rows={detail.attendance_sessions || []}
              empty="لا توجد جلسات في الفترة"
            />
            <h3 className="ui-card__title">تصحيح يدوي</h3>
            <FormGrid>
              <FormField label="النوع">
                <Select value={manualType} onChange={(event) => setManualType(event.target.value)}>
                  <option value="in">حضور</option>
                  <option value="out">انصراف</option>
                </Select>
              </FormField>
              <FormField label="الوقت">
                <Input type="datetime-local" value={manualAt} onChange={(event) => setManualAt(event.target.value)} />
              </FormField>
              <FormField label="ملاحظة">
                <Input value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
              </FormField>
            </FormGrid>
            <div className="ui-toolbar" style={{ gap: 8, marginTop: 8 }}>
              <Button onClick={addManual} disabled={busy || !employeeId}>
                إضافة تصحيح
              </Button>
            </div>
            <DataTable
              columns={[
                { key: "punched_at", header: "الوقت", render: (row) => formatDateTimeAr(row.punched_at) },
                { key: "punch_type", header: "النوع", render: (row) => (row.punch_type === "in" ? "حضور" : "انصراف") },
                { key: "source", header: "المصدر", render: (row) => (row.source === "manual" ? "يدوي" : "جهاز") },
                { key: "status", header: "الحالة", render: (row) => (row.status === "void" ? "ملغى" : "فعال") },
                {
                  key: "note",
                  header: "ملاحظة",
                  render: (row) => row.correction_note || row.void_reason || "—",
                },
                {
                  key: "void",
                  header: "",
                  render: (row) =>
                    row.status === "active" ? (
                      <Button variant="secondary" onClick={() => voidPunch(row.id)}>
                        إلغاء
                      </Button>
                    ) : (
                      "—"
                    ),
                },
              ]}
              rows={detail.punches || []}
              empty="لا توجد تسجيلات"
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
