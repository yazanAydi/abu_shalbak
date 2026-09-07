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

function browserPrint(html) {
  const w = window.open("", "_blank", "width=420,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة لطباعة الإيصال.");
    return;
  }
  try {
    w.opener = null;
  } catch {
    /* ignore */
  }
  w.document.write(html);
  w.document.close();
  const close = () => {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  };
  w.addEventListener("afterprint", close, { once: true });
  w.setTimeout(() => {
    w.focus();
    w.print();
  }, 50);
}

/**
 * Print a sale receipt via the Windows API (default printer, no browser dialog).
 * On 501 SILENT_PRINT_UNSUPPORTED, falls back to a browser print window.
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
    if (e.response?.status === 501) {
      try {
        const htmlRes = await api.post(
          "/api/print-receipt",
          { transaction_id: transactionId },
          { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
        );
        const payload = htmlRes.data?.data ?? htmlRes.data;
        const html = payload?.receipt_html;
        if (html) {
          browserPrint(html);
          return;
        }
      } catch (fallbackErr) {
        window.alert(
          fallbackErr.response?.data?.error || fallbackErr.message || "فشلت طباعة الإيصال"
        );
        return;
      }
    }
    window.alert(e.response?.data?.error || e.message || "فشلت طباعة الإيصال");
  } finally {
    inFlight.delete(transactionId);
  }
}
