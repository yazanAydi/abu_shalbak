import { POS_SHORTCUTS } from "../../config/posShortcuts";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosPaymentPanel({
  subtotal,
  tax,
  total,
  error,
  isLoading,
  canComplete,
  onComplete,
  receiptData,
  onPrintLocal,
}) {
  return (
    <div className="pos-payment-panel">
      <div className="pos-totals">
        <div className="pos-total-row">
          <span>فرعي</span>
          <span>{ils(subtotal)}</span>
        </div>
        {tax > 0 ? (
          <div className="pos-total-row">
            <span>ضريبة</span>
            <span>{ils(tax)}</span>
          </div>
        ) : null}
        <div className="pos-total-row pos-total-row--grand">
          <span>الإجمالي</span>
          <span>{ils(total)}</span>
        </div>
      </div>

      <div className="pos-pay-actions">
        {error ? <p className="pos-err">{error}</p> : null}

        <button
          type="button"
          className="pos-complete-btn"
          disabled={!canComplete}
          onClick={onComplete}
        >
          {isLoading ? "جاري المعالجة…" : "إتمام البيع"}
        </button>
        <p className="pos-complete-hint">{POS_SHORTCUTS.completeSale.key} — إتمام البيع</p>

        {receiptData?.receipt_text ? (
          <button type="button" className="pos-complete-btn secondary" onClick={onPrintLocal}>
            طباعة الإيصال
          </button>
        ) : null}
      </div>
    </div>
  );
}
