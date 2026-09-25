import { useEffect, useRef } from "react";
import "../ShiftModal.css";

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {boolean} [props.cartDirty]
 * @param {() => void} props.onLogout
 * @param {() => void} props.onEndShift
 * @param {() => void} props.onCancel
 */
export default function PosLeaveChoiceModal({
  open,
  cartDirty = false,
  onLogout,
  onEndShift,
  onCancel,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    function onKey(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="shift-modal-overlay pos-leave-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-leave-title"
      dir="rtl"
      lang="ar"
    >
      <div className="shift-modal-backdrop" onClick={onCancel} aria-hidden />
      <div className="shift-modal-panel" ref={panelRef} tabIndex={-1}>
        <h2 id="pos-leave-title" className="shift-modal-title">
          إغلاق النافذة
        </h2>
        <p className="shift-modal-meta">هل تريد تسجيل الخروج أم إنهاء الوردية؟</p>
        {cartDirty ? (
          <p className="shift-modal-hint shift-modal-warn">
            يوجد أصناف في الفاتورة الحالية وستُفقد.
          </p>
        ) : null}
        <div className="shift-modal-actions shift-modal-actions--stack">
          <button type="button" className="shift-modal-secondary" onClick={onLogout}>
            تسجيل الخروج
          </button>
          <button type="button" className="shift-modal-primary" onClick={onEndShift}>
            إنهاء الوردية
          </button>
          <button type="button" className="shift-modal-secondary" onClick={onCancel}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
