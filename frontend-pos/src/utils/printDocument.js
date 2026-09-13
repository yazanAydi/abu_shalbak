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

const IFRAME_PRINT_UNAVAILABLE_AR =
  "تعذر تجهيز طباعة الإيصال في المتصفح. استخدم إعادة الطباعة لهذه العملية.";

let iframePrintTail = Promise.resolve();

export function resetReceiptPrintQueueForTests() {
  iframePrintTail = Promise.resolve();
}

function waitImages(doc) {
  const images = Array.from(doc?.images || []);
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

/**
 * Wait for images, fonts, and document completeness before measuring or printing.
 * @param {Document} doc
 */
export async function waitForPrintableDocument(doc) {
  if (!doc) return;
  if (doc.readyState !== "complete") {
    await new Promise((resolve) => {
      const done = () => resolve();
      if (typeof doc.addEventListener === "function") {
        doc.addEventListener("DOMContentLoaded", done, { once: true });
      }
      const win = doc.defaultView;
      if (win && typeof win.addEventListener === "function") {
        win.addEventListener("load", done, { once: true });
      } else {
        done();
      }
    });
  }
  await waitImages(doc);
  if (doc.fonts?.ready) {
    try {
      await doc.fonts.ready;
    } catch {
      /* ignore font failures — still print */
    }
  }
}

/**
 * Wait for images in a print document, then open the print dialog.
 * Used by A4 reports and statements — not the thermal receipt path.
 * @param {Document} doc
 * @param {{ onAfterPrint?: () => void }} [opts]
 */
export function printDocumentWhenReady(doc, { onAfterPrint } = {}) {
  const win = doc.defaultView;
  if (!win) {
    onAfterPrint?.();
    return;
  }

  const triggerPrint = () => {
    win.focus();
    win.print();
    onAfterPrint?.();
  };

  const images = Array.from(doc.images || []);
  if (images.length === 0) {
    triggerPrint();
    return;
  }

  let pending = 0;
  const finishOne = () => {
    pending -= 1;
    if (pending <= 0) triggerPrint();
  };

  for (const img of images) {
    if (img.complete) continue;
    pending += 1;
    img.addEventListener("load", finishOne, { once: true });
    img.addEventListener("error", finishOne, { once: true });
  }

  if (pending === 0) {
    triggerPrint();
  }
}

function collectStyleText(doc) {
  const nodes = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("style") : [];
  return Array.from(nodes)
    .map((n) => String(n.textContent || ""))
    .join("\n");
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

export function pageHeightMmFromContentPx(px) {
  const raw = (Number(px) * 25.4) / 96 + RECEIPT_PRINT_BOTTOM_MM;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(RECEIPT_PRINT_MAX_MM, Math.max(RECEIPT_PRINT_MIN_MM, rounded));
}

function replacePageRules(doc, rule) {
  const styles = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("style") : [];
  for (const el of styles) {
    if (typeof el.textContent === "string" && /@page\s*\{/.test(el.textContent)) {
      el.textContent = el.textContent.replace(/@page\s*\{[^}]*\}/, rule);
    }
  }
  let extra = typeof doc.getElementById === "function" ? doc.getElementById("abo-receipt-print-page") : null;
  if (extra) {
    extra.textContent = rule;
  }
}

export function applyReceiptPrintPageBox(doc) {
  const widthMm = readReceiptWidthMm(doc);
  const existingH = readExistingPageHeightMm(doc);
  const px = measureReceiptContentPx(doc);
  const measured = px > 0 ? pageHeightMmFromContentPx(px) : null;
  const heightMm = existingH ?? measured;
  if (heightMm == null) return { widthMm, heightMm: null };
  const rule = `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
  replacePageRules(doc, rule);
  return { widthMm, heightMm };
}

export function prepareReceiptIframeDocument(doc) {
  if (!doc) return { widthMm: 80, heightMm: null };
  doc.title = "";
  return applyReceiptPrintPageBox(doc);
}

function createReceiptIframe(widthMm) {
  const prev = typeof document.getElementById === "function" ? document.getElementById(RECEIPT_PRINT_IFRAME_ID) : null;
  if (prev && typeof prev.remove === "function") prev.remove();

  const iframe = document.createElement("iframe");
  iframe.id = RECEIPT_PRINT_IFRAME_ID;
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("title", "");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = `${widthMm}mm`;
  iframe.style.height = `${RECEIPT_PRINT_MAX_MM}mm`;
  iframe.style.border = "0";
  iframe.style.opacity = "1";
  iframe.style.margin = "0";
  iframe.style.padding = "0";
  iframe.style.background = "#fff";
  iframe.style.pointerEvents = "none";
  return iframe;
}

function waitIframeDocument(iframe) {
  const doc = iframe.contentDocument;
  if (doc && doc.readyState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoad = () => resolve();
    const onError = () => reject(new Error(IFRAME_PRINT_UNAVAILABLE_AR));
    if (typeof iframe.addEventListener === "function") {
      iframe.addEventListener("load", onLoad, { once: true });
      iframe.addEventListener("error", onError, { once: true });
    } else {
      resolve();
    }
  });
}

async function loadHtmlIntoIframe(iframe, html) {
  const doc = iframe.contentDocument;
  if (doc && typeof doc.write === "function") {
    if (typeof doc.open === "function") doc.open();
    doc.write(html);
    if (typeof doc.close === "function") doc.close();
    return;
  }
  iframe.srcdoc = html;
  await waitIframeDocument(iframe);
}

function scheduleIframeCleanup(iframe, win, cleanupMs) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      iframe.remove?.();
    } catch {
      /* ignore */
    }
  };
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("afterprint", finish, { once: true });
  }
  const ms = Number(cleanupMs);
  const delay = Number.isFinite(ms) ? Math.max(0, ms) : PRINT_IFRAME_CLEANUP_MS;
  if (win && typeof win.setTimeout === "function") {
    win.setTimeout(finish, delay);
  } else {
    setTimeout(finish, delay);
  }
}

async function printHtmlInHiddenIframeNow(html, { cleanupMs = PRINT_IFRAME_CLEANUP_MS } = {}) {
  const source = html == null ? "" : String(html);
  if (!source.trim()) {
    return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
  }

  let iframe;
  try {
    iframe = createReceiptIframe(80);
    if (document.body && typeof document.body.appendChild === "function") {
      document.body.appendChild(iframe);
    }
    await loadHtmlIntoIframe(iframe, source);

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow || doc?.defaultView;
    if (!doc || !win || typeof win.print !== "function") {
      iframe.remove?.();
      return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
    }

    await waitForPrintableDocument(doc);
    const page = prepareReceiptIframeDocument(doc);
    iframe.style.width = `${page.widthMm}mm`;

    await new Promise((resolve) => {
      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });

    win.focus();
    win.print();
    scheduleIframeCleanup(iframe, win, cleanupMs);
    return { ok: true, dispatched: true, printTarget: "iframe" };
  } catch (err) {
    try {
      iframe?.remove?.();
    } catch {
      /* ignore */
    }
    return { ok: false, error: err?.message || IFRAME_PRINT_UNAVAILABLE_AR };
  }
}

/**
 * Print saved-sale HTML in a hidden iframe (Edge silent-print when policies are on).
 * ok means print() was dispatched, not that paper came out.
 * @param {string} html
 * @param {{ cleanupMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, dispatched?: boolean, printTarget?: string, error?: string }>}
 */
export function printHtmlInHiddenIframe(html, opts = {}) {
  const job = iframePrintTail.then(
    () => printHtmlInHiddenIframeNow(html, opts),
    () => printHtmlInHiddenIframeNow(html, opts)
  );
  iframePrintTail = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}
