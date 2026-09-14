import fs from "fs";
import os from "os";
import path from "path";
import {
  assertReceiptPrinterReady,
  isReceiptPrintTestSave,
  measurePdfPageSizeMm,
  persistReceiptTestPdf,
  printReceiptHtmlLocally,
  receiptTestOutputDir,
  resolveReceiptPrinterName,
  setPrintPipelineForTests,
  silentPrintReceiptHtml,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

function pdfWithMediaBoxMm(widthMm, heightMm) {
  const w = mmToPt(widthMm);
  const h = mmToPt(heightMm);
  return Buffer.from(
    `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >>endobj
trailer<< /Root 1 0 R >>
%%EOF
`,
    "latin1"
  );
}

async function writeFixturePdf(widthMm, heightMm) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-fixture-"));
  const pdfPath = path.join(tmp, "receipt.pdf");
  await fs.promises.writeFile(pdfPath, pdfWithMediaBoxMm(widthMm, heightMm));
  return { pdfPath, tmp };
}

const prevTestMode = process.env.RECEIPT_PRINT_TEST_MODE;
const prevWidth = process.env.RECEIPT_WIDTH_MM;
const prevPrinter = process.env.RECEIPT_PRINTER;
const prevCashierRoot = process.env.CASHIER_PRINT_ROOT;
const savedPaths = [];

async function cleanupSaved() {
  for (const file of savedPaths.splice(0)) {
    await fs.promises.unlink(file).catch(() => {});
  }
}

