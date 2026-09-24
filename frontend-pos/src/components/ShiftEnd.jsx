import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {object} props
 * @param {number} props.shiftId
 * @param {number} [props.txCount]
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {() => void} props.onSuccess
 */
export default function ShiftEnd({ shiftId, txCount = 0, suspendedCount = 0, open, onClose, onSuccess }) {
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (!open || !shiftId) {
      setSummary(null);
      return undefined;
    }
    let cancelled = false;
    api
      .get(`/api/shifts/${shiftId}`, { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) {
          const shift = data?.shift || {};
          const visa = data?.summary?.visa || shift;
          setSummary({
            cash_sales: data?.summary?.cash_sales ?? shift.cash_sales,
            cash_only_sales: data?.summary?.cash_only_sales ?? shift.cash_only_sales,
            mixed_cash_sales: data?.summary?.mixed_cash_sales ?? shift.mixed_cash_sales,
            cash_refunds: data?.summary?.cash_refunds ?? shift.cash_refunds,
            cash_net: data?.summary?.cash_net ?? shift.cash_net,
            tender_total: data?.summary?.tender_total ?? shift.tender_total,
            cash_sales_incomplete: data?.summary?.cash_sales_incomplete ?? shift.cash_sales_incomplete,
            expected_cash: data?.summary?.expected ?? shift.expected_cash,
            customer_collections_total: data?.summary?.customer_collections_total ?? 0,
            customer_cash_debts_total: data?.summary?.customer_cash_debts_total ?? 0,
            supplier_payments_total: data?.summary?.supplier_payments_total ?? 0,
            visa,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, shiftId]);

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
        {suspendedCount > 0 ? (
          <p className="shift-modal-hint shift-modal-warn">
            يوجد {suspendedCount} فاتورة معلقة غير مكتملة — لن تُحسب كمبيعات حتى يتم الدفع.
          </p>
        ) : null}
        {summary ? (
          <div className="shift-modal-meta">
            <div>مبيعات نقدية: {ils(summary.cash_sales ?? 0)}</div>
            {Number(summary.mixed_cash_sales) ? (
              <div>
                منها نقد من دفعات مختلطة: {ils(summary.mixed_cash_sales)} (مشمول في المبيعات النقدية)
              </div>
            ) : null}
            <div>مبيعات فيزا: {ils(summary.visa?.visa_sales ?? 0)}</div>
            <div>
              إجمالي المبيعات النقدية والفيزا:{" "}
              {ils(
                summary.tender_total ??
                  (Number(summary.cash_sales) || 0) + (Number(summary.visa?.visa_sales) || 0)
              )}
            </div>
            <div>مرتجعات نقدية: {ils(summary.cash_refunds ?? 0)}</div>
            <div>مرتجعات الفيزا: {ils(summary.visa?.visa_refunds ?? 0)}</div>
            <div>صافي المبيعات النقدية: {ils(summary.cash_net ?? 0)}</div>
            <div>صافي المبيعات الفيزا: {ils(summary.visa?.visa_net ?? 0)}</div>
            <div>ذمم نقدية للعملاء: {ils(summary.customer_cash_debts_total ?? 0)}</div>
            {Number(summary.customer_collections_total) > 0 ? (
              <div>قبض ذمم سابق — للمراجعة: {ils(summary.customer_collections_total)}</div>
            ) : null}
            <div>دفعات الموردين: {ils(summary.supplier_payments_total ?? 0)}</div>
            {summary.expected_cash != null ? (
              <div>النقد المتوقع في الصندوق: {ils(summary.expected_cash)}</div>
            ) : null}
            <p className="shift-modal-hint">{summary.visa?.visa_note}</p>
            {summary.visa?.visa_incomplete ? (
              <p className="shift-modal-hint">{summary.visa.visa_incomplete_note}</p>
            ) : null}
          </div>
        ) : null}
        <p className="shift-modal-hint">
          سيقوم المدير بعد النقد في الدرج وإغلاق الوردية نهائياً. أرقام الفيزا أعلاه مدفوعات مسجّلة، وليست نقد الدرج.
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
