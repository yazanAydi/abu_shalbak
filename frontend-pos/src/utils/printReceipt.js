import { resolveStoreLogoUrl } from "./storeBranding";
import { printDocumentWhenReady } from "./printDocument";

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
    return { text: receiptOrPayload, html: options.html || null };
  }
  if (receiptOrPayload && typeof receiptOrPayload === "object") {
    return {
      text: receiptOrPayload.receipt_text || null,
      html: receiptOrPayload.receipt_html || options.html || null,
    };
  }
  return { text: null, html: options.html || null };
}

/**
 * Print receipt without blocking the caller (thermal-friendly).
 * @param {string|{ receipt_text?: string, receipt_html?: string }} receiptOrPayload
 * @param {{ logoUrl?: string, html?: string }} [options]
 */
export function printReceipt(receiptOrPayload, options = {}) {
  const { text, html } = normalizeReceiptInput(receiptOrPayload, options);
  if (!html && !text) return;

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
        `<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>إيصال</title></head><body style="margin:0;padding:12px;background:#fff;color:#000;display:flex;justify-content:center"><div style="max-width:384px;width:100%">${logoHtml}<pre style="font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre;margin:0">${escapeHtml(text)}</pre></div></body></html>`
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
