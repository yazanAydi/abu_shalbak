import { jest } from "@jest/globals";
import {
  printPdfFile,
  printReceiptHtmlLocally,
  renderReceiptHtmlToPdf,
  setPdfPrinterForTests,
  setPrintPipelineForTests,
  silentPrintReceiptHtml,
} from "../services/windowsSilentPrint.js";
import { readDeviceSnapshot } from "../services/zkteco/readOnlyAdapter.js";

describe("automated tests cannot reach hardware or external integrations", () => {
  const previousEnv = process.env.NODE_ENV;
  const isolatedFetch = global.fetch;

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
    global.fetch = isolatedFetch;
    setPdfPrinterForTests(null);
    setPrintPipelineForTests(null);
  });

  test("a development parent env still refuses the real printer and accepts a stub", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.RECEIPT_PRINTER;
    const printer = jest.fn(async () => {});
    await expect(printPdfFile("C:\\Users\\secret\\receipt.pdf", "RONGTA 80mm Series Printer")).rejects.toMatchObject({
      code: "TEST_ISOLATION",
    });
    expect(printer).not.toHaveBeenCalled();

    setPdfPrinterForTests(printer);
    await printPdfFile("C:\\Users\\secret\\receipt.pdf", "POS-80");
    expect(printer).toHaveBeenCalledTimes(1);

    await expect(printReceiptHtmlLocally("<html>إيصال</html>")).rejects.toMatchObject({
      code: "TEST_ISOLATION",
    });
    const htmlToPdf = jest.fn(async () => ({ pdfPath: "unused.pdf", tmp: null }));
    setPrintPipelineForTests({
      htmlToPdf,
      printPdfFile: jest.fn(async () => {}),
      resolvePrinter: jest.fn(async () => "POS-80"),
      platform: "win32",
    });
    await printReceiptHtmlLocally("<html>إيصال</html>");
    expect(htmlToPdf).toHaveBeenCalledTimes(1);
    expect(printer).toHaveBeenCalledTimes(1);

    const dry = await silentPrintReceiptHtml("<html>إيصال</html>");
    expect(dry).toEqual({ printed: true, dryRun: true });

    await expect(renderReceiptHtmlToPdf("<html>إيصال</html>")).rejects.toMatchObject({
      code: "TEST_ISOLATION",
    });
  });

  test("telegram and the fingerprint device are blocked unless a test double is installed", async () => {
    process.env.NODE_ENV = "development";
    await expect(global.fetch("https://api.telegram.org/botsecret/sendMessage", { method: "POST" })).rejects.toMatchObject({
      code: "TEST_ISOLATION",
    });
    const fetchSpy = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    global.fetch = fetchSpy;
    await global.fetch("https://api.telegram.org/botsecret/sendMessage");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(readDeviceSnapshot({ host: "10.0.0.8", port: 4370, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "TEST_ISOLATION",
    });
    const factory = jest.fn(async () => {
      throw new Error("stub-device");
    });
    await expect(readDeviceSnapshot({ host: "10.0.0.8", port: 4370 }, factory)).rejects.toThrow("stub-device");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
