import RefundPanel from "../RefundPanel";

export default function PosRefundModal({ open, onClose, shiftReady, shiftId, onRefundSuccess }) {
  if (!open) return null;

  return (
    <div className="pos-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="refund-title">
      <div className="pos-modal pos-modal--wide" dir="rtl" lang="ar">
        <div className="pos-modal-head">
          <h2 id="refund-title">استرجاع</h2>
          <button type="button" className="pos-modal-close" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </div>
        <RefundPanel
          shiftReady={shiftReady}
          shiftId={shiftId}
          onRefundSuccess={() => {
            onRefundSuccess?.();
            onClose();
          }}
        />
      </div>
    </div>
  );
}
