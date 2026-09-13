import {
  applyReceiptPrintPageAuto,
  applyReceiptPrintPageBox,
  fillReceiptPrintTab,
  pageHeightMmFromContentPx,
  prepareReceiptIframeDocument,
  printHtmlInHiddenIframe,
  printDocumentWhenReady,
  readExistingPageHeightMm,
  RECEIPT_PRINT_DIAG_BAR_ID,
  RECEIPT_PRINT_IFRAME_ID,
  RECEIPT_PRINT_REVISION,
  resetReceiptPrintQueueForTests,
  waitForPrintableDocument,
} from "./printDocument";

function mockIframe({ images = [], fontsReady = Promise.resolve() } = {}) {
  const afterPrintHandlers = [];
  const mediaListeners = [];
  const loadHandlers = [];
  const errorHandlers = [];
  let receiptReady = false;
  const receipt = {
    getBoundingClientRect: () => ({ height: 454 }),
    scrollHeight: 454,
  };
  const style = { textContent: "@page { size: 80mm; margin: 0; }" };
  const extra = { id: "abo-receipt-print-page", textContent: "" };
  const body = { style: {}, scrollHeight: 0, innerHTML: "", getBoundingClientRect: () => ({ height: 0 }) };
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
    setTimeout: jest.fn((fn, ms) => setTimeout(fn, ms)),
    matchMedia: () => ({
      addEventListener: (type, fn) => {
        if (type === "change") mediaListeners.push(fn);
      },
      removeEventListener: (type, fn) => {
        const i = mediaListeners.indexOf(fn);
        if (i >= 0) mediaListeners.splice(i, 1);
      },
    }),
  };
  const doc = {
    URL: "about:blank",
    documentURI: "about:blank",
    readyState: "complete",
    images,
    fonts: { ready: fontsReady },
    defaultView: win,
    addEventListener: jest.fn(),
    title: "إيصال",
    body,
    documentElement: { style: {}, scrollHeight: 454 },
    querySelector: (sel) => (sel === ".receipt" && receiptReady ? receipt : null),
    querySelectorAll: (sel) => (sel === "style" ? [style] : []),
    getElementById: (id) => (id === "abo-receipt-print-page" ? extra : null),
    open: jest.fn(),
    write: jest.fn(),
    close: jest.fn(),
  };
  const iframe = {
    id: "",
    style: {},
    srcdoc: "",
    setAttribute: jest.fn(),
    remove: jest.fn(),
    addEventListener: jest.fn((type, fn) => {
      if (type === "load") loadHandlers.push(fn);
      if (type === "error") errorHandlers.push(fn);
    }),
    contentDocument: doc,
    contentWindow: win,
  };

  function markReceiptLoaded() {
    receiptReady = true;
    doc.URL = "about:srcdoc";
    doc.documentURI = "about:srcdoc";
    body.innerHTML = '<div class="receipt">إيصال</div>';
    body.scrollHeight = 454;
    body.getBoundingClientRect = () => ({ height: 454 });
  }

  return {
    iframe,
    doc,
    win,
    style,
    extra,
    afterPrintHandlers,
    mediaListeners,
    loadHandlers,
    errorHandlers,
    markReceiptLoaded,
  };
}

function fireBlankLoad(api) {
  api.loadHandlers.forEach((fn) => fn());
}

function fireReceiptLoad(api) {
  api.markReceiptLoaded();
  api.loadHandlers.forEach((fn) => fn());
}

