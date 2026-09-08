import {
  forwardToPrintAgent,
  receiptPrintAgentHeaders,
  receiptPrintAgentUrl,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";

describe("forwardToPrintAgent", () => {
  const prevUrl = process.env.RECEIPT_PRINT_AGENT_URL;
  const prevToken = process.env.RECEIPT_PRINT_AGENT_TOKEN;

  afterEach(() => {
    if (prevUrl == null) delete process.env.RECEIPT_PRINT_AGENT_URL;
    else process.env.RECEIPT_PRINT_AGENT_URL = prevUrl;
    if (prevToken == null) delete process.env.RECEIPT_PRINT_AGENT_TOKEN;
    else process.env.RECEIPT_PRINT_AGENT_TOKEN = prevToken;
  });

  test("sends the shared print-agent token when configured", async () => {
    process.env.RECEIPT_PRINT_AGENT_TOKEN = "shop-token";
    const headers = receiptPrintAgentHeaders();
    expect(headers["X-Receipt-Print-Token"]).toBe("shop-token");
    const fetchImpl = async (_url, init) => {
      expect(init.headers["X-Receipt-Print-Token"]).toBe("shop-token");
      return { ok: true, json: async () => ({ printed: true, printer: "POS-80" }) };
    };
    await forwardToPrintAgent("<html>x</html>", fetchImpl);
  });

  test("default agent URL is host.docker.internal:17891", () => {
    delete process.env.RECEIPT_PRINT_AGENT_URL;
    expect(receiptPrintAgentUrl()).toBe("http://host.docker.internal:17891");
  });

  test("strips a trailing slash from RECEIPT_PRINT_AGENT_URL", () => {
    process.env.RECEIPT_PRINT_AGENT_URL = "http://127.0.0.1:17891/";
    expect(receiptPrintAgentUrl()).toBe("http://127.0.0.1:17891");
  });

  test("successful agent print returns printer name", async () => {
    const fetchImpl = async (url, init) => {
      expect(url).toBe("http://host.docker.internal:17891/print");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.html).toContain("<html>");
      return {
        ok: true,
        json: async () => ({ printed: true, printer: "POS-80" }),
      };
    };
    delete process.env.RECEIPT_PRINT_AGENT_URL;
    const result = await forwardToPrintAgent("<html>إيصال</html>", fetchImpl);
    expect(result).toEqual({ printed: true, printer: "POS-80", viaAgent: true });
  });

  test("forwards agent save-mode PDF fields", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        printed: true,
        testMode: true,
        pdfPath: "C:\\abo_shalbak\\tmp\\receipt-test\\receipt.pdf",
        widthMm: 80,
        heightMm: 101.5,
      }),
    });
    const result = await forwardToPrintAgent("<html>إيصال</html>", fetchImpl);
    expect(result).toEqual({
      printed: true,
      printer: null,
      viaAgent: true,
      testMode: true,
      pdfPath: "C:\\abo_shalbak\\tmp\\receipt-test\\receipt.pdf",
      widthMm: 80,
      heightMm: 101.5,
    });
  });

  test("unreachable agent throws AGENT_UNAVAILABLE", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(forwardToPrintAgent("<html></html>", fetchImpl)).rejects.toMatchObject({
      name: "Error",
      code: "AGENT_UNAVAILABLE",
    });
    await expect(forwardToPrintAgent("<html></html>", fetchImpl)).rejects.toBeInstanceOf(
      SilentPrintError
    );
  });

  test("virtual printer from agent is 409-style SilentPrintError", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'الطابعة الافتراضية هي "Microsoft Print to PDF"',
        code: "VIRTUAL_PRINTER",
      }),
    });
    await expect(forwardToPrintAgent("<html></html>", fetchImpl)).rejects.toMatchObject({
      code: "VIRTUAL_PRINTER",
    });
  });
});
