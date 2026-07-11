import { useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import PosApprovalWaitingModal, { approvalIls } from "./PosApprovalWaitingModal";
import "../ShiftModal.css";

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 */
export default function PosAdvanceRequestModal({ open, onClose }) {
  const [employeeName, setEmployeeName] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [waitingId, setWaitingId] = useState(null);

  function resetForm() {
    setEmployeeName("");
    setAmount("");
    setNotes("");
    setError("");
    setWaitingId(null);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const amt = Number(amount);
    if (!employeeName.trim()) {
      setError("اسم الموظف مطلوب");
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("أدخل مبلغاً صالحاً");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post(
        "/api/advance-requests",
        {
          employee_name: employeeName.trim(),
          amount: amt,
          notes: notes.trim() || null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      setWaitingId(payload.request_id);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "فشل إرسال الطلب");
    } finally {
      setLoading(false);
    }
  }

  if (waitingId) {
    return (
      <PosApprovalWaitingModal
        open={open}
        requestId={waitingId}
        apiPath="/api/advance-requests"
        titlePrefix="طلب سلف"
        statusLabels={{
          pending: "بانتظار موافقة المدير…",
          approved: "تمت الموافقة على السلف",
          rejected: "تم رفض طلب السلف",
          expired: "انتهت صلاحية الطلب",
        }}
        detailLine={(d) =>
          d?.employee_name && d?.amount != null
            ? `${d.employee_name} — ${approvalIls(d.amount)}`
            : null
        }
        onClose={handleClose}
      />
    );
  }

  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={handleClose} aria-hidden />
      <form className="shift-modal-panel shift-modal-panel--form" onSubmit={handleSubmit}>
        <h2 className="shift-modal-title">طلب سلف</h2>
        <p className="shift-modal-lead">أدخل اسم الموظف والمبلغ — يُرسل للمدير للموافقة عبر تيليجرام أو لوحة الإدارة.</p>

        <label className="shift-modal-label">
          اسم الموظف
          <input
            className="shift-modal-input"
            type="text"
            value={employeeName}
            onChange={(e) => setEmployeeName(e.target.value)}
            maxLength={100}
            placeholder="مثال: أحمد"
            autoFocus
          />
        </label>

        <label className="shift-modal-label">
          المبلغ (₪)
          <input
            className="shift-modal-input"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>

        <label className="shift-modal-label">
          ملاحظات (اختياري)
          <input
            className="shift-modal-input"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder="سبب السلفة أو ملاحظة للمدير"
          />
        </label>

        {error ? <div className="shift-modal-err">{error}</div> : null}

        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={handleClose} disabled={loading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={loading}>
            {loading ? "جاري الإرسال…" : "إرسال للموافقة"}
          </button>
        </div>
      </form>
    </div>
  );
}
