import { getReceiptBottomMarginMm, getReceiptPageWidthMm } from "./receipt.js";

const RECEIPT_HEIGHT_MAX_MM = 400;
const RECEIPT_HEIGHT_MIN_MM = 20;

/** In-page measure source for CDP Runtime.evaluate (awaitPromise). */
export function receiptMeasurePageSource() {
  return `(() => {
    function waitImages() {
      return Promise.all(Array.from(document.images).map(function (img) {
        if (img.complete) return Promise.resolve();
        return new Promise(function (resolve) {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }));
    }
    async function run() {
      await waitImages();
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var found =
        document.querySelector(".receipt") ||
        document.querySelector("#receipt") ||
        document.querySelector("[data-receipt]");
      var receipt = found || document.body;
      var rect = receipt && receipt.getBoundingClientRect ? receipt.getBoundingClientRect() : { height: 0 };
      return {
        receiptSelectorFound: Boolean(found),
        rectHeight: Number(rect && rect.height) || 0,
        receiptScrollHeight: Number(receipt && receipt.scrollHeight) || 0,
        bodyScrollHeight: Number(document.body && document.body.scrollHeight) || 0,
      };
    }
    return run();
  })()`;
}

export function computeReceiptHeightFromBoxes({ rectHeight, receiptScrollHeight, bodyScrollHeight }) {
  const values = [rectHeight, receiptScrollHeight, bodyScrollHeight]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  return Math.ceil(Math.max(...values));
}

export function assembleReceiptHeightMeasure(raw, env = process.env) {
  const receiptSelectorFound = Boolean(raw && raw.receiptSelectorFound);
  const rectHeight = Number(raw && raw.rectHeight) || 0;
  const receiptScrollHeight = Number(raw && raw.receiptScrollHeight) || 0;
  const bodyScrollHeight = Number(raw && raw.bodyScrollHeight) || 0;
  const calculatedHeightPx = computeReceiptHeightFromBoxes({
    rectHeight,
    receiptScrollHeight,
    bodyScrollHeight,
  });
  const calculatedHeightMm =
    calculatedHeightPx != null ? receiptPageHeightMmFromContentPx(calculatedHeightPx, env) : null;
  return {
    receiptSelectorFound,
    rectHeight,
    receiptScrollHeight,
    bodyScrollHeight,
    calculatedHeightPx,
    calculatedHeightMm,
  };
}

export const RECEIPT_MEASURE_HOOK = `<script data-abo-receipt-measure="1">
(function () {
  function waitImages() {
    return Promise.all(Array.prototype.slice.call(document.images).map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }));
  }
  window.__aboMeasureReceipt = function () {
    return waitImages()
      .then(function () { return document.fonts && document.fonts.ready ? document.fonts.ready : null; })
      .then(function () {
        var found =
          document.querySelector(".receipt") ||
          document.querySelector("#receipt") ||
          document.querySelector("[data-receipt]");
        var receipt = found || document.body;
        var rect = receipt && receipt.getBoundingClientRect ? receipt.getBoundingClientRect() : { height: 0 };
        var raw = {
          receiptSelectorFound: Boolean(found),
          rectHeight: Number(rect && rect.height) || 0,
          receiptScrollHeight: Number(receipt && receipt.scrollHeight) || 0,
          bodyScrollHeight: Number(document.body && document.body.scrollHeight) || 0
        };
        var positives = [raw.rectHeight, raw.receiptScrollHeight, raw.bodyScrollHeight].filter(function (n) {
          return typeof n === "number" && isFinite(n) && n > 0;
        });
        var px = positives.length ? Math.ceil(Math.max.apply(null, positives)) : 0;
        if (px > 0) document.documentElement.setAttribute("data-receipt-height-px", String(px));
        document.documentElement.setAttribute("data-receipt-measure", JSON.stringify(raw));
        document.documentElement.appendChild(document.createComment("RECEIPT_MEASURE:" + JSON.stringify(raw)));
        return raw;
      });
  };
  function start() { window.__aboMeasureReceipt(); }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
</script>`;

export function injectReceiptMeasureHook(html) {
  const source = String(html);
  if (source.includes('data-abo-receipt-measure="1"')) {
    return source;
  }
  if (/<\/body>/i.test(source)) {
    return source.replace(/<\/body>/i, `${RECEIPT_MEASURE_HOOK}</body>`);
  }
  return source + RECEIPT_MEASURE_HOOK;
}

export function parseReceiptHeightPxFromDom(dom) {
  const text = String(dom || "");
  const json = text.match(/RECEIPT_MEASURE:(\{[^}]+\})/);
  if (json) {
    try {
      const raw = JSON.parse(json[1]);
      const assembled = assembleReceiptHeightMeasure(raw);
      return assembled.calculatedHeightPx;
    } catch {
      /* fall through */
    }
  }
  const attr = text.match(/data-receipt-height-px="(\d+(?:\.\d+)?)"/i);
  if (attr) return Number(attr[1]);
  const comment = text.match(/RECEIPT_HEIGHT_PX:(\d+(?:\.\d+)?)/);
  if (comment) return Number(comment[1]);
  return null;
}

export function parseReceiptMeasureFromDom(dom) {
  const text = String(dom || "");
  const json = text.match(/data-receipt-measure="([^"]+)"/i);
  if (json) {
    try {
      return assembleReceiptHeightMeasure(JSON.parse(json[1].replace(/&quot;/g, '"')));
    } catch {
      /* fall through */
    }
  }
  const comment = text.match(/RECEIPT_MEASURE:(\{[^}]+\})/);
  if (comment) {
    try {
      return assembleReceiptHeightMeasure(JSON.parse(comment[1]));
    } catch {
      /* fall through */
    }
  }
  const px = parseReceiptHeightPxFromDom(text);
  if (px == null) return assembleReceiptHeightMeasure({});
  return assembleReceiptHeightMeasure({
    receiptSelectorFound: true,
    rectHeight: px,
    receiptScrollHeight: px,
    bodyScrollHeight: px,
  });
}

/** Chrome CSS pixels are 96 per inch. */
export function cssPxToMm(px) {
  return (Number(px) * 25.4) / 96;
}

export function receiptPageHeightMmFromContentPx(contentPx, env = process.env) {
  const raw = cssPxToMm(contentPx) + getReceiptBottomMarginMm(env);
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(RECEIPT_HEIGHT_MAX_MM, Math.max(RECEIPT_HEIGHT_MIN_MM, rounded));
}

export function applyReceiptPageSize(html, widthMm, heightMm) {
  const w = Number(widthMm);
  const h = Number(heightMm);
  const pageRule = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
  let out = String(html);
  if (/@page\s*\{[^}]*\}/.test(out)) {
    out = out.replace(/@page\s*\{[^}]*\}/, pageRule);
  } else if (/<\/style>/i.test(out)) {
    out = out.replace(/<\/style>/i, `${pageRule}</style>`);
  } else {
    out = out.replace(/<\/head>/i, `<style>${pageRule}</style></head>`);
  }
  return out;
}

export function receiptPrintWidthMm(env = process.env) {
  return getReceiptPageWidthMm(env);
}
