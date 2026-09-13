import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { printHtmlInHiddenIframe } from "./printDocument";

const inFlight = new Set();

export const STORE_PRINT_UNAVAILABLE_AR =
  "تعذر تجهيز طباعة الإيصال في المتصفح. استخدم إعادة الطباعة لهذه العملية.";

/** Print dispatch failed after the sale was already saved. Never resubmit checkout. */
export function saleSavedPrintFailedMessage(receiptNumber) {
  const num = receiptNumber != null && String(receiptNumber).trim() !== "" ? String(receiptNumber) : "—";
  return `تم حفظ عملية البيع رقم ${num}، لكن تعذّرت طباعة الإيصال. لا تُعد إدخال البيع.`;
}

function normalizeReceiptInput(receiptOrPayload, options = {}) {
  if (typeof receiptOrPayload === "string") {
    return { transactionId: null, fallbackHtml: null };
  }
  if (receiptOrPayload && typeof receiptOrPayload === "object") {
    const transactionId = Number(
      receiptOrPayload.transaction_id || receiptOrPayload.transactionId || receiptOrPayload.id
    );
    return {
      transactionId: Number.isFinite(transactionId) && transactionId > 0 ? transactionId : null,
      fallbackHtml: receiptOrPayload.receipt_html || null,
    };
  }
  const fromOptions = Number(options.transactionId);
  return {
    transactionId: Number.isFinite(fromOptions) && fromOptions > 0 ? fromOptions : null,
    fallbackHtml: options.html || null,
  };
}

function authHeaders() {
  return { ...getAuthHeaders(), "Content-Type": "application/json" };
}

function receiptHtmlFromResponse(res) {
  const payload = res?.data?.data ?? res?.data;
  return payload?.receipt_html || null;
}

function cashierPrintError(err) {
  return err?.response?.data?.error || err?.message || STORE_PRINT_UNAVAILABLE_AR;
}

async function loadSavedSaleHtml(transactionId, fallbackHtml) {
  try {
    const htmlRes = await api.post(
      "/api/print-receipt",
      { transaction_id: transactionId },
      { headers: authHeaders() }
    );
    return receiptHtmlFromResponse(htmlRes) || fallbackHtml || null;
  } catch (err) {
    if (fallbackHtml) return fallbackHtml;
    throw err;
  }
}

/**
 * Print a saved sale through the cashier browser.
 * Fetches the stored receipt HTML, then prints in a hidden iframe.
     * Does not call the Windows print agent or its silent HTTP path.
     * ok means the browser print() call was dispatched, not that paper printed.
 */
export async function printReceipt(receiptOrPayload, options = {}) {
  const notify = options.alert !== false;
  const { transactionId, fallbackHtml } = normalizeReceiptInput(receiptOrPayload, options);
  if (!transactionId) {
    const error = "لا يوجد رقم عملية للطباعة";
    if (notify) window.alert(error);
    return { ok: false, error };
  }
  if (inFlight.has(transactionId)) return { ok: true, skipped: true };
  inFlight.add(transactionId);

  try {
    let html;
    try {
      html = await loadSavedSaleHtml(transactionId, fallbackHtml);
    } catch (e) {
      const error = cashierPrintError(e);
      if (notify) window.alert(error);
      return { ok: false, error };
    }
    if (!html) {
      const error = "تعذر تحميل محتوى الإيصال. استخدم إعادة الطباعة لهذه العملية.";
      if (notify) window.alert(error);
      return { ok: false, error };
    }
    const printed = await printHtmlInHiddenIframe(html);
    if (!printed?.ok) {
      const error = printed?.error || STORE_PRINT_UNAVAILABLE_AR;
      if (notify) window.alert(error);
      return { ok: false, error };
    }
    return { ok: true, dispatched: true };
  } finally {
    inFlight.delete(transactionId);
  }
}
