import fs from "fs";
import path from "path";
import {
  openReceiptForPrinting,
  printReceipt,
  RECEIPT_POPUP_BLOCKED_AR,
  saleSavedPrintFailedMessage,
  STORE_PRINT_UNAVAILABLE_AR,
} from "./printReceipt";

const mockPost = jest.fn();
const mockIframePrint = jest.fn();
const mockFillTab = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

jest.mock("./printDocument", () => ({
  printHtmlInHiddenIframe: (...args) => mockIframePrint(...args),
  fillReceiptPrintTab: (...args) => mockFillTab(...args),
  RECEIPT_PRINT_REVISION: "receipt-print-rev-20260913c-lifecycle-hold-tab-compare",
  RECEIPT_PRINT_TAB_NAME: "abo-receipt-print-tab",
}));

const RECEIPT_HTML =
  '<html lang="ar" dir="rtl"><body><div class="receipt">إيصال خبز</div></body></html>';

describe("printReceipt (saved sale → browser iframe)", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockIframePrint.mockReset();
    mockFillTab.mockReset();
    mockIframePrint.mockResolvedValue({ ok: true, dispatched: true });
    mockFillTab.mockResolvedValue({ ok: true, opened: true, printTarget: "tab" });
    mockPost.mockResolvedValue({ data: { receipt_html: RECEIPT_HTML } });
    jest.spyOn(window, "alert").mockImplementation(() => {});
    jest.spyOn(window, "open");
  });

  afterEach(() => {
    window.alert.mockRestore();
    window.open.mockRestore();
  });

  test("loads the saved sale HTML then prints in an iframe", async () => {
    const result = await printReceipt({ transaction_id: 42 });
    expect(result).toEqual({ ok: true, dispatched: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "/api/print-receipt",
      { transaction_id: 42 },
      expect.any(Object)
    );
    expect(mockIframePrint).toHaveBeenCalledTimes(1);
    expect(mockIframePrint).toHaveBeenCalledWith(RECEIPT_HTML);
    expect(window.open).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  test("does not POST checkout and does not call the silent agent API", async () => {
    await printReceipt({ transaction_id: 8 });
    const urls = mockPost.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(["/api/print-receipt"]);
    expect(urls.some((u) => String(u).includes("checkout"))).toBe(false);
    expect(urls.some((u) => String(u).includes("silent"))).toBe(false);
  });

  test("reprint of the same saved sale fetches HTML again and does not create a sale", async () => {
    await printReceipt({ transaction_id: 15 });
    await printReceipt({ transaction_id: 15 });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls.every((c) => c[0] === "/api/print-receipt")).toBe(true);
    expect(mockIframePrint).toHaveBeenCalledTimes(2);
  });

  test("overlapping prints for the same sale send one request", async () => {
    let release;
    mockPost.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const first = printReceipt({ transaction_id: 7 });
    const second = printReceipt({ transaction_id: 7 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    release({ data: { receipt_html: RECEIPT_HTML } });
    const results = await Promise.all([first, second]);
    expect(results.some((r) => r.skipped)).toBe(true);
    expect(mockIframePrint).toHaveBeenCalledTimes(1);
  });

  test("fetch failure after save uses checkout HTML fallback and still prints", async () => {
    mockPost.mockRejectedValueOnce(new Error("network"));
    const result = await printReceipt({
      transaction_id: 9,
      receipt_html: RECEIPT_HTML,
      receipt_number: "INV-9",
    });
    expect(result.ok).toBe(true);
    expect(mockIframePrint).toHaveBeenCalledWith(RECEIPT_HTML);
  });

  test("fetch failure without HTML alerts and does not print", async () => {
    mockPost.mockRejectedValueOnce({
      message: "تعذر الاتصال",
      response: { status: 500, data: { error: "تعذر الاتصال" } },
    });
    const result = await printReceipt({ transaction_id: 21 });
    expect(result.ok).toBe(false);
    expect(mockIframePrint).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("تعذر الاتصال");
  });

  test("iframe print failure alerts Arabic copy and is not a print-success claim", async () => {
    mockIframePrint.mockResolvedValueOnce({
      ok: false,
      error: STORE_PRINT_UNAVAILABLE_AR,
    });
    const result = await printReceipt({ transaction_id: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(STORE_PRINT_UNAVAILABLE_AR);
    expect(window.alert).toHaveBeenCalledWith(STORE_PRINT_UNAVAILABLE_AR);
  });

  test("missing sale id alerts and does not POST", async () => {
    const result = await printReceipt("plain text receipt");
    expect(result).toEqual({ ok: false, error: "لا يوجد رقم عملية للطباعة" });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockIframePrint).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("لا يوجد رقم عملية للطباعة");
  });

  test("sale-saved print-failed copy keeps the receipt number", () => {
    expect(saleSavedPrintFailedMessage("INV-2026-000001")).toBe(
      "تم حفظ عملية البيع رقم INV-2026-000001، لكن تعذّرت طباعة الإيصال. لا تُعد إدخال البيع."
    );
  });

  test("POS print source never talks to the Windows print-agent or silent API", () => {
    const src = fs.readFileSync(path.join(__dirname, "printReceipt.js"), "utf8");
    expect(src).not.toMatch(/17891/);
    expect(src).not.toMatch(/print-agent/i);
    expect(src).not.toContain('"/api/print-receipt/silent"');
    expect(src).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(src).toContain("/api/print-receipt");
    expect(src).toContain("printHtmlInHiddenIframe");
    expect(src).toContain("openReceiptForPrinting");
    expect(src).toContain("fillReceiptPrintTab");
  });

  test("openReceiptForPrinting uses the same saved HTML and does not iframe-print or auto-print", async () => {
    const tab = { document: { open: jest.fn(), write: jest.fn(), close: jest.fn() } };
    const printSpy = jest.spyOn(window, "print");
    const result = await openReceiptForPrinting({ transaction_id: 42 }, { tab });
    expect(result).toMatchObject({ ok: true, opened: true, printTarget: "tab" });
    expect(mockPost).toHaveBeenCalledWith(
      "/api/print-receipt",
      { transaction_id: 42 },
      expect.any(Object)
    );
    expect(mockFillTab).toHaveBeenCalledWith(tab, RECEIPT_HTML);
    expect(mockIframePrint).not.toHaveBeenCalled();
    expect(printSpy).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    printSpy.mockRestore();
  });

  test("openReceiptForPrinting reports a blocked popup", async () => {
    window.open.mockReturnValue(null);
    const result = await openReceiptForPrinting({ transaction_id: 5 });
    expect(result).toEqual({
      ok: false,
      error: RECEIPT_POPUP_BLOCKED_AR,
      blocked: true,
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockFillTab).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(RECEIPT_POPUP_BLOCKED_AR);
  });
});
