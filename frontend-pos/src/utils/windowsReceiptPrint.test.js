import { HELPER_UNAVAILABLE_AR, printHtmlViaWindowsHelper } from "./windowsReceiptPrint";

describe("printHtmlViaWindowsHelper", () => {
  test("health then print, without arm or document.title", async () => {
    const prevTitle = document.title;
    document.title = "أبو شلبك — نقطة البيع";
    const calls = [];
    const fetchImpl = jest.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ printer: "RONGTA 80mm Series Printer" }) };
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
    expect(result).toEqual({ ok: true, printed: true, printTarget: "windows-helper", testMode: false });
    expect(document.title).toBe("أبو شلبك — نقطة البيع");
    expect(calls.map((c) => c.url.replace("http://127.0.0.1:17892", ""))).toEqual(["/health", "/print"]);
    expect(JSON.parse(calls[1].body)).toEqual({ html: "<html>إيصال</html>", transactionId: 9 });
    document.title = prevTitle;
  });

  test("helper down is a print failure, not a sale", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await printHtmlViaWindowsHelper("<html></html>", { fetchImpl });
    expect(result).toEqual({ ok: false, error: HELPER_UNAVAILABLE_AR });
  });

  test("helper error text is returned", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ printer: "RONGTA 80mm Series Printer" }) };
      }
      return { ok: false, json: async () => ({ ok: false, error: "RECEIPT_PRINTER غير معيّن" }) };
    });
    const result = await printHtmlViaWindowsHelper("<html></html>", { transactionId: 1, fetchImpl });
    expect(result).toEqual({ ok: false, error: "RECEIPT_PRINTER غير معيّن" });
  });
});