describe("RECEIPT_PRINT_TEST_MODE", () => {
  afterEach(async () => {
    if (prevTestMode == null) delete process.env.RECEIPT_PRINT_TEST_MODE;
    else process.env.RECEIPT_PRINT_TEST_MODE = prevTestMode;
    if (prevWidth == null) delete process.env.RECEIPT_WIDTH_MM;
    else process.env.RECEIPT_WIDTH_MM = prevWidth;
    if (prevPrinter == null) delete process.env.RECEIPT_PRINTER;
    else process.env.RECEIPT_PRINTER = prevPrinter;
    if (prevCashierRoot == null) delete process.env.CASHIER_PRINT_ROOT;
    else process.env.CASHIER_PRINT_ROOT = prevCashierRoot;
    setPrintPipelineForTests(null);
    await cleanupSaved();
  });

  test("rejects Microsoft Print to PDF as RECEIPT_PRINTER", async () => {
    delete process.env.RECEIPT_PRINT_TEST_MODE;
    process.env.RECEIPT_PRINTER = "Microsoft Print to PDF";
    await expect(resolveReceiptPrinterName()).rejects.toMatchObject({ code: "VIRTUAL_PRINTER" });
    await expect(assertReceiptPrinterReady()).rejects.toMatchObject({ code: "VIRTUAL_PRINTER" });
  });

  test("receiptTestOutputDir uses CASHIER_PRINT_ROOT when set", () => {
    process.env.CASHIER_PRINT_ROOT = "D:\\till";
    expect(receiptTestOutputDir().replace(/\\/g, "/")).toBe("D:/till/tmp/receipt-test");
  });

  test("defaults off", () => {
    delete process.env.RECEIPT_PRINT_TEST_MODE;
    expect(isReceiptPrintTestSave()).toBe(false);
    process.env.RECEIPT_PRINT_TEST_MODE = "0";
    expect(isReceiptPrintTestSave()).toBe(false);
    process.env.RECEIPT_PRINT_TEST_MODE = "false";
    expect(isReceiptPrintTestSave()).toBe(false);
  });

  test("save is case-insensitive", () => {
    process.env.RECEIPT_PRINT_TEST_MODE = "SAVE";
    expect(isReceiptPrintTestSave()).toBe(true);
    process.env.RECEIPT_PRINT_TEST_MODE = "  save  ";
    expect(isReceiptPrintTestSave()).toBe(true);
  });

  test("measurePdfPageSizeMm reads MediaBox, not env width", () => {
    process.env.RECEIPT_WIDTH_MM = "58";
    const size = measurePdfPageSizeMm(pdfWithMediaBoxMm(80, 120));
    expect(size.widthMm).toBeCloseTo(80, 1);
    expect(size.heightMm).toBeCloseTo(120, 1);
  });

  test("measurePdfPageSizeMm reports A4 when the PDF is A4", () => {
    const size = measurePdfPageSizeMm(pdfWithMediaBoxMm(210, 297));
    expect(size.widthMm).toBeCloseTo(210, 1);
    expect(size.heightMm).toBeCloseTo(297, 1);
  });

  test("persistReceiptTestPdf copies into tmp/receipt-test", async () => {
    const { pdfPath, tmp } = await writeFixturePdf(80, 95);
    try {
      const saved = await persistReceiptTestPdf(pdfPath);
      savedPaths.push(saved.pdfPath);
      expect(saved.pdfPath.startsWith(receiptTestOutputDir())).toBe(true);
      expect(fs.existsSync(saved.pdfPath)).toBe(true);
      expect(saved.widthMm).toBeCloseTo(80, 1);
      expect(saved.heightMm).toBeCloseTo(95, 1);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  test("save mode generates the PDF, skips the printer, and skips virtual-printer checks", async () => {
    process.env.RECEIPT_PRINT_TEST_MODE = "save";
    process.env.RECEIPT_WIDTH_MM = "58";
    const htmlSeen = [];
    let printCalls = 0;
    let resolveCalls = 0;

    setPrintPipelineForTests({
      htmlToPdf: async (html) => {
        htmlSeen.push(html);
        return writeFixturePdf(80, 140);
      },
      printPdfFile: async () => {
        printCalls += 1;
      },
      resolvePrinter: async () => {
        resolveCalls += 1;
        throw new SilentPrintError(
          "VIRTUAL_PRINTER",
          'الطابعة الافتراضية هي "Microsoft Print to PDF"'
        );
      },
    });

    const result = await printReceiptHtmlLocally("<html>إيصال حراري</html>");
    savedPaths.push(result.pdfPath);
    expect(htmlSeen).toEqual(["<html>إيصال حراري</html>"]);
    expect(printCalls).toBe(0);
    expect(resolveCalls).toBe(0);
    expect(result.testMode).toBe(true);
    expect(result.printed).toBe(true);
    expect(result.pdfPath).toContain(`${path.sep}tmp${path.sep}receipt-test${path.sep}`);
    expect(fs.existsSync(result.pdfPath)).toBe(true);
    expect(result.widthMm).toBeCloseTo(80, 1);
    expect(result.heightMm).toBeCloseTo(140, 1);
  });

  test("without save mode, pdf-to-printer runs and virtual printers are still rejected", async () => {
    delete process.env.RECEIPT_PRINT_TEST_MODE;
    let printCalls = 0;
    setPrintPipelineForTests({
      platform: "win32",
      htmlToPdf: async () => writeFixturePdf(80, 90),
      printPdfFile: async () => {
        printCalls += 1;
      },
      resolvePrinter: async () => {
        throw new SilentPrintError(
          "VIRTUAL_PRINTER",
          'الطابعة الافتراضية هي "Microsoft Print to PDF"'
        );
      },
    });

    await expect(printReceiptHtmlLocally("<html></html>")).rejects.toMatchObject({
      code: "VIRTUAL_PRINTER",
    });
    expect(printCalls).toBe(0);

    setPrintPipelineForTests({
      platform: "win32",
      htmlToPdf: async () => writeFixturePdf(80, 90),
      printPdfFile: async () => {
        printCalls += 1;
      },
      resolvePrinter: async () => "POS-80",
    });
    const printed = await printReceiptHtmlLocally("<html></html>");
    expect(printed).toEqual({ printed: true, printer: "POS-80" });
    expect(printCalls).toBe(1);
    expect(printed.testMode).toBeUndefined();
  });

  test("silentPrintReceiptHtml in save mode uses the shared local pipeline", async () => {
    process.env.RECEIPT_PRINT_TEST_MODE = "save";
    setPrintPipelineForTests({
      htmlToPdf: async () => writeFixturePdf(80, 88),
      printPdfFile: async () => {
        throw new Error("pdf-to-printer must not run");
      },
      resolvePrinter: async () => {
        throw new Error("printer must not be queried");
      },
    });
    const result = await silentPrintReceiptHtml("<html>x</html>");
    savedPaths.push(result.pdfPath);
    expect(result.testMode).toBe(true);
    expect(result.widthMm).toBeCloseTo(80, 1);
    expect(result.heightMm).toBeCloseTo(88, 1);
  });
});
