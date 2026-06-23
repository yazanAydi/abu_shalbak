import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { formatRefundReason, ils, statusLabelAr } from "../utils/refundHelpers";
import "./RefundsManagement.css";

const PM = { cash: "نقد", visa: "بطاقة" };

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {number | null} props.refundId
 * @param {() => void} props.onClose
 * @param {() => void} props.onUpdated
 * @param {(id: number) => void} props.onPrint
 */
export default function RefundDetailsModal({ open, refundId, onClose, onUpdated, onPrint }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!refundId || !open) return;
    setErr("");
    setLoading(true);
    try {
      const { data: d } = await api.get(`/api/refunds/${refundId}`, { headers: getAuthHeaders() });
      setData(d);
      setReviewNotes(d?.refund?.review_notes || "");
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل التحميل");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [refundId, open]);

  useEffect(() => {
    load();
  }, [load]);

  async function applyStatus(status) {
    if (!refundId) return;
    setActing(true);
    setErr("");
    try {
      await api.put(
        `/api/refunds/${refundId}`,
        { status, review_notes: reviewNotes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      onUpdated();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setActing(false);
    }
  }

  if (!open) return null;

  const refund = data?.refund;
  const items = data?.items_refunded || [];
  const st = statusLabelAr(refund || {});

  return (
    <div className="rf-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="rf-modal-backdrop" onClick={onClose} />
      <div className="rf-modal-panel">
        <div className="rf-modal-head">
          <h2>تفاصيل الاسترجاع</h2>
          <button type="button" className="rf-modal-x" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </div>

        {loading ? <p>جاري التحميل…</p> : null}
        {err ? <div className="rf-modal-err">{err}</div> : null}

        {refund ? (
          <>
            <p className="rf-modal-meta">
              رقم الفاتورة الأصلية: <strong>#{refund.original_transaction_id}</strong>
              <br />
              الكاشير: <strong>{refund.cashier_username}</strong>
              <br />
              التاريخ: {refund.created_at?.replace("T", " ").slice(0, 16)}
              <br />
              طريقة الرد للزبون: {PM[refund.payment_method] || refund.payment_method}
            </p>

            <h3 className="rf-modal-h3">العناصر المسترجعة</h3>
            <table className="rf-modal-table">
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>الكمية</th>
                  <th>السعر</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.product_name}</td>
                    <td>{it.quantity}</td>
                    <td>{ils(it.price)}</td>
                    <td>{ils(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="rf-modal-total">
              الإجمالي: <strong>{ils(refund.total)}</strong>
            </p>

            <p>
              <strong>سبب الاسترجاع:</strong> {formatRefundReason(refund.reason)}
            </p>

            <label className="rf-modal-notes">
              ملاحظات المراجعة
              <textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                rows={2}
                disabled={refund.status !== "pending"}
              />
            </label>

            <div className="rf-modal-status">
              الحالة:{" "}
              <span className={`rf-status rf-status--${st.tone}`}>
                {st.icon} {st.text}
              </span>
            </div>

            <h3 className="rf-modal-h3">سجل الحالة</h3>
            <ul className="rf-history">
              <li>
                <strong>أُنشئ:</strong> {refund.created_at} — {refund.cashier_username}
              </li>
              {refund.status === "approved" && refund.approved_at ? (
                <li>
                  <strong>وافق:</strong> {refund.approved_at} — {refund.approved_by_name || "—"}
                </li>
              ) : null}
              {refund.status === "rejected" && refund.rejected_at ? (
                <li>
                  <strong>رُفض:</strong> {refund.rejected_at} — {refund.rejected_by_name || "—"}
                </li>
              ) : null}
              {refund.status === "pending" ? (
                <li>
                  <em>في انتظار قرار المسؤول</em>
                </li>
              ) : null}
            </ul>

            <div className="rf-modal-actions">
              {refund.status === "pending" ? (
                <>
                  <button
                    type="button"
                    className="rf-fbtn rf-fbtn--success"
                    disabled={acting}
                    onClick={() => applyStatus("approved")}
                  >
                    ✓ الموافقة
                  </button>
                  <button
                    type="button"
                    className="rf-fbtn rf-fbtn--danger"
                    disabled={acting}
                    onClick={() => applyStatus("rejected")}
                  >
                    ✗ الرفض
                  </button>
                </>
              ) : null}
              <button type="button" className="rf-fbtn rf-fbtn--primary" onClick={() => onPrint(refundId)}>
                🖨️ طباعة
              </button>
              <button type="button" className="rf-fbtn" onClick={onClose}>
                إغلاق
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
