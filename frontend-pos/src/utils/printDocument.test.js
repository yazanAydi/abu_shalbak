import {
  applyReceiptPrintPageBox,
  pageHeightMmFromContentPx,
  prepareReceiptIframeDocument,
  printHtmlInHiddenIframe,
  printDocumentWhenReady,
  readExistingPageHeightMm,
  RECEIPT_PRINT_IFRAME_ID,
  resetReceiptPrintQueueForTests,
  waitForPrintableDocument,
} from "./printDocument";

function mockIframe({ images = [], fontsReady = Promise.resolve() } = {}) {
  const afterPrintHandlers = [];
  const win = {
    focus: jest.fn(),
    print: jest.fn(),
    addEventListener: (type, fn) => {
      if (type === "afterprint") afterPrintHandlers.push(fn);
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    matchMedia: () => ({ addEventListener: jest.fn(), removeEventListener: jest.fn() }),
  };
  const receipt = {
    getBoundingClientRect: () => ({ height: 454 }),
    scrollHeight: 454,
  };
  const style = { textContent: "@page { size: 80mm; margin: 0; }" };
  const extra = { id: "abo-receipt-print-page", textContent: "" };
  const doc = {
    readyState: "complete",
    images,
    fonts: { ready: fontsReady },
    defaultView: win,
    addEventListener: jest.fn(),
    title: "إيصال",
    body: { style: {}, scrollHeight: 454 },
    documentElement: { style: {}, scrollHeight: 454 },
    querySelector: (sel) => (sel === ".receipt" ? receipt : null),
    querySelectorAll: (sel) => (sel === "style" ? [style] : []),
    getElementById: (id) => (id === "abo-receipt-print-page" ? extra : null),
    open: jest.fn(),
    write: jest.fn(),
    close: jest.fn(),
  };
  const iframe = {
    id: "",
    style: {},
    setAttribute: jest.fn(),
    remove: jest.fn(),
    addEventListener: jest.fn(),
    contentDocument: doc,
    contentWindow: win,
  };
  return { iframe, doc, win, style, extra, afterPrintHandlers };
}

describe("printHtmlInHiddenIframe", () => {
  let iframeApi;
  let origCreateElement;

  beforeEach(() => {
    resetReceiptPrintQueueForTests();
    iframeApi = mockIframe();
    origCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tag) => {
      if (String(tag).toLowerCase() === "iframe") return iframeApi.iframe;
      return origCreateElement(tag);
    });
    jest.spyOn(document, "getElementById").mockReturnValue(null);
    jest.spyOn(document.body, "appendChild").mockImplementation((node) => node);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("loads HTML then dispatches iframe print without a popup window", async () => {
    const html = "<html><body><div class=\"receipt\">إيصال</div></body></html>";
    const result = await printHtmlInHiddenIframe(html, { cleanupMs: 0 });
    expect(result).toMatchObject({ ok: true, dispatched: true, printTarget: "iframe" });
    expect(iframeApi.doc.write).toHaveBeenCalledWith(html);
    expect(iframeApi.win.print).toHaveBeenCalledTimes(1);
    expect(iframeApi.iframe.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    expect(iframeApi.iframe.style.opacity).toBe("1");
    expect(iframeApi.iframe.style.width).toBe("80mm");
    expect(iframeApi.iframe.style.left).toBe("-10000px");
    expect(iframeApi.iframe.id).toBe(RECEIPT_PRINT_IFRAME_ID);
    expect(iframeApi.doc.title).toBe("");
    expect(iframeApi.style.textContent).toBe(
      `@page { size: 80mm ${pageHeightMmFromContentPx(454)}mm; margin: 0; }`
    );
    expect(iframeApi.style.textContent).not.toMatch(/\bauto\b/);
    await new Promise((r) => setTimeout(r, 10));
    expect(iframeApi.iframe.remove).toHaveBeenCalledTimes(1);
  });

  test("print() failure is an error and is not a success claim", async () => {
    iframeApi.win.print.mockImplementation(() => {
      throw new Error("print blocked");
    });
    const result = await printHtmlInHiddenIframe("<html></html>", { cleanupMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.dispatched).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  test("overlapping prints wait and still call print once per job", async () => {
    const first = printHtmlInHiddenIframe("<html>a</html>", { cleanupMs: 0 });
    const second = printHtmlInHiddenIframe("<html>b</html>", { cleanupMs: 0 });
    const results = await Promise.all([first, second]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(iframeApi.win.print).toHaveBeenCalledTimes(2);
  });

  test("missing html does not call print", async () => {
    const result = await printHtmlInHiddenIframe("", { cleanupMs: 0 });
    expect(result.ok).toBe(false);
    expect(iframeApi.win.print).not.toHaveBeenCalled();
  });
});

describe("receipt @page box", () => {
  test("one-value 80mm is replaced with width and measured height, never auto", () => {
    const receipt = {
      getBoundingClientRect: () => ({ height: 454 }),
      scrollHeight: 454,
    };
    const style = { textContent: "@page { size: 80mm; margin: 0; }" };
    const extra = { id: "abo-receipt-print-page", textContent: "" };
    const doc = {
      querySelectorAll: (sel) => (sel === "style" ? [style] : []),
      querySelector: (sel) => (sel === ".receipt" ? receipt : null),
      getElementById: (id) => (id === "abo-receipt-print-page" ? extra : null),
      title: "إيصال",
      body: { style: {}, scrollHeight: 454 },
      documentElement: { style: {}, scrollHeight: 454 },
    };
    const page = applyReceiptPrintPageBox(doc);
    expect(page.widthMm).toBe(80);
    expect(page.heightMm).toBe(pageHeightMmFromContentPx(454));
    expect(style.textContent).toBe(`@page { size: 80mm ${page.heightMm}mm; margin: 0; }`);
    expect(style.textContent).not.toMatch(/\bauto\b/);
    expect(extra.textContent).toContain(`${page.heightMm}mm`);
    expect(readExistingPageHeightMm({ querySelectorAll: () => [{ textContent: style.textContent }] })).toBe(
      page.heightMm
    );
  });

  test("prepareReceiptIframeDocument clears the title used for headers", () => {
    const style = { textContent: "@page { size: 80mm; margin: 0; }" };
    const doc = {
      title: "إيصال",
      querySelectorAll: (sel) => (sel === "style" ? [style] : []),
      querySelector: () => null,
      getElementById: () => null,
      body: { scrollHeight: 200, getBoundingClientRect: () => ({ height: 200 }) },
    };
    prepareReceiptIframeDocument(doc);
    expect(doc.title).toBe("");
  });
});

describe("printDocumentWhenReady (reports)", () => {
  test("prints after images are already complete", () => {
    const win = { focus: jest.fn(), print: jest.fn() };
    const after = jest.fn();
    printDocumentWhenReady(
      { defaultView: win, images: [{ complete: true }] },
      { onAfterPrint: after }
    );
    expect(win.print).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("waitForPrintableDocument", () => {
  test("waits for fonts.ready", async () => {
    let release;
    const fontsReady = new Promise((resolve) => {
      release = resolve;
    });
    const pending = waitForPrintableDocument({
      readyState: "complete",
      images: [],
      fonts: { ready: fontsReady },
    });
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
  });
});
