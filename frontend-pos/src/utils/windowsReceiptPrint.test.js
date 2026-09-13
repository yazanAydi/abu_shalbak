import { HELPER_UNAVAILABLE_AR, printHtmlViaWindowsHelper } from "./windowsReceiptPrint";

describe("printHtmlViaWindowsHelper", () => {
  test("arms, prints, and disarms one request", async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ printer: "RONGTA 80mm Series Printer" }) };
      }
      if (String(url).endsWith("/arm")) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (String(url).endsWith("/print")) {
        return { ok: true, json: async () => ({ ok: true, printed: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const result = await printHtmlViaWindowsHelper("<html>إيصال</html>", {
      transactionId: 9,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.printTarget).toBe("windows-helper");
    expect(calls.map((c) => c.url.replace("http://127.0.0.1:17892", ""))).toEqual([
      "/health",
      "/arm",
      "/print",
      "/disarm",
    ]);
    const arm = JSON.parse(calls[1].body);
    const printed = JSON.parse(calls[2].body);
    expect(arm.transactionId).toBe(9);
    expect(arm.printerName).toBe("RONGTA 80mm Series Printer");
    expect(printed.requestId).toBe(arm.requestId);
    expect(printed.html).toContain("إيصال");
  });

  test("helper down is a print failure, not a sale", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await printHtmlViaWindowsHelper("<html></html>", { fetchImpl });
    expect(result).toEqual({ ok: false, error: HELPER_UNAVAILABLE_AR });
  });
});
