import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosSuspendedDetailModal({ open, detail, onClose }) {
  if (!open || !detail) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel pos-modal-panel--wide">
        <h2 className="shift-modal-title">تفاصيل فاتورة معلقة #{detail.id}</h2>
        {detail.note ? <p className="shift-modal-meta">ملاحظة: {detail.note}</p> : null}
        <table className="pos-suspended-detail-table">
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الكمية</th>
              <th>السعر</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {(detail.items || []).map((it) => (
              <tr key={it.id}>
                <td>
                  {it.product_name_snapshot}
                  {it.unit_name_snapshot ? ` (${it.unit_name_snapshot})` : ""}
                </td>
                <td>{it.quantity}</td>
                <td>{ils(it.unit_price_snapshot)}</td>
                <td>{ils(it.total_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="shift-modal-meta">
          الإجمالي: {ils(detail.total)} — الكاشير: {detail.cashier_name}
        </p>
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
