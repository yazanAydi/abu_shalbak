/**
 * Browser print helpers.
 * Receipts use a hidden iframe. Reports keep the existing print-window path
 * (A4) and must not be forced into thermal page size.
 *
 * CSS `size: 80mm` (one length) is a square page, not a thermal roll.
 * Do not use `size: 80mm auto` — Chromium does not treat that as variable-length paper.
 */

export const RECEIPT_PRINT_IFRAME_ID = "abo-pos-receipt-print";
export const PRINT_IFRAME_CLEANUP_MS = 750;
export const RECEIPT_PRINT_MAX_MM = 400;
export const RECEIPT_PRINT_MIN_MM = 20;
export const RECEIPT_PRINT_BOTTOM_MM = 5;

let iframePrintTail = Promise.resolve();

function waitImages(doc) {
  const images = Array.from(doc.images || []);
  const pending = images.filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return Promise.all(
    pending.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        })
    )
  );
}

function waitFonts(doc) {
  const ready = doc.fonts?.ready;
  if (ready && typeof ready.then === "function") {
    return ready.catch(() => {});
  }
  return Promise.resolve();
}

function waitReadyState(doc) {
  if (!doc) return Promise.resolve();
  if (doc.readyState === "complete" || doc.readyState === "interactive") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    doc.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

function waitAnimationFrame(win) {
  if (win && typeof win.requestAnimationFrame === "function") {
    return new Promise((resolve) => {
      win.requestAnimationFrame(() => resolve());
    });
  }
  return Promise.resolve();
}

/**
 * Wait until the print document, fonts, and images are ready.
 * @param {Document} doc
 * @param {number} [timeoutMs]
 */
export function waitForPrintableDocument(doc, timeoutMs = 8000) {
  if (!doc) return Promise.resolve();
  const work = waitReadyState(doc)
    .then(() => waitFonts(doc))
    .then(() => waitImages(doc))
    .then(() => waitAnimationFrame(doc.defaultView));
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
  return Promise.race([work, timeout]);
}

function attachAfterPrint(win, finish) {
  if (!win) return;
  if (typeof win.addEventListener === "function") {
    win.addEventListener("afterprint", finish, { once: true });
  } else {
    win.onafterprint = finish;
  }
  try {
    const mq = win.matchMedia?.("print");
    if (mq && typeof mq.addEventListener === "function") {
      const onChange = (e) => {
        if (!e.matches) {
          mq.removeEventListener("change", onChange);
          finish();
        }
      };
      mq.addEventListener("change", onChange);
    }
  } catch {
    /* matchMedia is optional */
  }
}

/**
 * Wait for images/fonts, then open the print dialog.
 * afterprint is a dialog-lifecycle signal, not proof that paper printed.
 * @param {Document} doc
 * @param {{ onAfterPrint?: () => void }} [opts]
 */
export function printDocumentWhenReady(doc, { onAfterPrint } = {}) {
  const win = doc?.defaultView;
  if (!win) {
    onAfterPrint?.();
    return;
  }

  waitForPrintableDocument(doc).then(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onAfterPrint?.();
    };
    attachAfterPrint(win, finish);
    try {
      win.focus();
      win.print();
    } catch {
      finish();
      return;
    }
    if (typeof win.setTimeout === "function") {
      win.setTimeout(finish, 4000);
    } else {
      setTimeout(finish, 4000);
    }
  });
}

export function cssPxToMm(px) {
  return (Number(px) * 25.4) / 96;
}

export function pageHeightMmFromContentPx(px) {
  const raw = cssPxToMm(px) + RECEIPT_PRINT_BOTTOM_MM;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(RECEIPT_PRINT_MAX_MM, Math.max(RECEIPT_PRINT_MIN_MM, rounded));
}

function collectStyleText(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return "";
  try {
    return Array.from(doc.querySelectorAll("style"))
      .map((node) => node.textContent || "")
      .join("\n");
  } catch {
    return "";
  }
}

export function readReceiptWidthMm(doc) {
  const css = collectStyleText(doc);
  const match = css.match(/@page\s*\{[^}]*size:\s*(58|80)mm/i);
  return match && match[1] === "58" ? 58 : 80;
}

