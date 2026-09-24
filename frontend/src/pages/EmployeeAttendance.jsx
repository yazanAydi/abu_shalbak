import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { formatDateTimeAr, formatHoursAr } from "../utils/payrollHelpers";
import {
  attendanceDurationHours,
  attendanceInstantFromFields,
  fieldsFromStoredInstant,
  hebronNowParts,
  hebronYesterdayYmd,
  normalizeDateText,
} from "../utils/attendanceDateTime";
import { shopTodayYmd } from "../utils/shopTime";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
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
  EmptyState,
  useToast,
  DateField,
} from "../components/ui";
import TimeField from "../components/ui/TimeField";

const ROLE_LABELS = {
  bakery_employee: "موظف مخبز",
  shelves_employee: "موظف رفوف",
};

function fieldError(result, raw, blurred) {
  if (!result || result.empty || result.ambiguous || !result.error) return "";
  const compact = String(raw || "").trim();
  const finished = compact.includes(":") || /^\d{3,}$/.test(compact);
  return blurred || finished ? result.error : "";
}

function StampPair({
  namePrefix,
  dateLabel,
  timeLabel,
  dateValue,
  timeValue,
  onDate,
  onDateInvalid,
  onTime,
  onToday,
  onYesterday,
  onNow,
  dateError,
  timeError,
  ambiguous,
  onPickOffset,
  syncToken = 0,
}) {
  return (
    <div className="attendance-stamp">
      <div className="attendance-stamp__fields">
        <FormField label={dateLabel} error={dateError}>
          <DateField
            yearDigits={4}
            keepInvalid
            name={`${namePrefix}-date`}
            value={dateValue}
            invalid={Boolean(dateError)}
            className={`ui-input${dateError ? " is-invalid" : ""}`}
            syncToken={syncToken}
            onChange={(e) => onDate(e.target.value)}
            onInvalid={onDateInvalid}
          />
        </FormField>
        <FormField label={timeLabel} error={timeError}>
          <TimeField
            name={`${namePrefix}-time`}
            value={timeValue}
            invalid={Boolean(timeError)}
            syncToken={syncToken}
            onChange={(e) => onTime(e.target.value)}
          />
        </FormField>
      </div>
      <div className="attendance-stamp__actions">
        <SecondaryButton type="button" size="sm" onClick={onToday}>
          اليوم
        </SecondaryButton>
        <SecondaryButton type="button" size="sm" onClick={onYesterday}>
          أمس
        </SecondaryButton>
        <SecondaryButton type="button" size="sm" onClick={onNow}>
          الآن
        </SecondaryButton>
      </div>
      {ambiguous?.length ? (
        <div className="attendance-stamp__dst" role="group" aria-label="اختيار التوقيت">
          <span>هذا الوقت يتكرر عند تغيير التوقيت:</span>
          {ambiguous.map((option) => (
            <SecondaryButton key={option.ms} type="button" size="sm" onClick={() => onPickOffset(option.ms)}>
              {option.offset}
            </SecondaryButton>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ALREADY_RECORDED = "تم تسجيل حضور هذا الموظف مسبقاً. تم تحديث القائمة ولن يُضاف سجل مكرر.";

export default function EmployeeAttendance() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const requestedDate = searchParams.get("date") || "";
  const requestedIds = useMemo(() => {
    const raw = searchParams.get("employees") || "";
    return new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
  }, [searchParams]);
  const appliedQuery = useRef(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState("");
  const [inDate, setInDate] = useState(() => shopTodayYmd());
  const [inTime, setInTime] = useState("");
  const [inPin, setInPin] = useState(null);
  const [outDate, setOutDate] = useState(() => shopTodayYmd());
  const [outTime, setOutTime] = useState("");
  const [outPin, setOutPin] = useState(null);
  const outDateEdited = useRef(false);
  const [correctDate, setCorrectDate] = useState("");
  const [correctTime, setCorrectTime] = useState("");
  const [correctPin, setCorrectPin] = useState(null);
  const [correctDateError, setCorrectDateError] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [correctSessionId, setCorrectSessionId] = useState(null);
  const [blurred, setBlurred] = useState({});
  const [inDateError, setInDateError] = useState("");
  const [outDateError, setOutDateError] = useState("");
  const [inSync, setInSync] = useState(0);
  const [outSync, setOutSync] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/attendance/sessions", { headers: getAuthHeaders() });
      const list = Array.isArray(data) ? data : [];
      setRows(list);
      setUserId((current) => current || (list[0] ? String(list[0].user_id) : ""));
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل الحضور"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visibleRows = useMemo(() => {
    if (!requestedIds.size) return rows;
    return rows.filter((row) => requestedIds.has(String(row.user_id)));
  }, [rows, requestedIds]);

  useEffect(() => {
    if (loading || appliedQuery.current) return;
    appliedQuery.current = true;
    if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      setInDate(requestedDate);
      setOutDate(requestedDate);
      setInDateError("");
      setOutDateError("");
      setInSync((n) => n + 1);
      setOutSync((n) => n + 1);
    }
  }, [loading, requestedDate]);

  useEffect(() => {
    if (!visibleRows.length) return;
    if (!visibleRows.some((row) => String(row.user_id) === String(userId))) {
      setUserId(String(visibleRows[0].user_id));
    }
  }, [visibleRows, userId]);

  const selected = visibleRows.find((row) => String(row.user_id) === String(userId)) || null;
  const arrival = attendanceInstantFromFields({ ymd: inDate, time: inTime, pinMs: inPin });
  const departure = attendanceInstantFromFields({ ymd: outDate, time: outTime, pinMs: outPin });
  const duration =
    arrival.ms != null && departure.ms != null ? attendanceDurationHours(arrival.ms, departure.ms) : null;
  const orderError =
    arrival.ms != null && departure.ms != null && departure.ms <= arrival.ms
      ? "الانصراف يجب أن يكون بعد الحضور. لدوام بعد منتصف الليل أدخل تاريخ الانصراف في اليوم التالي."
      : "";

  function markBlur(key) {
    setBlurred((current) => ({ ...current, [key]: true }));
  }

  function changeArrivalDate(value) {
    setInDate(value);
    setInDateError("");
    setInPin(null);
    if (!outDateEdited.current && value) {
      setOutDate(value);
      setOutDateError("");
    }
  }

  function changeDepartureDate(value) {
    outDateEdited.current = true;
    setOutDate(value);
    setOutPin(null);
  }

  function applyDay(which, ymd) {
    if (which === "in") {
      changeArrivalDate(ymd);
      setInSync((n) => n + 1);
    } else {
      changeDepartureDate(ymd);
      setOutDateError("");
      setOutSync((n) => n + 1);
    }
  }

  function applyNow(which) {
    const now = hebronNowParts();
    if (which === "in") {
      setInTime(now.time);
      setInPin(null);
      changeArrivalDate(now.ymd);
      setInSync((n) => n + 1);
    } else {
      setOutTime(now.time);
      changeDepartureDate(now.ymd);
      setOutSync((n) => n + 1);
    }
  }

  function resetEntry() {
    const today = shopTodayYmd();
    outDateEdited.current = false;
    setInDate(today);
    setInTime("");
    setInPin(null);
    setOutDate(today);
    setOutTime("");
    setOutPin(null);
    setCorrectDate("");
    setCorrectTime("");
    setCorrectPin(null);
    setCorrectReason("");
    setCorrectSessionId(null);
    setBlurred({});
    setInDateError("");
    setOutDateError("");
  }

  function loadStoredCheckout(session) {
    const fields = fieldsFromStoredInstant(session?.check_out_at);
    if (!fields) {
      toast.error("لا يوجد وقت انصراف محفوظ لهذه الجلسة");
      return;
    }
    setCorrectSessionId(session.id);
    setCorrectDate(fields.ymd);
    setCorrectTime(fields.time);
    setCorrectPin(fields.pinMs);
  }

  async function submit(path, body, message) {
    if (!selected) {
      toast.error("اختر موظفاً");
      return;
    }
    setSaving(true);
    try {
      await api.post(path, body, { headers: getAuthHeaders() });
      toast.success(message);
      resetEntry();
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSaving(false);
    }
  }

  async function submitCheckIn() {
    setBlurred({
      "attendance-in-date": true,
      "attendance-in-time": true,
      "attendance-out-date": true,
      "attendance-out-time": true,
    });
    if (!selected) {
      toast.error("اختر موظفاً");
      return;
    }
    if (arrival.empty || arrival.error || !arrival.sql) {
      toast.error(arrival.error || "أدخل تاريخ ووقت الحضور");
      return;
    }
    let checkOutSql;
    if (!departure.empty) {
      if (departure.error || !departure.sql) {
        toast.error(departure.error || "وقت الانصراف غير صالح");
        return;
      }
      if (departure.ms <= arrival.ms) {
        toast.error(orderError);
        return;
      }
      checkOutSql = departure.sql;
    } else if (String(outTime || "").trim()) {
      toast.error("وقت الانصراف غير صالح");
      return;
    }
    const previousIds = new Set((selected.sessions || []).map((row) => row.id));
    setSaving(true);
    try {
      const { data } = await api.get("/api/attendance/sessions", { headers: getAuthHeaders() });
      const list = Array.isArray(data) ? data : [];
      const fresh = list.find((row) => String(row.user_id) === String(selected.user_id));
      const added = (fresh?.sessions || []).filter((row) => !previousIds.has(row.id));
      if (fresh?.open_session || added.length) {
        setRows(list);
        toast.error(ALREADY_RECORDED);
        return;
      }
      await api.post(
        "/api/attendance/sessions/check-in",
        {
          user_id: selected.user_id,
          check_in_at: arrival.sql,
          check_out_at: checkOutSql,
        },
        { headers: getAuthHeaders() }
      );
      toast.success("تم تسجيل الحضور");
      resetEntry();
      await load();
    } catch (e) {
      await load();
      toast.error(
        e?.response?.status === 409 ? ALREADY_RECORDED : apiErrorMessage(e, "فشل الحفظ")
      );
    } finally {
      setSaving(false);
    }
  }

  function submitCheckOut() {
    setBlurred({ "attendance-out-date": true, "attendance-out-time": true });
    if (departure.empty || departure.error || !departure.sql) {
      toast.error(departure.error || "أدخل تاريخ ووقت الانصراف");
      return;
    }
    const openStart = fieldsFromStoredInstant(selected?.open_session?.check_in_at);
    if (openStart && departure.ms <= openStart.ms) {
      toast.error("الانصراف يجب أن يكون بعد الحضور");
      return;
    }
    submit(
      "/api/attendance/sessions/check-out",
      { user_id: selected.user_id, check_out_at: departure.sql },
      "تم تسجيل الانصراف"
    );
  }

  function submitCorrection() {
    const instant = attendanceInstantFromFields({
      ymd: correctDate,
      time: correctTime,
      pinMs: correctPin,
    });
    const session =
      selected?.sessions?.find((row) => row.id === correctSessionId) ||
      selected?.sessions?.find((row) => row.status === "closed" || row.auto_checkout) ||
      selected?.sessions?.[0];
    if (!session || instant.empty || instant.error || !instant.sql || !correctReason.trim()) {
      toast.error(instant.error || "أدخل وقت الانصراف والسبب");
      return;
    }
    const start = fieldsFromStoredInstant(session.check_in_at);
    if (start && instant.ms <= start.ms) {
      toast.error("الانصراف يجب أن يكون بعد الحضور");
      return;
    }
    submit(
      `/api/attendance/sessions/${session.id}/correct`,
      { check_out_at: instant.sql, reason: correctReason },
      "تم تصحيح الانصراف"
    );
  }

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تسجيل الحضور"
        subtitle="حضور وانصراف موظفي الأجر بالساعة. الكاشير يبقى على ورديات نقطة البيع."
        icon="shifts"
      />

      <Card>
        <CardBody>
          {loading ? null : visibleRows.length === 0 ? (
            <EmptyState
              title={requestedIds.size ? "لا يوجد موظفون بحاجة لتسجيل الحضور" : "لا يوجد موظف بأجر بالساعة"}
              subtitle={
                requestedIds.size
                  ? "تم تحديث القائمة. هؤلاء الموظفون غير متاحين لتسجيل حضور جديد."
                  : "من الموظفون في أجور الساعة والدوام، اختر طريقة احتساب الأجر: أجر بالساعة."
              }
            />
          ) : (
            <>
              <FormGrid columns={1}>
                <FormField label="الموظف">
                  <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                    {visibleRows.map((row) => (
                      <option key={row.user_id} value={String(row.user_id)}>
                        {row.name} — {ROLE_LABELS[row.role] || row.role}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </FormGrid>

              <div
                className="attendance-entry"
                data-enter-nav=""
                onKeyDown={handleEnterNavKeyDown}
                onBlur={(e) => {
                  const name = e.target?.getAttribute?.("name");
                  if (name) markBlur(name);
                }}
              >
                <StampPair
                  namePrefix="attendance-in"
                  dateLabel="تاريخ الحضور"
                  timeLabel="وقت الحضور"
                  dateValue={inDate}
                  timeValue={inTime}
                  dateError={inDateError}
                  timeError={fieldError(arrival, inTime, blurred["attendance-in-time"])}
                  ambiguous={arrival.ambiguous}
                  onDate={(value) => changeArrivalDate(value)}
                  onDateInvalid={(text) => setInDateError(normalizeDateText(text).error || "التاريخ غير صالح")}
                  onTime={(value) => {
                    setInTime(value);
                    setInPin(null);
                  }}
                  onToday={() => applyDay("in", shopTodayYmd())}
                  onYesterday={() => applyDay("in", hebronYesterdayYmd())}
                  onNow={() => applyNow("in")}
                  onPickOffset={setInPin}
                  syncToken={inSync}
                />
                <StampPair
                  namePrefix="attendance-out"
                  dateLabel="تاريخ الانصراف"
                  timeLabel="وقت الانصراف"
                  dateValue={outDate}
                  timeValue={outTime}
                  dateError={outDateError}
                  timeError={orderError || fieldError(departure, outTime, blurred["attendance-out-time"])}
                  ambiguous={departure.ambiguous}
                  onDate={(value) => {
                    setOutDateError("");
                    changeDepartureDate(value);
                  }}
                  onDateInvalid={(text) => {
                    outDateEdited.current = true;
                    setOutDateError(normalizeDateText(text).error || "التاريخ غير صالح");
                  }}
                  onTime={(value) => {
                    setOutTime(value);
                    setOutPin(null);
                  }}
                  onToday={() => applyDay("out", shopTodayYmd())}
                  onYesterday={() => applyDay("out", hebronYesterdayYmd())}
                  onNow={() => applyNow("out")}
                  onPickOffset={setOutPin}
                  syncToken={outSync}
                />
              </div>

              {duration != null ? (
                <p className="attendance-duration" data-testid="work-duration">
                  مدة العمل: {formatHoursAr(duration)}
                </p>
              ) : null}

              <div className="ui-toolbar ui-mt-md" style={{ gap: 8 }}>
                <PrimaryButton type="button" disabled={saving} onClick={submitCheckIn}>
                  تسجيل حضور
                </PrimaryButton>
                <SecondaryButton type="button" disabled={saving} onClick={submitCheckOut}>
                  تسجيل انصراف
                </SecondaryButton>
              </div>
              {selected?.open_session ? (
                <p className="ui-text-muted">
                  جلسة مفتوحة منذ {formatDateTimeAr(selected.open_session.check_in_at)} —{" "}
                  {formatHoursAr(selected.open_session.hours)} ساعة — {ils(selected.open_session.earned_pay)}
                  {selected.open_session.auto_checkout_label ? ` — ${selected.open_session.auto_checkout_label}` : ""}
                </p>
              ) : (
                <p className="ui-text-muted">لا توجد جلسة حضور مفتوحة.</p>
              )}

              <h3>تصحيح انصراف تلقائي</h3>
              <FormGrid columns={2}>
                <FormField label="تاريخ الانصراف الفعلي" error={correctDateError}>
                  <DateField
                    yearDigits={4}
                    keepInvalid
                    name="attendance-correct-date"
                    value={correctDate}
                    invalid={Boolean(correctDateError)}
                    className={`ui-input${correctDateError ? " is-invalid" : ""}`}
                    onChange={(e) => {
                      setCorrectDate(e.target.value);
                      setCorrectDateError("");
                      setCorrectPin(null);
                    }}
                    onInvalid={(text) =>
                      setCorrectDateError(normalizeDateText(text).error || "التاريخ غير صالح")
                    }
                  />
                </FormField>
                <FormField label="وقت الانصراف الفعلي">
                  <TimeField
                    name="attendance-correct-time"
                    value={correctTime}
                    onChange={(e) => {
                      setCorrectTime(e.target.value);
                      setCorrectPin(null);
                    }}
                  />
                </FormField>
                <FormField label="السبب">
                  <Input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
                </FormField>
              </FormGrid>
              <SecondaryButton
                className="ui-mt-md"
                type="button"
                disabled={saving || !selected?.sessions?.[0] || !correctTime || !correctReason}
                onClick={submitCorrection}
              >
                حفظ التصحيح
              </SecondaryButton>

              <div className="ui-mt-md">
                <DataTable
                  columns={[
                    { key: "in", header: "الحضور", render: (s) => formatDateTimeAr(s.check_in_at) },
                    { key: "out", header: "الانصراف", render: (s) => formatDateTimeAr(s.check_out_at) },
                    { key: "hours", header: "الساعات", render: (s) => formatHoursAr(s.hours) },
                    { key: "pay", header: "الأجر", render: (s) => ils(s.earned_pay) },
                    {
                      key: "note",
                      header: "ملاحظة",
                      render: (s) => s.auto_checkout_label || (s.corrected ? "مصحّح" : "—"),
                    },
                    {
                      key: "edit",
                      header: "",
                      render: (s) =>
                        s.check_out_at ? (
                          <SecondaryButton type="button" size="sm" onClick={() => loadStoredCheckout(s)}>
                            تصحيح
                          </SecondaryButton>
                        ) : (
                          "—"
                        ),
                    },
                  ]}
                  rows={selected?.sessions || []}
                  empty="لا توجد جلسات"
                />
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
