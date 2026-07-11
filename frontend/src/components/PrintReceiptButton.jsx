import { useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { printReceipt } from "../utils/printReceipt";
import "./PrintReceiptButton.css";

export default function PrintReceiptButton({ transactionId }) {
  const [loading, setLoading] = useState(false);

  async function handlePrint() {
    if (!transactionId) return;
    setLoading(true);
    try {
      const { data } = await api.post(
        "/api/print-receipt",
        { transaction_id: transactionId },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      if (data.receipt_html || data.receipt_text) printReceipt(data);
    } catch (e) {
      window.alert(e.response?.data?.error || e.message || "فشلت الطباعة");
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
