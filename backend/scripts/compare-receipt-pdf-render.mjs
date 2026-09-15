/**
 * Dev-PC only: compare CDP receipt PDFs vs the previous CLI --print-to-pdf renderer.
 * Does not talk to a Windows printer.
 *
 *   node backend/scripts/compare-receipt-pdf-render.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { buildReceiptHtml } from "../utils/receipt.js";
import { applyReceiptPageSize, assembleReceiptHeightMeasure, receiptMeasurePageSource } from "../utils/receiptPdfPage.js";
import { cdpEvaluateOnUrl, withHeadlessCdpPage } from "../services/chromeCdp.js";
import {
  findReceiptChromium,
  measurePdfPageSizeMm,
  printPdfViaChromiumCli,
  renderReceiptHtmlToPdf,
} from "../services/windowsSilentPrint.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "tmp", "receipt-pdf-compare");

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
    receiptNumber: `INV-COMPARE-${lineCount}`,
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

async function renderCliPdf(browser, html, destPdf) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-cli-"));
  try {
    const measurePath = path.join(tmp, "measure.html");
    const printPath = path.join(tmp, "receipt.html");
    const pdfPath = path.join(tmp, "receipt.pdf");
    const measureProfile = path.join(tmp, "profile-measure");
    const printProfile = path.join(tmp, "profile-print");
    await fs.promises.mkdir(measureProfile);
    await fs.promises.writeFile(measurePath, html, "utf8");
    const raw = await cdpEvaluateOnUrl(
      browser,
      measureProfile,
      pathToFileURL(measurePath).href,
      receiptMeasurePageSource()
    );
    const diag = assembleReceiptHeightMeasure(raw);
    if (diag.calculatedHeightMm == null) throw new Error("CLI measure failed");
    const printHtml = applyReceiptPageSize(html, 80, diag.calculatedHeightMm);
    await fs.promises.writeFile(printPath, printHtml, "utf8");
    await printPdfViaChromiumCli(browser, printPath, pdfPath, printProfile);
    await fs.promises.copyFile(pdfPath, destPdf);
    return { ...measurePdfPageSizeMm(await fs.promises.readFile(pdfPath)), measuredHeightMm: diag.calculatedHeightMm };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function screenshotPrintHtml(browser, html, widthMm, heightMm, destPng) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-shot-"));
  try {
    const printPath = path.join(tmp, "receipt.html");
    const profileDir = path.join(tmp, "profile");
    await fs.promises.mkdir(profileDir);
    await fs.promises.writeFile(printPath, applyReceiptPageSize(html, widthMm, heightMm), "utf8");
    await withHeadlessCdpPage(
      browser,
      profileDir,
      { startUrl: pathToFileURL(printPath).href },
      async (session) => {
        const png = await session.capturePng();
        await fs.promises.writeFile(destPng, png);
      }
    );
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const browser = findReceiptChromium();
if (!browser) {
  console.error("Edge/Chrome not found; cannot compare PDFs.");
  process.exit(1);
}

await fs.promises.mkdir(OUT_DIR, { recursive: true });

const cases = [
  { name: "short", html: sampleReceipt(2) },
  { name: "long", html: sampleReceipt(28) },
];

const summary = [];
for (const c of cases) {
  const cdp = await renderReceiptHtmlToPdf(c.html);
  const cdpPdf = path.join(OUT_DIR, `${c.name}-cdp.pdf`);
  const cliPdf = path.join(OUT_DIR, `${c.name}-cli.pdf`);
  const png = path.join(OUT_DIR, `${c.name}-cdp.png`);
  try {
    await fs.promises.copyFile(cdp.pdfPath, cdpPdf);
    const cdpSize = measurePdfPageSizeMm(await fs.promises.readFile(cdp.pdfPath));
    const cliSize = await renderCliPdf(browser, c.html, cliPdf);
    await screenshotPrintHtml(browser, c.html, cdp.widthMm, cdp.heightMm, png);
    summary.push({
      name: c.name,
      cdp: { ...cdpSize, measuredHeightMm: cdp.heightMm, pdf: cdpPdf, png },
      cli: { ...cliSize, pdf: cliPdf },
      widthDeltaMm: Math.abs(cdpSize.widthMm - cliSize.widthMm),
      heightDeltaMm: Math.abs(cdpSize.heightMm - cliSize.heightMm),
    });
  } finally {
    await fs.promises.rm(cdp.tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const reportPath = path.join(OUT_DIR, "compare.json");
await fs.promises.writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${reportPath}`);
