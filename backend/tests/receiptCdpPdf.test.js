import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { receiptPdfPrintParams } from "../services/chromeCdp.js";
import {
  findReceiptChromium,
  measurePdfPageSizeMm,
  printPdfViaChromiumCli,
  renderReceiptHtmlToPdf,
} from "../services/windowsSilentPrint.js";
import { applyReceiptPageSize, assembleReceiptHeightMeasure } from "../utils/receiptPdfPage.js";
import { cdpEvaluateOnUrl } from "../services/chromeCdp.js";
import { receiptMeasurePageSource } from "../utils/receiptPdfPage.js";
import { buildReceiptHtml } from "../utils/receipt.js";

const SRC_PRINT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../services/windowsSilentPrint.js"),
  "utf8"
);

function sampleReceipt(lineCount) {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    name: i % 2 === 0 ? `خبز ${i + 1}` : `حليب ${i + 1}`,
    sku: String(1000 + i),
    quantity: 1,
    price: 2.5,
    lineTotal: 2.5,
  }));
  return buildReceiptHtml({
    transactionId: 9000 + lineCount,
    receiptNumber: `INV-TEST-${lineCount}`,
    timestamp: "2026-09-15 12:00:00",
    cashierName: "cashier1",
    lines,
    subtotal: lineCount * 2.5,
    tax: 0,
    total: lineCount * 2.5,
    paymentMethod: "cash",
    settings: {},
  });
}

describe("receipt CDP PDF params", () => {
  test("printToPDF uses 80mm width, zero margins, CSS page size, and scale 1", () => {
    const params = receiptPdfPrintParams(80, 120.5);
    expect(params.displayHeaderFooter).toBe(false);
    expect(params.printBackground).toBe(true);
    expect(params.preferCSSPageSize).toBe(true);
    expect(params.scale).toBe(1);
    expect(params.marginTop).toBe(0);
    expect(params.marginBottom).toBe(0);
    expect(params.marginLeft).toBe(0);
    expect(params.marginRight).toBe(0);
    expect(params.paperWidth).toBeCloseTo(80 / 25.4, 4);
    expect(params.paperHeight).toBeCloseTo(120.5 / 25.4, 4);
    expect(params.landscape).toBe(false);
  });

  test("helper HTML→PDF reuses one CDP session and keeps CLI print-to-pdf only as fallback", () => {
    expect(SRC_PRINT).toContain("withHeadlessCdpPage");
    expect(SRC_PRINT).toContain('pdfExtra("cdp")');
    expect(SRC_PRINT).toContain("session.printToPdf");
    expect(SRC_PRINT).toContain("printPdfViaChromiumCli");
    expect(SRC_PRINT).toContain("--print-to-pdf=");
    expect(SRC_PRINT).toContain('scale: "noscale"');
  });
});

const browser = findReceiptChromium();
const describeEdge = browser ? describe : describe.skip;

describeEdge("receipt CDP PDF vs CLI (Edge present)", () => {
  test("short and long receipts: CDP MediaBox matches measured size and is not A4", async () => {
    const shortHtml = sampleReceipt(2);
    const longHtml = sampleReceipt(28);
    const short = await renderReceiptHtmlToPdf(shortHtml);
    const long = await renderReceiptHtmlToPdf(longHtml);
    try {
      const shortSize = measurePdfPageSizeMm(await fs.promises.readFile(short.pdfPath));
      const longSize = measurePdfPageSizeMm(await fs.promises.readFile(long.pdfPath));
      expect(Math.abs(shortSize.widthMm - 80)).toBeLessThan(1);
      expect(Math.abs(longSize.widthMm - 80)).toBeLessThan(1);
      expect(Math.abs(shortSize.heightMm - short.heightMm)).toBeLessThan(1.5);
      expect(Math.abs(longSize.heightMm - long.heightMm)).toBeLessThan(1.5);
      expect(longSize.heightMm).toBeGreaterThan(shortSize.heightMm + 40);
      expect(shortSize.heightMm).toBeLessThan(297);
      expect(longSize.heightMm).toBeLessThan(400);
      expect(shortSize.heightMm).not.toBeCloseTo(297, 0);
    } finally {
      await fs.promises.rm(short.tmp, { recursive: true, force: true }).catch(() => {});
      await fs.promises.rm(long.tmp, { recursive: true, force: true }).catch(() => {});
    }
  }, 90000);

  test("CDP PDF page size is within 1.5mm of the previous CLI renderer", async () => {
    const html = sampleReceipt(8);
    const cdp = await renderReceiptHtmlToPdf(html);
    const cliTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-cli-"));
    try {
      const measurePath = path.join(cliTmp, "measure.html");
      const printPath = path.join(cliTmp, "receipt.html");
      const cliPdfPath = path.join(cliTmp, "receipt.pdf");
      const measureProfile = path.join(cliTmp, "profile-measure");
      const printProfile = path.join(cliTmp, "profile-print");
      await fs.promises.mkdir(measureProfile);
      await fs.promises.writeFile(measurePath, html, "utf8");
      const raw = await cdpEvaluateOnUrl(
        browser,
        measureProfile,
        pathToFileURL(measurePath).href,
        receiptMeasurePageSource()
      );
      const diag = assembleReceiptHeightMeasure(raw);
      expect(diag.calculatedHeightMm).toBeTruthy();
      await fs.promises.writeFile(
        printPath,
        applyReceiptPageSize(html, 80, diag.calculatedHeightMm),
        "utf8"
      );
      await printPdfViaChromiumCli(browser, printPath, cliPdfPath, printProfile);
      const cdpSize = measurePdfPageSizeMm(await fs.promises.readFile(cdp.pdfPath));
      const cliSize = measurePdfPageSizeMm(await fs.promises.readFile(cliPdfPath));
      expect(Math.abs(cdpSize.widthMm - cliSize.widthMm)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(cdpSize.heightMm - cliSize.heightMm)).toBeLessThanOrEqual(1.5);
    } finally {
      await fs.promises.rm(cdp.tmp, { recursive: true, force: true }).catch(() => {});
      await fs.promises.rm(cliTmp, { recursive: true, force: true }).catch(() => {});
    }
  }, 90000);
});
