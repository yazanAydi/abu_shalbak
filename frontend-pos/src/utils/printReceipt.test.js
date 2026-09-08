import { printReceipt } from "./printReceipt";

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

describe("printReceipt", () => {
  beforeEach(() => {
    mockPost.mockReset();
    jest.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    window.alert.mockRestore();
  });

  test("one print sends one silent POST", async () => {
    mockPost.mockResolvedValue({ data: { printed: true } });
    await printReceipt({ transaction_id: 42 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "/api/print-receipt/silent",
      { transaction_id: 42 },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test" }),
      })
    );
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
    const err = new Error("الطابعة الافتراضية هي \"Microsoft Print to PDF\"");
    err.response = { status: 409, data: { error: err.message, code: "VIRTUAL_PRINTER" } };
    mockPost.mockRejectedValue(err);
    await printReceipt({ transaction_id: 9 });
    expect(window.alert).toHaveBeenCalledWith(err.message);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("unsupported silent print (501) alerts and does not open a print dialog", async () => {
    const err = new Error("خدمة طباعة الإيصالات غير شغّالة");
    err.response = { status: 501, data: { error: err.message, code: "SILENT_PRINT_UNSUPPORTED" } };
    const open = jest.spyOn(window, "open");
    mockPost.mockRejectedValue(err);
    await printReceipt({ transaction_id: 3 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "/api/print-receipt/silent",
      { transaction_id: 3 },
      expect.any(Object)
    );
    expect(window.alert).toHaveBeenCalledWith(err.message);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("print agent down (503) alerts and does not open a print dialog", async () => {
    const err = new Error("خدمة طباعة الإيصالات غير شغّالة على جهاز ويندوز");
    err.response = { status: 503, data: { error: err.message, code: "AGENT_UNAVAILABLE" } };
    const open = jest.spyOn(window, "open");
    mockPost.mockRejectedValue(err);
    await printReceipt({ transaction_id: 11 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(window.alert).toHaveBeenCalledWith(err.message);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("save test-mode response is success with no dialog or alert", async () => {
    mockPost.mockResolvedValue({
      data: {
        success: true,
        testMode: true,
        pdfPath: "C:\\abo_shalbak\\tmp\\receipt-test\\receipt.pdf",
        widthMm: 80,
        heightMm: 112,
      },
    });
    const open = jest.spyOn(window, "open");
    await printReceipt({ transaction_id: 15 });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(window.alert).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("missing sale id alerts and does not POST", async () => {
    await printReceipt("plain text receipt");
    expect(mockPost).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("لا يوجد رقم عملية للطباعة");
  });
});
