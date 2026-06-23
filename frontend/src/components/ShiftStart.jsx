import { useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {object} props
 * @param {() => void} props.onSuccess — after shift started; parent refetches current shift
 * @param {number | null} props.openShiftId — if set, show open shift summary + end button
 * @param {() => void} [props.onRequestEndShift]
 */
export default function ShiftStart({ onSuccess, openShiftId, onRequestEndShift }) {
  const [openingCash, setOpeningCash] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function startShift(e) {
    e.preventDefault();
    const v = Number(String(openingCash).replace(",", "."));
    if (Number.isNaN(v) || v < 0) {
      setErr("أدخل مبلغ افتتاح صالح");
      return;
    }
    setErr("");
    setLoading(true);
    try {
      await api.post(
        "/api/shifts/start",
        { opening_cash: v },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setOpeningCash("");
      onSuccess();
    } catch (e2) {
      const status = e2.response?.status;
      const apiErr = e2.response?.data?.error;
      if (status === 401) {
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
      </div>
    );
  }

  return (
    <form className="shift-modal-card" onSubmit={startShift} dir="rtl" lang="ar">
      <h2 className="shift-modal-title">بدء الوردية</h2>
      <label className="shift-modal-label">
        النقد عند الافتتاح
        <input
          className="shift-modal-input"
          type="number"
          min="0"
          step="0.01"
          value={openingCash}
          onChange={(e) => setOpeningCash(e.target.value)}
          placeholder="0.00"
          autoFocus
        />
      </label>
      {err ? <div className="shift-modal-err">{err}</div> : null}
      <button type="submit" className="shift-modal-primary" disabled={loading}>
        {loading ? "جاري الحفظ…" : "بدء الوردية"}
      </button>
      <p className="shift-modal-hint">مثال: {ils(100)} — أدخل المبلغ الفعلي في الدرج.</p>
    </form>
  );
}
