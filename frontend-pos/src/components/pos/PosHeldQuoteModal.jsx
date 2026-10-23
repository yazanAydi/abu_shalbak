import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosHeldQuoteModal({
  open,
  savedDiscount = 0,
  savedPayable = 0,
  currentDiscount = 0,
  currentPayable = 0,
  confirming = false,
  onConfirm,
  onDismiss,
}) {
  if (!open) return null;
  const changed = Number(savedPayable) !== Number(currentPayable);

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onDismiss} aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">مراجعة خصم الفاتورة المعلقة</h2>
        {changed ? (
          <p className="shift-modal-meta">
            الخصم المحفوظ {ils(savedDiscount)} يجعل الإجمالي {ils(savedPayable)}. حُسب هذا الخصم بدون وحدة البيع، ولن يُحصَّل.
          </p>
        ) : (
          <p className="shift-modal-meta">
            الخصم المحفوظ {ils(savedDiscount)} يطابق العرض الحالي.
          </p>
        )}
        <p className="shift-modal-meta">
          العرض الحالي يخصم {ils(currentDiscount)} والإجمالي المستحق {ils(currentPayable)}. راجع هذا المبلغ قبل الدفع.
        </p>
        <div className="pos-restore-conflict-actions">
          <button type="button" className="shift-modal-primary" onClick={onConfirm} disabled={confirming}>
            {confirming ? "جاري التحديث…" : "اعتماد المبلغ الحالي"}
          </button>
          <button type="button" className="shift-modal-secondary" onClick={onDismiss} disabled={confirming}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
