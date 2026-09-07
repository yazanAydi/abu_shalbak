import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./ShiftModal.css";

/**
 * @param {object} props
 * @param {() => Promise<unknown> | unknown} props.onSuccess — after shift started; parent refetches current shift
 * @param {number | null} props.openShiftId — if set, show open shift summary + end button
 * @param {() => void} [props.onRequestEndShift]
 * @param {() => void} [props.onLogout]
 * @param {string} [props.initialError]
 */
export default function ShiftStart({
  onSuccess,
  openShiftId,
  onRequestEndShift,
  onLogout,
  initialError,
}) {
  const [err, setErr] = useState(initialError || "");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialError) setErr(initialError);
  }, [initialError]);

  async function startShift(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.post(
        "/api/shifts/start",
        {},
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      await onSuccess();
    } catch (e2) {
      const status = e2.response?.status;
      const apiErr = e2.response?.data?.error;
      if (status === 409) {
        const shift = await onSuccess?.();
        if (!shift) setErr(apiErr || "لديك وردية مفتوحة بالفعل");
      } else if (status === 401) {
        setErr("انتهت الجلسة. سجّل الدخول مرة أخرى.");
      } else if (status === 0 || e2.message?.includes("الاتصال")) {
        setErr("تعذّر الاتصال بالخادم. شغّل الخادم: npm run start من مجلد المشروع.");
      } else {
        setErr(apiErr || e2.message || "فشل بدء الوردية");
      }
    } finally {
      setLoading(false);
    }
  }

  if (openShiftId) {
    return (
      <div className="shift-modal-card" dir="rtl" lang="ar">
        <p className="shift-modal-lead">لديك وردية مفتوحة (رقم {openShiftId}).</p>
        {onRequestEndShift ? (
          <button type="button" className="shift-modal-primary" onClick={onRequestEndShift}>
            إغلاق الوردية
          </button>
        ) : null}
        {onLogout ? (
          <button type="button" className="shift-modal-secondary" onClick={onLogout}>
            خروج
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <form className="shift-modal-card" onSubmit={startShift} dir="rtl" lang="ar">
      <h2 className="shift-modal-title">بدء الوردية</h2>
      <p className="shift-modal-hint">اضغط الزر أدناه لبدء وردية جديدة.</p>
      {err ? <div className="shift-modal-err">{err}</div> : null}
      <button type="submit" className="shift-modal-primary" disabled={loading}>
        {loading ? "جاري الحفظ…" : "بدء الوردية"}
      </button>
      {onLogout ? (
        <button type="button" className="shift-modal-secondary" onClick={onLogout} disabled={loading}>
          خروج
        </button>
      ) : null}
    </form>
  );
}
