import { useState } from "react";
import { printReceipt } from "../utils/printReceipt";
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

  if (!transactionId) return null;

  return (
    <button
      type="button"
      className="print-rcpt-btn"
      onClick={handlePrint}
      disabled={loading}
    >
      {loading ? "…" : "طباعة الإيصال"}
    </button>
  );
}
