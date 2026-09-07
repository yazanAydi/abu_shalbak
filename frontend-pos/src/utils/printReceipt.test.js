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

  test("unsupported silent print (501) falls back to HTML print payload", async () => {
    const err = new Error("الطباعة المباشرة تعمل عندما يعمل الخادم على ويندوز");
    err.response = { status: 501, data: { error: err.message, code: "SILENT_PRINT_UNSUPPORTED" } };
    mockPost
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { receipt_html: "<html>إيصال</html>" } });
    const open = jest.spyOn(window, "open").mockReturnValue({
      document: { write: jest.fn(), close: jest.fn() },
      addEventListener: jest.fn(),
      setTimeout: jest.fn((fn) => fn()),
      focus: jest.fn(),
      print: jest.fn(),
      close: jest.fn(),
    });
    await printReceipt({ transaction_id: 3 });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][0]).toBe("/api/print-receipt");
    expect(open).toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("missing sale id alerts and does not POST", async () => {
    await printReceipt("plain text receipt");
    expect(mockPost).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("لا يوجد رقم عملية للطباعة");
  });
});
