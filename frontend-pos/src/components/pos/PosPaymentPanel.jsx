import { POS_SHORTCUTS } from "../../config/posShortcuts";
import { RECEIPT_PRINT_REVISION } from "../../utils/printDocument";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosPaymentPanel({
  subtotal,
  tax,
  discount = 0,
  total,
  error,
  printWarning,
  isLoading,
  canComplete,
  onComplete,
  receiptData,
  onPrintLocal,
  onOpenReceiptTab,
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
        {discount > 0 ? (
          <div className="pos-total-row pos-total-row--discount">
            <span>عرض / خصم</span>
            <span>-{ils(discount)}</span>
          </div>
        ) : null}
        <div className="pos-total-row pos-total-row--grand">
          <span>الإجمالي</span>
          <span className="pos-total-amount">{ils(total)}</span>
        </div>
      </div>

      <div className="pos-pay-actions">
        {error ? <p className="pos-err">{error}</p> : null}
        {printWarning ? <p className="pos-print-warn">{printWarning}</p> : null}

        <button
          type="button"
          className="pos-complete-btn"
          disabled={!canComplete}
          onClick={onComplete}
        >
          {isLoading ? "جاري المعالجة…" : "إتمام البيع"}
        </button>
        <p className="pos-complete-hint">{POS_SHORTCUTS.completeSale.key} — إتمام البيع</p>

        {receiptData?.transaction_id ? (
          <button type="button" className="pos-complete-btn secondary" onClick={onPrintLocal}>
            طباعة الإيصال
          </button>
        ) : null}
        {receiptData?.transaction_id && onOpenReceiptTab ? (
          <button type="button" className="pos-complete-btn secondary" onClick={onOpenReceiptTab}>
            فتح الإيصال للطباعة
          </button>
        ) : null}
        <p className="pos-complete-hint" data-abo-receipt-print-rev={RECEIPT_PRINT_REVISION} dir="ltr">
          {RECEIPT_PRINT_REVISION}
        </p>
      </div>
    </div>
  );
}