/** Two-value `@page` height already in the document, or null for `size: 80mm` (square). */
export function readExistingPageHeightMm(doc) {
  const css = collectStyleText(doc);
  const match = css.match(/@page\s*\{[^}]*size:\s*(?:58|80)mm\s+(\d+(?:\.\d+)?)mm/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < RECEIPT_PRINT_MIN_MM) return null;
  return Math.min(RECEIPT_PRINT_MAX_MM, n);
}

export function measureReceiptContentPx(doc) {
  if (!doc) return 0;
  const receipt =
    typeof doc.querySelector === "function" ? doc.querySelector(".receipt") : null;
  if (receipt) {
    const rect =
      typeof receipt.getBoundingClientRect === "function" ? receipt.getBoundingClientRect() : null;
    const values = [rect?.height, receipt.scrollHeight]
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!values.length) return 0;
    return Math.ceil(Math.max(...values));
  }
  const body = doc.body;
  const rect = body && typeof body.getBoundingClientRect === "function" ? body.getBoundingClientRect() : null;
  const values = [rect?.height, body?.scrollHeight]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return 0;
  return Math.ceil(Math.max(...values));
}

function replacePageRule(cssText, widthMm, heightMm) {
  const rule = `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
  const source = String(cssText || "");
  if (/@page\s*\{[^}]*\}/.test(source)) {
    return source.replace(/@page\s*\{[^}]*\}/, rule);
  }
  return `${source}\n${rule}`;
}

/**
 * Set a two-value @page box (width × measured height). Never `80mm auto`.
 * @param {Document} doc
 * @param {number} widthMm
 * @param {number} heightMm
 */
export function applyReceiptPrintPageBox(doc, widthMm, heightMm) {
  const w = Number(widthMm) === 58 ? 58 : 80;
  const hNum = Number(heightMm);
  const h = Number.isFinite(hNum)
    ? Math.min(RECEIPT_PRINT_MAX_MM, Math.max(RECEIPT_PRINT_MIN_MM, hNum))
    : 120;
  const rule = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
  if (!doc) return { widthMm: w, heightMm: h, pageRule: rule };

  const styles = typeof doc.querySelectorAll === "function" ? Array.from(doc.querySelectorAll("style")) : [];
  if (styles.length > 0) {
    styles[0].textContent = replacePageRule(styles[0].textContent || "", w, h);
  } else if (doc.head && typeof doc.createElement === "function") {
    const style = doc.createElement("style");
    style.textContent = rule;
    doc.head.appendChild(style);
  }

  let extra = typeof doc.getElementById === "function" ? doc.getElementById("abo-receipt-print-page") : null;
  if (!extra && doc.head && typeof doc.createElement === "function") {
    extra = doc.createElement("style");
    extra.id = "abo-receipt-print-page";
    doc.head.appendChild(extra);
  }
  if (extra) {
    extra.textContent = `
      @page { size: ${w}mm ${h}mm; margin: 0; }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        min-height: 0 !important;
        height: auto !important;
        overflow: visible !important;
        display: block !important;
        align-items: unset !important;
        justify-content: unset !important;
      }
      .receipt {
        margin-top: 0 !important;
        page-break-inside: avoid;
        break-inside: avoid-page;
      }
    `;
  }

  if (doc.documentElement?.style) {
    doc.documentElement.style.margin = "0";
    doc.documentElement.style.height = "auto";
    doc.documentElement.style.minHeight = "0";
  }
  if (doc.body?.style) {
    doc.body.style.margin = "0";
    doc.body.style.padding = "0";
    doc.body.style.height = "auto";
    doc.body.style.minHeight = "0";
  }
  try {
    doc.title = "";
  } catch {
    /* ignore */
  }
  return { widthMm: w, heightMm: h, pageRule: rule };
}

/**
 * Size the iframe so layout is not clipped to an 80mm square, then set @page
 * to the measured slip. Print must use iframe.contentWindow, not the POS page.
 * @param {Document} doc
 * @param {HTMLIFrameElement} [iframe]
 */
export function prepareReceiptIframeDocument(doc, iframe) {
  const widthMm = readReceiptWidthMm(doc);
  if (iframe?.style) {
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = `${widthMm}mm`;
    iframe.style.height = `${RECEIPT_PRINT_MAX_MM}mm`;
    iframe.style.opacity = "1";
    iframe.style.border = "0";
    iframe.style.margin = "0";
    iframe.style.padding = "0";
  }
  const contentPx = measureReceiptContentPx(doc);
  const measured = contentPx >= 20 ? pageHeightMmFromContentPx(contentPx) : null;
  const existing = readExistingPageHeightMm(doc);
  const heightMm = measured ?? existing ?? Math.max(160, widthMm * 2);
  const box = applyReceiptPrintPageBox(doc, widthMm, heightMm);
  if (iframe?.style) {
    iframe.style.height = `${box.heightMm}mm`;
  }
  return {
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    contentPx,
    pageRule: box.pageRule,
    printTarget: "iframe",
  };
}

function styleReceiptIframe(iframe) {
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("title", "");
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "80mm",
    height: `${RECEIPT_PRINT_MAX_MM}mm`,
    border: "0",
    margin: "0",
    padding: "0",
    opacity: "1",
    pointerEvents: "none",
    zIndex: "-1",
  });
}

function removeReceiptIframe(iframe) {
  if (!iframe) return;
  try {
    iframe.remove();
  } catch {
    iframe.parentNode?.removeChild(iframe);
  }
}

function printHtmlInHiddenIframeNow(html, { cleanupMs = PRINT_IFRAME_CLEANUP_MS } = {}) {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || !document.body) {
      resolve({
        ok: false,
        error: "تعذر تجهيز صفحة الطباعة في المتصفح.",
      });
      return;
    }
    if (!html) {
      resolve({
        ok: false,
        error: "تعذر تحميل محتوى الإيصال. استخدم إعادة الطباعة لهذه العملية.",
      });
      return;
    }

    const previous = document.getElementById(RECEIPT_PRINT_IFRAME_ID);
    removeReceiptIframe(previous);

    const iframe = document.createElement("iframe");
    iframe.id = RECEIPT_PRINT_IFRAME_ID;
    styleReceiptIframe(iframe);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const delay = Number.isFinite(cleanupMs) ? Math.max(0, cleanupMs) : PRINT_IFRAME_CLEANUP_MS;
      setTimeout(() => {
        removeReceiptIframe(iframe);
        resolve(result);
      }, delay);
    };

    const onReady = async () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow || doc?.defaultView;
      if (!doc || !win || typeof win.print !== "function") {
        finish({
          ok: false,
          error: "تعذر تجهيز صفحة الطباعة في المتصفح.",
        });
        return;
      }
      await waitForPrintableDocument(doc);
      if (settled) return;
      const prepared = prepareReceiptIframeDocument(doc, iframe);
      await waitAnimationFrame(win);
      await waitAnimationFrame(win);
      if (settled) return;
      attachAfterPrint(win, () => {
        finish({ ok: true, dispatched: true, ...prepared });
      });
      try {
        win.focus();
        win.print();
      } catch {
        finish({
          ok: false,
          error: "تعذر بدء الطباعة في المتصفح.",
        });
        return;
      }
      setTimeout(() => {
        finish({ ok: true, dispatched: true, ...prepared });
      }, 10000);
    };

    iframe.addEventListener("load", () => {
      void onReady();
    });
    document.body.appendChild(iframe);
    try {
      iframe.srcdoc = html;
    } catch {
      finish({
        ok: false,
        error: "تعذر تجهيز صفحة الطباعة في المتصفح.",
      });
    }
  });
}

/**
 * Print receipt HTML in a hidden iframe (no extra tab or blank popup).
 * Resolving ok means print() was invoked, not that paper exited the printer.
 * @param {string} html
 * @param {{ cleanupMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, dispatched?: boolean, error?: string }>}
 */
export function printHtmlInHiddenIframe(html, opts = {}) {
  const run = () => printHtmlInHiddenIframeNow(html, opts);
  const next = iframePrintTail.then(run, run);
  iframePrintTail = next.then(
    () => {},
    () => {}
  );
  return next;
}

/** Test-only: allow a stuck queue to be reset between cases. */
export function resetReceiptPrintQueueForTests() {
  iframePrintTail = Promise.resolve();
  if (typeof document !== "undefined") {
    removeReceiptIframe(document.getElementById(RECEIPT_PRINT_IFRAME_ID));
  }
}