function fireAfterPrint(api) {
  api.afterPrintHandlers.forEach((fn) => fn());
  if (typeof api.win.onafterprint === "function") api.win.onafterprint();
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("printHtmlInHiddenIframe", () => {
  // Mocked Chromium lifecycle only. Does not prove RONGTA paper output.
  let created;
  let srcdocAtAppend;
  let origCreateElement;

  beforeEach(() => {
    resetReceiptPrintQueueForTests();
    created = [];
    srcdocAtAppend = undefined;
    origCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tag) => {
      if (String(tag).toLowerCase() === "iframe") {
        const api = mockIframe();
        created.push(api);
        return api.iframe;
      }
      return origCreateElement(tag);
    });
    jest.spyOn(document, "getElementById").mockReturnValue(null);
    jest.spyOn(document.body, "appendChild").mockImplementation((node) => {
      srcdocAtAppend = node.srcdoc;
      return node;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("assigns srcdoc before append, then dispatches one iframe print", async () => {
    const html = "<html><body><div class=\"receipt\">إيصال</div></body></html>";
    const pending = printHtmlInHiddenIframe(html);
    await flush();
    expect(srcdocAtAppend).toBe(html);
    expect(created).toHaveLength(1);
    expect(created[0].doc.write).not.toHaveBeenCalled();
    fireReceiptLoad(created[0]);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, dispatched: true, printTarget: "iframe" });
    expect(created[0].win.print).toHaveBeenCalledTimes(1);
    expect(created[0].iframe.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    expect(created[0].iframe.style.opacity).toBe("1");
    expect(created[0].iframe.style.width).toBe("80mm");
    expect(created[0].iframe.style.left).toBe("-10000px");
    expect(created[0].iframe.id).toBe(RECEIPT_PRINT_IFRAME_ID);
    expect(created[0].iframe.setAttribute).toHaveBeenCalledWith("data-abo-print-rev", RECEIPT_PRINT_REVISION);
    expect(created[0].doc.title).toBe("");
    expect(created[0].style.textContent).toBe(
      `@page { size: 80mm ${pageHeightMmFromContentPx(454)}mm; margin: 0; }`
    );
    expect(created[0].style.textContent).not.toMatch(/\bauto\b/);
    expect(created[0].iframe.remove).not.toHaveBeenCalled();
  });

  test("ignores about:blank and duplicate loads and prints only once", async () => {
    const pending = printHtmlInHiddenIframe("<html><body><div class=\"receipt\">إيصال</div></body></html>");
    await flush();
    fireBlankLoad(created[0]);
    await flush();
    expect(created[0].win.print).not.toHaveBeenCalled();
    fireReceiptLoad(created[0]);
    fireReceiptLoad(created[0]);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(created[0].win.print).toHaveBeenCalledTimes(1);
  });

  test("preview open beyond 30s keeps the iframe and does not report timed success", async () => {
    jest.useFakeTimers();
    const pending = printHtmlInHiddenIframe("<html><body><div class=\"receipt\">إيصال</div></body></html>");
    await flush();
    fireReceiptLoad(created[0]);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, dispatched: true });
    expect(created[0].iframe.remove).not.toHaveBeenCalled();
    const cleanupTimeouts = created[0].win.setTimeout.mock.calls.filter(
      ([, ms]) => Number(ms) === 0 || Number(ms) === 750 || Number(ms) >= 1000
    );
    expect(cleanupTimeouts).toHaveLength(0);
    jest.advanceTimersByTime(35_000);
    await flush();
    expect(created[0].iframe.remove).not.toHaveBeenCalled();
    expect(created[0].win.print).toHaveBeenCalledTimes(1);
  });

  test("queued job does not replace an active receipt iframe", async () => {
    const first = printHtmlInHiddenIframe("<html>a</html>");
    const second = printHtmlInHiddenIframe("<html>b</html>");
    await flush();
    fireReceiptLoad(created[0]);
    await expect(first).resolves.toMatchObject({ ok: true, dispatched: true });
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0].iframe.remove).not.toHaveBeenCalled();
    expect(created[0].win.print).toHaveBeenCalledTimes(1);

    fireAfterPrint(created[0]);
    await flush();
    expect(created[0].iframe.remove).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    fireReceiptLoad(created[1]);
    await expect(second).resolves.toMatchObject({ ok: true, dispatched: true });
    expect(created[1].win.print).toHaveBeenCalledTimes(1);
    expect(created[1].iframe.remove).not.toHaveBeenCalled();
  });

  test("afterprint and cancel lifecycle remove the iframe once", async () => {
    const pending = printHtmlInHiddenIframe("<html><body><div class=\"receipt\">إيصال</div></body></html>");
    await flush();
    fireReceiptLoad(created[0]);
    await pending;
    fireAfterPrint(created[0]);
    fireAfterPrint(created[0]);
    expect(created[0].iframe.remove).toHaveBeenCalledTimes(1);
  });

  test("print-media change to not matching cleans up like dialog close", async () => {
    const pending = printHtmlInHiddenIframe("<html><body><div class=\"receipt\">إيصال</div></body></html>");
    await flush();
    fireReceiptLoad(created[0]);
    await pending;
    created[0].mediaListeners.forEach((fn) => fn({ matches: false }));
    expect(created[0].iframe.remove).toHaveBeenCalledTimes(1);
  });

  test("print() failure cleans up, is not success, and releases the queue", async () => {
    const first = printHtmlInHiddenIframe("<html>a</html>");
    await flush();
    created[0].win.print.mockImplementation(() => {
      throw new Error("print blocked");
    });
    fireReceiptLoad(created[0]);
    const failed = await first;
    expect(failed.ok).toBe(false);
    expect(failed.dispatched).toBeUndefined();
    expect(failed.error).toBeTruthy();
    expect(created[0].iframe.remove).toHaveBeenCalledTimes(1);

    const second = printHtmlInHiddenIframe("<html>b</html>");
    await flush();
    expect(created).toHaveLength(2);
    fireReceiptLoad(created[1]);
    await expect(second).resolves.toMatchObject({ ok: true, dispatched: true });
  });

  test("preparation failure cleans up and recovers the queue", async () => {
    const first = printHtmlInHiddenIframe("<html>a</html>");
    await flush();
    created[0].doc.fonts.ready = Promise.reject(new Error("font explode"));
    created[0].win.requestAnimationFrame = () => {
      throw new Error("prepare failed");
    };
    fireReceiptLoad(created[0]);
    const failed = await first;
    expect(failed.ok).toBe(false);
    expect(created[0].iframe.remove).toHaveBeenCalledTimes(1);

    const second = printHtmlInHiddenIframe("<html>b</html>");
    await flush();
    fireReceiptLoad(created[1]);
    await expect(second).resolves.toMatchObject({ ok: true, dispatched: true });
  });

  test("missing html does not call print", async () => {
    const result = await printHtmlInHiddenIframe("");
    expect(result.ok).toBe(false);
    expect(created).toHaveLength(0);
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

describe("receipt print revision and diagnostic tab", () => {
  test("revision stamp is the store-build identifier", () => {
    expect(RECEIPT_PRINT_REVISION).toBe("receipt-print-rev-20260913c-lifecycle-hold-tab-compare");
    expect(window.__ABO_RECEIPT_PRINT_REV__).toBe(RECEIPT_PRINT_REVISION);
    expect(document.documentElement.getAttribute("data-abo-receipt-print-rev")).toBe(RECEIPT_PRINT_REVISION);
  });

  test("applyReceiptPrintPageAuto changes only @page to auto", () => {
    const style = { textContent: "@page { size: 80mm 125.12mm; margin: 0; }" };
    const extra = { id: "abo-receipt-print-page", textContent: style.textContent };
    const doc = {
      querySelectorAll: (sel) => (sel === "style" ? [style] : []),
      getElementById: (id) => (id === "abo-receipt-print-page" ? extra : null),
    };
    const page = applyReceiptPrintPageAuto(doc);
    expect(page).toEqual({ widthMm: null, heightMm: null, size: "auto" });
    expect(style.textContent).toBe("@page { size: auto; margin: 0; }");
    expect(extra.textContent).toBe("@page { size: auto; margin: 0; }");
  });

  test("fillReceiptPrintTab writes HTML, applies measured size, and does not print or close", async () => {
    const printSpy = jest.spyOn(window, "print").mockImplementation(() => {});
    const doc = document.implementation.createHTMLDocument("");
    const html =
      "<!DOCTYPE html><html><head><style>@page { size: 80mm; margin: 0; }</style></head>" +
      '<body><div class="receipt">إيصال</div></body></html>';
    const tab = { document: doc, close: jest.fn() };
    const result = await fillReceiptPrintTab(tab, html);
    expect(result.ok).toBe(true);
    expect(result.printTarget).toBe("tab");
    expect(result.revision).toBe(RECEIPT_PRINT_REVISION);
    expect(doc.querySelector(".receipt")?.textContent).toBe("إيصال");
    expect(doc.getElementById(RECEIPT_PRINT_DIAG_BAR_ID)).toBeTruthy();
    expect(doc.getElementById(RECEIPT_PRINT_DIAG_BAR_ID).getAttribute("data-abo-print-rev")).toBe(
      RECEIPT_PRINT_REVISION
    );
    expect(doc.title).toBe("");
    expect(printSpy).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
    const autoBtn = doc.querySelector("[data-abo-diag='auto']");
    autoBtn.click();
    expect(doc.querySelector("style")?.textContent || "").toMatch(/size:\s*auto/);
    printSpy.mockRestore();
  });
});
