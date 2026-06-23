function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Print receipt text without blocking the caller (thermal-friendly).
 * Uses a hidden iframe and defers the print dialog to the next task.
 * @param {string} receiptData plain text
 */
export function printReceipt(receiptData) {
  if (!receiptData) return;

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
    win.document.write(
      `<!DOCTYPE html><html lang="ar"><head><title>إيصال</title></head><body style="margin:0;padding:12px;background:#fff;color:#000">
 <pre style="font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;margin:0">${escapeHtml(
        receiptData
      )}</pre>
    </body></html>`
    );
    win.document.close();

    const cleanup = () => {
      iframe.remove();
    };

    win.onafterprint = cleanup;
    win.focus();
    win.print();
    setTimeout(cleanup, 5000);
  }, 0);
}
