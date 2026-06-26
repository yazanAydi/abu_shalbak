import "../ShiftModal.css";

export default function PosRestoreConflictModal({ open, onHoldAndRestore, onMerge, onCancel }) {
  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onCancel} aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">فاتورة حالية مفتوحة</h2>
        <p className="shift-modal-meta">يوجد فاتورة حالية مفتوحة، ماذا تريد أن تفعل؟</p>
        <div className="pos-restore-conflict-actions">
          <button type="button" className="shift-modal-primary" onClick={onHoldAndRestore}>
            تعليق الفاتورة الحالية واسترجاع الفاتورة المختارة
          </button>
          <button type="button" className="shift-modal-secondary" onClick={onMerge}>
            دمج الفواتير
          </button>
          <button type="button" className="shift-modal-secondary" onClick={onCancel}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
