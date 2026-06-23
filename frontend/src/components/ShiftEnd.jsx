import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;
export const SHIFT_VARIANCE_WARNING = 100;

/**
 * @param {object} props
 * @param {number} props.shiftId
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {() => void} props.onSuccess
 */
export default function ShiftEnd({ shiftId, open, onClose, onSuccess }) {
  const [closingCash, setClosingCash] = useState("");
  const [notes, setNotes] = useState("");
  const [expected, setExpected] = useState(null);
  const [opening, setOpening] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");

  const loadPreview = useCallback(async () => {
    if (!shiftId || !open) return;
    setLoadErr("");
    try {
      const { data } = await api.get(`/api/shifts/${shiftId}`, {
        headers: getAuthHeaders(),
      });
      const exp = data.summary?.expected;
      setExpected(exp != null ? Number(exp) : null);
      setOpening(data.shift?.opening_cash != null ? Number(data.shift.opening_cash) : null);
    } catch (e) {
      setLoadErr(e.response?.data?.error || e.message || "تعذّر تحميل ملخص الوردية");
    }
  }, [shiftId, open]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  async function submitEnd(e) {
    e.preventDefault();
    const v = Number(String(closingCash).replace(",", "."));
    if (Number.isNaN(v) || v < 0) {
      setErr("أدخل مبلغ إغلاق صالح");
      return;
    }
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/end`,
        { closing_cash: v, notes: notes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const var_ = Number(data.variance);
      if (Math.abs(var_) > SHIFT_VARIANCE_WARNING) {
        // still success; user already warned in form if they typed preview
      }
      setClosingCash("");
      setNotes("");
      onSuccess();
      onClose();
    } catch (e2) {
      setErr(e2.response?.data?.error || e2.message || "فشل إغلاق الوردية");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const closingNum = Number(String(closingCash).replace(",", "."));
  const previewVariance =
    !Number.isNaN(closingNum) && expected != null && !Number.isNaN(expected)
      ? round2(closingNum - expected)
      : null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <form className="shift-modal-panel" onSubmit={submitEnd}>
        <h2 className="shift-modal-title">إغلاق الوردية</h2>
        {loadErr ? <div className="shift-modal-err">{loadErr}</div> : null}
        {opening != null ? (
          <p className="shift-modal-meta">افتتاح: {ils(opening)}</p>
        ) : null}
        {expected != null ? (
          <p className="shift-modal-meta">النقد المتوقع حالياً: {ils(expected)}</p>
        ) : null}
        {previewVariance != null && Math.abs(previewVariance) > SHIFT_VARIANCE_WARNING ? (
          <div className="shift-modal-warn">
            تنبيه: فرق أكبر من {ils(SHIFT_VARIANCE_WARNING)} بين العدد والمتوقع (معاينة:{" "}
            {previewVariance >= 0 ? "+" : ""}
            {ils(previewVariance)}).
          </div>
        ) : null}
        <label className="shift-modal-label">
          النقد عند الإغلاق
          <input
            className="shift-modal-input"
            type="number"
            min="0"
            step="0.01"
            value={closingCash}
            onChange={(e) => setClosingCash(e.target.value)}
            required
          />
        </label>
        <label className="shift-modal-label">
          ملاحظات (اختياري)
          <textarea
            className="shift-modal-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </label>
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose} disabled={loading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={loading}>
            {loading ? "جاري الإغلاق…" : "إغلاق الوردية"}
          </button>
        </div>
      </form>
    </div>
  );
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
