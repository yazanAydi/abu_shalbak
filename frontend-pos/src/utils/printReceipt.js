import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import {
  fillReceiptPrintTab,
  printHtmlInHiddenIframe,
  RECEIPT_PRINT_REVISION,
  RECEIPT_PRINT_TAB_NAME,
} from "./printDocument";

const inFlight = new Set();

export const STORE_PRINT_UNAVAILABLE_AR =
  "تعذر تجهيز طباعة الإيصال في المتصفح. استخدم إعادة الطباعة لهذه العملية.";

export const RECEIPT_POPUP_BLOCKED_AR = "اسمح بفتح النافذة المنبثقة لفتح الإيصال.";

export { RECEIPT_PRINT_REVISION };

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

function writeTabLoading(tab) {
  const doc = tab?.document;
  if (!doc || typeof doc.write !== "function") return;
  if (typeof doc.open === "function") doc.open();
  doc.write(
    `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title></title></head><body><p>جاري تحميل الإيصال…</p><p dir="ltr">${RECEIPT_PRINT_REVISION}</p></body></html>`
  );
  if (typeof doc.close === "function") doc.close();
}

function escapeTabText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeTabError(tab, message) {
  const doc = tab?.document;
  if (!doc || typeof doc.write !== "function") return;
  if (typeof doc.open === "function") doc.open();
  doc.write(
    `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title></title></head><body><p>${escapeTabText(message || STORE_PRINT_UNAVAILABLE_AR)}</p></body></html>`
  );
  if (typeof doc.close === "function") doc.close();
}

/**
 * Open a top-level tab with the same saved-sale HTML as iframe print.
 * Pass options.tab from window.open in the click handler to avoid the popup blocker.
 * Does not print or close the tab.
 */
export async function openReceiptForPrinting(receiptOrPayload, options = {}) {
  const notify = options.alert !== false;
  const { transactionId, fallbackHtml } = normalizeReceiptInput(receiptOrPayload, options);
  if (!transactionId) {
    const error = "لا يوجد رقم عملية للطباعة";
    if (notify) window.alert(error);
    return { ok: false, error };
  }

  let tab = options.tab;
  if (!tab && typeof window.open === "function") {
    tab = window.open("about:blank", RECEIPT_PRINT_TAB_NAME);
  }
  if (!tab) {
    if (notify) window.alert(RECEIPT_POPUP_BLOCKED_AR);
    return { ok: false, error: RECEIPT_POPUP_BLOCKED_AR, blocked: true };
  }

  writeTabLoading(tab);

  let html;
  try {
    html = await loadSavedSaleHtml(transactionId, fallbackHtml);
  } catch (e) {
    const error = cashierPrintError(e);
    writeTabError(tab, error);
    if (notify) window.alert(error);
    return { ok: false, error };
  }
  if (!html) {
    const error = "تعذر تحميل محتوى الإيصال. استخدم إعادة الطباعة لهذه العملية.";
    writeTabError(tab, error);
    if (notify) window.alert(error);
    return { ok: false, error };
  }

  try {
    const opened = await fillReceiptPrintTab(tab, html);
    if (!opened?.ok) {
      const error = opened?.error || STORE_PRINT_UNAVAILABLE_AR;
      if (notify) window.alert(error);
      return { ok: false, error };
    }
    return { ok: true, opened: true, printTarget: "tab", revision: RECEIPT_PRINT_REVISION };
  } catch (err) {
    const error = err?.message || STORE_PRINT_UNAVAILABLE_AR;
    writeTabError(tab, error);
    if (notify) window.alert(error);
    return { ok: false, error };
  }
}
