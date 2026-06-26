import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function formatTime(createdAt) {
  if (!createdAt) return "";
  const d = new Date(String(createdAt).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return String(createdAt).slice(11, 16);
  return d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

export default function PosSuspendedSalesModal({
  open,
  sales,
  onClose,
  onRestore,
  onDelete,
  onViewDetails,
  deleteConfirmId,
  onConfirmDelete,
  onCancelDelete,
}) {
  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel pos-modal-panel--wide">
        <h2 className="shift-modal-title">الفواتير المعلقة</h2>
        {sales.length === 0 ? (
          <p className="shift-modal-meta">لا توجد فواتير معلقة في هذه الوردية.</p>
        ) : (
          <ul className="pos-suspended-list">
            {sales.map((sale) => (
              <li key={sale.id} className="pos-suspended-item">
                <div className="pos-suspended-item-head">
                  <strong>فاتورة معلقة #{sale.id}</strong>
                  <span className="pos-suspended-time">{formatTime(sale.created_at)}</span>
                </div>
                <div className="pos-suspended-item-meta">
                  <span>{sale.cashier_name}</span>
                  <span>{Math.round(Number(sale.item_count))} أصناف</span>
                  <span>{ils(sale.total)}</span>
                </div>
                {sale.note ? (
                  <p className="pos-suspended-note">ملاحظة: {sale.note}</p>
                ) : null}
                {deleteConfirmId === sale.id ? (
                  <div className="pos-suspended-delete-confirm">
                    <p>هل أنت متأكد من حذف هذه الفاتورة المعلقة؟</p>
                    <div className="shift-modal-actions">
                      <button
                        type="button"
                        className="shift-modal-secondary"
                        onClick={onCancelDelete}
                      >
                        إلغاء
                      </button>
                      <button
                        type="button"
                        className="shift-modal-primary"
                        onClick={() => onConfirmDelete(sale.id)}
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="pos-suspended-actions">
                    <button type="button" className="shift-modal-primary" onClick={() => onRestore(sale.id)}>
                      استرجاع
                    </button>
                    <button
                      type="button"
                      className="shift-modal-secondary"
                      onClick={() => onViewDetails(sale.id)}
                    >
                      عرض التفاصيل
                    </button>
                    <button
                      type="button"
                      className="shift-modal-secondary"
                      onClick={() => onDelete(sale.id)}
                    >
                      حذف
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
