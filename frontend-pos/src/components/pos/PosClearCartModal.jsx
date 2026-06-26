import "../ShiftModal.css";

export default function PosClearCartModal({ open, onConfirm, onClose }) {
  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">فاتورة جديدة</h2>
        <p className="shift-modal-meta">هل تريد حذف الفاتورة الحالية وبدء فاتورة جديدة؟</p>
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button type="button" className="shift-modal-primary" onClick={onConfirm}>
            تأكيد
          </button>
        </div>
      </div>
    </div>
  );
}
