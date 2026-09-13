/**
 * Browser print helpers.
 * Receipts use a hidden iframe. Reports keep the existing print-window path
 * (A4) and must not be forced into thermal page size.
 *
 * CSS `size: 80mm` (one length) is a square page, not a thermal roll.
 * Do not use `size: 80mm auto` — Chromium does not treat that as variable-length paper.
 */

export const RECEIPT_PRINT_IFRAME_ID = "abo-pos-receipt-print";
/** Retained export. Not a success timer — elapsed time must not remove the iframe. */
export const PRINT_IFRAME_CLEANUP_MS = 750;
export const RECEIPT_PRINT_MAX_MM = 400;
export const RECEIPT_PRINT_MIN_MM = 20;
export const RECEIPT_PRINT_BOTTOM_MM = 5;
/** Store POS stamp. Confirm this exact string in Edge console or the served /pos JS. */
export const RECEIPT_PRINT_REVISION = "receipt-print-rev-20260913c-lifecycle-hold-tab-compare";
export const RECEIPT_PRINT_TAB_NAME = "abo-receipt-print-tab";
export const RECEIPT_PRINT_DIAG_BAR_ID = "abo-receipt-print-diag-bar";

if (typeof window !== "undefined") {
  window.__ABO_RECEIPT_PRINT_REV__ = RECEIPT_PRINT_REVISION;
  try {
    window.document?.documentElement?.setAttribute("data-abo-receipt-print-rev", RECEIPT_PRINT_REVISION);
  } catch {
    /* ignore */
  }
}

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

/** Printer-configured paper. Content is unchanged. Not `80mm auto`. */
export function applyReceiptPrintPageAuto(doc) {
  const rule = "@page { size: auto; margin: 0; }";
  replacePageRules(doc, rule);
  return { widthMm: null, heightMm: null, size: "auto" };
}

function pageBoxLabel(page) {
  if (page?.size === "auto") return "size: auto (ورق الطابعة)";
  if (page?.widthMm != null && page?.heightMm != null) {
    return `size: ${page.widthMm}mm ${page.heightMm}mm`;
  }
  if (page?.widthMm != null) return `size: ${page.widthMm}mm`;
  return "size: (غير مطبّق)";
}

function updateDiagPageLabel(bar, page) {
  const el = typeof bar.querySelector === "function" ? bar.querySelector("[data-abo-diag='page']") : null;
  if (el) el.textContent = pageBoxLabel(page);
}

/**
 * Screen-only chrome for the diagnostic receipt tab. Hidden when printing.
 */
export function injectReceiptPrintTabChrome(doc, { revision = RECEIPT_PRINT_REVISION, page } = {}) {
  if (!doc?.body || typeof doc.createElement !== "function") return page || null;
  let bar = typeof doc.getElementById === "function" ? doc.getElementById(RECEIPT_PRINT_DIAG_BAR_ID) : null;
  if (!bar) {
    const style = doc.createElement("style");
    style.id = "abo-receipt-print-diag-style";
    style.textContent = `
      #${RECEIPT_PRINT_DIAG_BAR_ID} { position: sticky; top: 0; z-index: 9; background: #111; color: #fff; padding: 8px 10px; font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 13px; direction: rtl; }
      #${RECEIPT_PRINT_DIAG_BAR_ID} button { margin: 4px 0 4px 8px; padding: 6px 10px; cursor: pointer; }
      #${RECEIPT_PRINT_DIAG_BAR_ID} .abo-diag-rev { opacity: 0.85; font-size: 12px; direction: ltr; unicode-bidi: isolate; }
      @media print { #${RECEIPT_PRINT_DIAG_BAR_ID} { display: none !important; } }
    `;
    (doc.head || doc.body).appendChild(style);
    bar = doc.createElement("div");
    bar.id = RECEIPT_PRINT_DIAG_BAR_ID;
    bar.setAttribute("data-abo-print-rev", revision);
    bar.innerHTML = `
      <div><strong>تشخيص طباعة الإيصال</strong> <span class="abo-diag-rev">${revision}</span></div>
      <div>
        <button type="button" data-abo-diag="print">طباعة</button>
        <button type="button" data-abo-diag="measured">حجم الإيصال المقاس</button>
        <button type="button" data-abo-diag="auto">ورق الطابعة (size: auto)</button>
      </div>
      <p data-abo-diag="page"></p>
      <p>لا تُغلق هذه النافذة تلقائياً ولا تُطبع وحدها. أغلقها يدوياً بعد التجربة.</p>
    `;
    doc.body.insertBefore(bar, doc.body.firstChild);
    const win = doc.defaultView;
    const printBtn = bar.querySelector?.("[data-abo-diag='print']");
    const measuredBtn = bar.querySelector?.("[data-abo-diag='measured']");
    const autoBtn = bar.querySelector?.("[data-abo-diag='auto']");
    printBtn?.addEventListener("click", () => {
      if (win && typeof win.print === "function") win.print();
    });
    measuredBtn?.addEventListener("click", () => {
      updateDiagPageLabel(bar, applyReceiptPrintPageBox(doc));
    });
    autoBtn?.addEventListener("click", () => {
      updateDiagPageLabel(bar, applyReceiptPrintPageAuto(doc));
    });
  }
  updateDiagPageLabel(bar, page);
  return page || null;
}

/**
 * Load saved-sale HTML into an already-opened top-level tab.
 * Applies measured thermal @page. Does not print or close the tab.
 */
