import { useEffect, useState } from "react";
import QtyStepper from "../QtyStepper";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {number} props.total
 * @param {boolean} props.isLoading
 * @param {() => void} props.onClose
 * @param {(amountTendered: number) => void} props.onConfirm
 */
export default function PosCashChangeModal({ open, total, isLoading, onClose, onConfirm }) {
  const [amountTendered, setAmountTendered] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setAmountTendered("");
      setErr("");
    }
  }, [open]);

  if (!open) return null;

  const tenderedNum = Number(String(amountTendered).replace(",", "."));
  const changeDue =
    amountTendered !== "" && !Number.isNaN(tenderedNum)
      ? Math.max(0, round2(tenderedNum - total))
      : null;

  function handleSubmit(e) {
    e.preventDefault();
    if (Number.isNaN(tenderedNum) || tenderedNum < total) {
      setErr("المبلغ المستلم يجب أن يكون أكبر من أو يساوي الإجمالي");
      return;
    }
    setErr("");
    onConfirm(tenderedNum);
  }

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <form className="shift-modal-panel" onSubmit={handleSubmit}>
        <h2 className="shift-modal-title">دفع نقدي</h2>
        <p className="shift-modal-meta">الإجمالي: {ils(total)}</p>
        <label className="shift-modal-label">
          المستلم
          <QtyStepper
            className="shift-modal-input"
            min={0}
            precision={2}
            value={amountTendered}
            onChange={(e) => setAmountTendered(e.target.value)}
            placeholder="0.00"
            autoFocus
          />
        </label>
        <label className="shift-modal-label">
          الباقي
          <input
            className="shift-modal-input shift-modal-input--readonly"
            type="text"
            readOnly
            value={changeDue != null ? ils(changeDue) : "—"}
            tabIndex={-1}
          />
        </label>
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose} disabled={isLoading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={isLoading}>
            تأكيد
          </button>
        </div>
      </form>
    </div>
  );
}
