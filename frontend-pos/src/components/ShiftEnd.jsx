import { useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./ShiftModal.css";

/**
 * @param {object} props
 * @param {number} props.shiftId
 * @param {number} [props.txCount]
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {() => void} props.onSuccess
 */
export default function ShiftEnd({ shiftId, txCount = 0, open, onClose, onSuccess }) {
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  async function submitEnd(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/end`,
        { notes: notes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setNotes("");
      setSuccessMsg(data.message || "تم إرسال الوردية للمراجعة — سيقوم المدير بعد النقد");
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (e2) {
      setErr(e2.response?.data?.error || e2.message || "فشل إغلاق الوردية");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <form className="shift-modal-panel" onSubmit={submitEnd}>
        <h2 className="shift-modal-title">إنهاء الوردية</h2>
        <p className="shift-modal-meta">عدد المبيعات في هذه الوردية: {txCount}</p>
        <p className="shift-modal-hint">
          سيقوم المدير بعد النقد في الدرج وإغلاق الوردية نهائياً.
        </p>
        <label className="shift-modal-label">
          ملاحظات (اختياري)
          <textarea
            className="shift-modal-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </label>
        {successMsg ? <div className="shift-modal-success">{successMsg}</div> : null}
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose} disabled={loading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={loading || !!successMsg}>
            {loading ? "جاري الإرسال…" : "إنهاء الوردية"}
          </button>
        </div>
      </form>
    </div>
  );
}

export const SHIFT_VARIANCE_WARNING = 100;
