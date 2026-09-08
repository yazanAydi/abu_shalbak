import api from "../apiClient";
import { getAuthHeaders } from "./auth";

const inFlight = new Set();

function normalizeReceiptInput(receiptOrPayload, options = {}) {
  if (typeof receiptOrPayload === "string") {
    return { transactionId: null };
  }
  if (receiptOrPayload && typeof receiptOrPayload === "object") {
    const transactionId = Number(
      receiptOrPayload.transaction_id || receiptOrPayload.transactionId || receiptOrPayload.id
    );
    return {
      transactionId: Number.isFinite(transactionId) && transactionId > 0 ? transactionId : null,
    };
  }
  const fromOptions = Number(options.transactionId);
  return {
    transactionId: Number.isFinite(fromOptions) && fromOptions > 0 ? fromOptions : null,
  };
}

/**
 * Print a sale receipt via the API (Windows printer or host print agent).
 * Never opens a browser print dialog.
 */
export async function printReceipt(receiptOrPayload, options = {}) {
  const { transactionId } = normalizeReceiptInput(receiptOrPayload, options);
  if (!transactionId) {
    window.alert("لا يوجد رقم عملية للطباعة");
    return;
  }
  if (inFlight.has(transactionId)) return;
  inFlight.add(transactionId);

  try {
    await api.post(
      "/api/print-receipt/silent",
      { transaction_id: transactionId },
      { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
    );
  } catch (e) {
    window.alert(e.response?.data?.error || e.message || "فشلت طباعة الإيصال");
  } finally {
    inFlight.delete(transactionId);
  }
}