export async function fillReceiptPrintTab(tab, html) {
  const doc = tab?.document;
  if (!doc || typeof doc.write !== "function") {
    return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
  }
  const source = html == null ? "" : String(html);
  if (!source.trim()) {
    return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
  }
  if (typeof doc.open === "function") doc.open();
  doc.write(source);
  if (typeof doc.close === "function") doc.close();
  const live = tab.document;
  await waitForPrintableDocument(live);
  const page = prepareReceiptIframeDocument(live);
  injectReceiptPrintTabChrome(live, { revision: RECEIPT_PRINT_REVISION, page });
  return { ok: true, opened: true, printTarget: "tab", page, revision: RECEIPT_PRINT_REVISION };
}

function createReceiptIframe(widthMm) {
  const iframe = document.createElement("iframe");
  iframe.id = RECEIPT_PRINT_IFRAME_ID;
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("title", "");
  iframe.setAttribute("data-abo-print-rev", RECEIPT_PRINT_REVISION);
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

function isBlankIframeDocument(doc) {
  if (!doc) return true;
  const uri = String(doc.URL || doc.documentURI || "");
  if (uri === "about:srcdoc") return false;
  if (uri && uri !== "about:blank") return false;
  try {
    if (typeof doc.querySelector === "function" && doc.querySelector(".receipt")) {
      return false;
    }
  } catch {
    /* ignore */
  }
  return String(doc.body?.innerHTML || "").trim().length === 0;
}

function waitForReceiptDocument(iframe) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (doc) => {
      if (settled) return;
      settled = true;
      resolve(doc);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error(IFRAME_PRINT_UNAVAILABLE_AR));
    };
    const consider = () => {
      const doc = iframe.contentDocument;
      if (!isBlankIframeDocument(doc)) succeed(doc);
    };
    if (typeof iframe.addEventListener === "function") {
      iframe.addEventListener("load", consider);
      iframe.addEventListener("error", fail, { once: true });
    }
    consider();
  });
}

function bindPrintLifecycle(win, finish) {
  if (!win) return;
  if (typeof win.addEventListener === "function") {
    win.addEventListener("afterprint", finish, { once: true });
  }
  win.onafterprint = finish;
  try {
    const mq = typeof win.matchMedia === "function" ? win.matchMedia("print") : null;
    if (mq && typeof mq.addEventListener === "function") {
      const onChange = (e) => {
        if (!e.matches) {
          mq.removeEventListener("change", onChange);
          finish();
        }
      };
      mq.addEventListener("change", onChange);
    } else if (mq && typeof mq.addListener === "function") {
      const onChange = (e) => {
        if (!e.matches) {
          mq.removeListener(onChange);
          finish();
        }
      };
      mq.addListener(onChange);
    }
  } catch {
    /* ignore unsupported print-media listeners */
  }
}

function detachReceiptIframe(iframe) {
  try {
    iframe?.remove?.();
  } catch {
    /* ignore */
  }
}

async function printHtmlInHiddenIframeNow(html, { releaseQueue } = {}) {
  const source = html == null ? "" : String(html);
  if (!source.trim()) {
    releaseQueue?.();
    return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
  }

  let iframe;
  let cleaned = false;
  let printCalled = false;
  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    detachReceiptIframe(iframe);
    releaseQueue?.();
  };

  try {
    iframe = createReceiptIframe(80);
    const loaded = waitForReceiptDocument(iframe);
    iframe.srcdoc = source;
    if (!document.body || typeof document.body.appendChild !== "function") {
      finish();
      return { ok: false, error: IFRAME_PRINT_UNAVAILABLE_AR };
    }
    document.body.appendChild(iframe);

    const doc = await loaded;
    const win = iframe.contentWindow || doc?.defaultView;
    if (!doc || !win || typeof win.print !== "function") {
      finish();
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

    bindPrintLifecycle(win, finish);
    win.focus();
    if (printCalled) {
      return { ok: true, dispatched: true, printTarget: "iframe" };
    }
    printCalled = true;
    win.print();
    return { ok: true, dispatched: true, printTarget: "iframe" };
  } catch (err) {
    finish();
    return { ok: false, error: err?.message || IFRAME_PRINT_UNAVAILABLE_AR };
  }
}

/**
 * Print saved-sale HTML in a hidden iframe (Edge silent-print when policies are on).
 * ok means print() was dispatched, not that paper came out.
 * The iframe stays until afterprint / print-media change (including cancel)
 * or a prepare/print failure. Elapsed time is not treated as success. If the
 * browser never emits a close signal, the iframe remains and later receipt
 * jobs wait — refresh the POS tab to recover.
 * @param {string} html
 * @param {{ cleanupMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, dispatched?: boolean, printTarget?: string, error?: string }>}
 */
export function printHtmlInHiddenIframe(html, opts = {}) {
  let resolveGate;
  const gate = new Promise((resolve) => {
    resolveGate = resolve;
  });
  const releaseQueue = () => resolveGate();
  const job = iframePrintTail.then(
    () => printHtmlInHiddenIframeNow(html, { ...opts, releaseQueue }),
    () => printHtmlInHiddenIframeNow(html, { ...opts, releaseQueue })
  );
  iframePrintTail = job.then(
    (result) => {
      if (!result?.ok) {
        releaseQueue();
        return undefined;
      }
      return gate;
    },
    () => {
      releaseQueue();
    }
  ).then(
    () => undefined,
    () => undefined
  );
  return job;
}
