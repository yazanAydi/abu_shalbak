import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { printDocumentWhenReady } from "./printDocument";
import { resolveStoreLogoUrl } from "./storeBranding";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function injectFrontendLogo(html, logoUrl) {
  const logoSrc = resolveStoreLogoUrl(logoUrl);
  if (!logoSrc || !html) return html;
  const logoBlock = `<div class="logo-wrap" style="text-align:center;margin-bottom:8px"><img src="${escapeHtml(logoSrc)}" alt="" style="max-width:180px;max-height:100px;object-fit:contain" /></div>`;
  if (html.includes('class="logo-wrap"')) {
    return html.replace(/<div class="logo-wrap">[\s\S]*?<\/div>/, logoBlock);
  }
  return html.replace(/<div class="receipt">/, `<div class="receipt">${logoBlock}`);
}

function normalizeReceiptInput(receiptOrPayload, options = {}) {
  if (typeof receiptOrPayload === "string") {
    return { text: receiptOrPayload, html: options.html || null, transactionId: null };
  }
  if (receiptOrPayload && typeof receiptOrPayload === "object") {
    const transactionId = Number(
      receiptOrPayload.transaction_id || receiptOrPayload.transactionId || receiptOrPayload.id
    );
    return {
      text: receiptOrPayload.receipt_text || null,
      html: receiptOrPayload.receipt_html || options.html || null,
      transactionId: Number.isFinite(transactionId) && transactionId > 0 ? transactionId : null,
    };
  }
  return { text: null, html: options.html || null, transactionId: null };
}

function browserPrint(text, html, options = {}) {
  setTimeout(() => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "receipt-print";
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
    document.body.appendChild(iframe);

    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      return;
    }

    win.document.open();
    if (html) {
      win.document.write(injectFrontendLogo(html, options.logoUrl));
    } else {
      const logoSrc = resolveStoreLogoUrl(options.logoUrl);
      const logoHtml = logoSrc
        ? `<div style="text-align:center;margin-bottom:8px"><img src="${escapeHtml(logoSrc)}" alt="" style="display:inline-block;max-width:180px;max-height:100px;object-fit:contain" /></div>`
        : "";
      win.document.write(
        `<!DOCTYPE html><html lang="ar-u-nu-latn" dir="rtl"><head><title>إيصال</title><style>html{-webkit-locale:"en";font-language-override:"eng";font-feature-settings:"locl" 0}</style></head><body style="margin:0;padding:12px;background:#fff;color:#000;display:flex;justify-content:center"><div style="max-width:384px;width:100%">${logoHtml}<pre style="font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre;margin:0">${escapeHtml(text)}</pre></div></body></html>`
      );
    }
    win.document.close();

    const cleanup = () => {
      iframe.remove();
    };

    win.onafterprint = cleanup;
    printDocumentWhenReady(win.document, { onAfterPrint: cleanup });
    setTimeout(cleanup, 15000);
  }, 0);
}

/**
 * Print a sale receipt. On Windows (API on the cashier PC) this sends the job
 * to the default printer with no Chrome dialog. Browser print is only used when
 * the server cannot silent-print (Linux/Docker).
 * @param {string|{ receipt_text?: string, receipt_html?: string, transaction_id?: number }} receiptOrPayload
 * @param {{ logoUrl?: string, html?: string }} [options]
 */
export async function printReceipt(receiptOrPayload, options = {}) {
  const { text, html, transactionId } = normalizeReceiptInput(receiptOrPayload, options);
  if (!html && !text) return;

  if (transactionId) {
    try {
      await api.post(
        "/api/print-receipt/silent",
        { transaction_id: transactionId },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      return;
    } catch (e) {
      if (e.response?.status === 501) {
        browserPrint(text, html, options);
        return;
      }
      window.alert(e.response?.data?.error || e.message || "فشلت طباعة الإيصال");
      return;
    }
  }

  browserPrint(text, html, options);
}
