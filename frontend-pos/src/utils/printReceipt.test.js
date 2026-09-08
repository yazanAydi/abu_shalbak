import {
  printReceipt,
  setPrintEnvForTests,
  shouldFallbackToBrowser,
  STORE_PRINT_UNAVAILABLE_AR,
} from "./printReceipt";

const mockPost = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

function mockPrintWindow() {
  const print = jest.fn();
  const write = jest.fn();
  const doc = {
    write,
    close: jest.fn(),
    images: [],
    defaultView: null,
  };
  const w = {
    document: doc,
    print,
    focus: jest.fn(),
    close: jest.fn(),
    opener: {},
    addEventListener: jest.fn(),
  };
  doc.defaultView = w;
  const open = jest.spyOn(window, "open").mockReturnValue(w);
  return { open, print, write };
}

function agentUnavailable(status, code) {
  const err = new Error("تعذر الاتصال بطابعة الإيصالات. تأكد من تشغيل خدمة الطباعة ثم حاول مرة أخرى.");
  err.response = { status, data: { error: err.message, code } };
  return err;
}

describe("printReceipt", () => {
  beforeEach(() => {
    mockPost.mockReset();
    setPrintEnvForTests({ NODE_ENV: "production" });
    jest.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    setPrintEnvForTests(null);
    window.alert.mockRestore();
    if (window.open.mockRestore) window.open.mockRestore();
  });

  test("production silent success never calls window.print", async () => {
    const { open, print } = mockPrintWindow();
    mockPost.mockResolvedValue({ data: { printed: true } });
    await printReceipt({ transaction_id: 42 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "/api/print-receipt/silent",
      { transaction_id: 42 },
      expect.any(Object)
    );
    expect(open).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  test("production 503 AGENT_UNAVAILABLE alerts and never window.print", async () => {
    const { open, print } = mockPrintWindow();
    mockPost.mockRejectedValue(agentUnavailable(503, "AGENT_UNAVAILABLE"));
    await printReceipt({ transaction_id: 11 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(STORE_PRINT_UNAVAILABLE_AR);
  });

  test("production 501 SILENT_PRINT_UNSUPPORTED alerts and never window.print", async () => {
    const { open, print } = mockPrintWindow();
    mockPost.mockRejectedValue(agentUnavailable(501, "SILENT_PRINT_UNSUPPORTED"));
    await printReceipt({ transaction_id: 3 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(STORE_PRINT_UNAVAILABLE_AR);
  });

  test("production unexpected 500 alerts and never window.print", async () => {
    const { open } = mockPrintWindow();
    const err = new Error("خطأ داخلي");
    err.response = { status: 500, data: { error: err.message, code: "PRINT_FAILED" } };
    mockPost.mockRejectedValue(err);
    await printReceipt({ transaction_id: 21 });
    expect(open).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(err.message);
  });

  test("development 503 may use browser fallback", async () => {
    setPrintEnvForTests({ NODE_ENV: "development" });
    const { open, write } = mockPrintWindow();
    const html = "<html><body><div class=\"receipt\">إيصال</div></body></html>";
    mockPost
      .mockRejectedValueOnce(agentUnavailable(503, "AGENT_UNAVAILABLE"))
      .mockResolvedValueOnce({ data: { receipt_html: html } });
    await printReceipt({ transaction_id: 11 });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(html);
    expect(window.alert).not.toHaveBeenCalled();
  });

  test("retry after agent outage can silent-print", async () => {
    const { open } = mockPrintWindow();
    mockPost.mockRejectedValueOnce(agentUnavailable(503, "AGENT_UNAVAILABLE"));
    await printReceipt({ transaction_id: 55 });
    expect(window.alert).toHaveBeenCalledWith(STORE_PRINT_UNAVAILABLE_AR);
    expect(open).not.toHaveBeenCalled();

    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { printed: true } });
    window.alert.mockClear();
    await printReceipt({ transaction_id: 55 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe("/api/print-receipt/silent");
    expect(open).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  test("overlapping prints for the same sale send one POST", async () => {
    let release;
    mockPost.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const first = printReceipt({ transaction_id: 7 });
    const second = printReceipt({ transaction_id: 7 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    release({ data: { printed: true } });
    await Promise.all([first, second]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("printer error alerts and does not open a print dialog", async () => {
    const { open } = mockPrintWindow();
    const err = new Error("الطابعة الافتراضية هي \"Microsoft Print to PDF\"");
    err.response = { status: 409, data: { error: err.message, code: "VIRTUAL_PRINTER" } };
    mockPost.mockRejectedValue(err);
    await printReceipt({ transaction_id: 9 });
    expect(window.alert).toHaveBeenCalledWith(err.message);
    expect(open).not.toHaveBeenCalled();
  });

  test("shouldFallbackToBrowser is off in production and on in development", () => {
    const unavailable = { response: { status: 503, data: { code: "AGENT_UNAVAILABLE" } } };
    expect(shouldFallbackToBrowser(unavailable, { NODE_ENV: "production" })).toBe(false);
    expect(shouldFallbackToBrowser(unavailable, { NODE_ENV: "test" })).toBe(false);
    expect(shouldFallbackToBrowser(unavailable, { NODE_ENV: "development" })).toBe(true);
    expect(
      shouldFallbackToBrowser(
        { response: { status: 500, data: { code: "PRINT_FAILED" } } },
        { NODE_ENV: "development" }
      )
    ).toBe(false);
  });

  test("save test-mode response is success with no dialog or alert", async () => {
    const { open } = mockPrintWindow();
    mockPost.mockResolvedValue({
      data: {
        success: true,
        testMode: true,
        pdfPath: "C:\\abo_shalbak\\tmp\\receipt-test\\receipt.pdf",
        widthMm: 80,
        heightMm: 112,
      },
    });
    await printReceipt({ transaction_id: 15 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(window.alert).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("missing sale id alerts and does not POST", async () => {
    await printReceipt("plain text receipt");
    expect(mockPost).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("لا يوجد رقم عملية للطباعة");
  });
});
