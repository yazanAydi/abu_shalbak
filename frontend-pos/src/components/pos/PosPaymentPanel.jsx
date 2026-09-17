import { POS_SHORTCUTS } from "../../config/posShortcuts";
import { RECEIPT_PRINT_REVISION } from "../../utils/printDocument";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosPaymentPanel({
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
  children,
}) {
  return (
    <div className="pos-payment-panel" data-abo-receipt-print-rev={RECEIPT_PRINT_REVISION}>
      <div className="pos-totals">
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

      {children}

      <div className="pos-pay-actions">
        {error ? <p className="pos-err">{error}</p> : null}
        {printWarning ? <p className="pos-print-warn">{printWarning}</p> : null}

        <button
          type="button"
          className="pos-complete-btn"
          disabled={!canComplete}
          onClick={onComplete}
        >
          <span>{isLoading ? "جاري المعالجة…" : "إتمام البيع"}</span>
          <kbd className="pos-complete-key">{POS_SHORTCUTS.completeSale.key}</kbd>
        </button>

        {receiptData?.transaction_id ? (
          <div className="pos-reprint-actions">
            <button type="button" className="pos-complete-btn secondary" onClick={onPrintLocal}>
              طباعة الإيصال
            </button>
            {onOpenReceiptTab ? (
              <button type="button" className="pos-complete-btn secondary" onClick={onOpenReceiptTab}>
                فتح الإيصال للطباعة
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
