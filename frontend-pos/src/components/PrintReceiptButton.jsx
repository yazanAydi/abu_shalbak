import { useState } from "react";
import { openReceiptForPrinting, printReceipt } from "../utils/printReceipt";
import { RECEIPT_PRINT_TAB_NAME } from "../utils/printDocument";
import "./PrintReceiptButton.css";

export default function PrintReceiptButton({ transactionId }) {
  const [loading, setLoading] = useState(false);

  async function handlePrint() {
    if (!transactionId) return;
    setLoading(true);
    try {
      await printReceipt({ transaction_id: transactionId });
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenTab() {
    if (!transactionId) return;
    const tab = typeof window.open === "function" ? window.open("about:blank", RECEIPT_PRINT_TAB_NAME) : null;
    setLoading(true);
    try {
      await openReceiptForPrinting({ transaction_id: transactionId }, { tab });
    } finally {
      setLoading(false);
    }
  }

  if (!transactionId) return null;

  return (
    <div className="print-rcpt-actions">
      <button
        type="button"
        className="print-rcpt-btn"
        onClick={handlePrint}
        disabled={loading}
      >
        {loading ? "…" : "طباعة الإيصال"}
      </button>
      <button
        type="button"
        className="print-rcpt-btn print-rcpt-btn--diag"
        onClick={handleOpenTab}
        disabled={loading}
      >
        فتح الإيصال للطباعة
      </button>
    </div>
  );
}
