function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Open a print dialog with monospaced receipt text (thermal-friendly).
 * @param {string} receiptData plain text
 */
export function printReceipt(receiptData) {
  if (!receiptData) return;
  const w = window.open("", "_blank", "width=420,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة لطباعة الإيصال.");
    return;
  }
  w.document.write(
    `<!DOCTYPE html><html lang="ar"><head><title>إيصال</title></head><body style="margin:0;padding:12px;background:#fff;color:#000">
 <pre style="font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;margin:0">${escapeHtml(
      receiptData
    )}</pre>
    </body></html>`
  );
  w.document.close();
  w.focus();
  w.print();
  w.close();
}
