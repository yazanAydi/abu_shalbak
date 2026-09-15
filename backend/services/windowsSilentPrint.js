import { spawn } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  applyReceiptPageSize,
  assembleReceiptHeightMeasure,
  injectReceiptMeasureHook,
  parseReceiptMeasureFromDom,
  receiptMeasurePageSource,
  receiptPrintReadySource,
  receiptPrintWidthMm,
} from "../utils/receiptPdfPage.js";
import { withHeadlessCdpPage } from "./chromeCdp.js";
import { attemptOrNoop } from "../utils/receiptPrintTiming.js";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PT_TO_MM = 25.4 / 72;

const VIRTUAL_PRINTER = /PDF|XPS|OneNote|Fax|Snagit/i;

/** @returns {boolean} */
export function isReceiptPrintTestSave(env = process.env) {
  return String(env.RECEIPT_PRINT_TEST_MODE || "").trim().toLowerCase() === "save";
}

export function receiptTestOutputDir() {
  const root = String(process.env.CASHIER_PRINT_ROOT || "").trim() || REPO_ROOT;
  return path.join(root, "tmp", "receipt-test");
}

/**
 * Read the first page MediaBox from a generated PDF (points → mm).
 * @param {Buffer|string} pdfBytes
 * @returns {{ widthMm: number, heightMm: number }}
 */
export function measurePdfPageSizeMm(pdfBytes) {
  const text = Buffer.isBuffer(pdfBytes) ? pdfBytes.toString("latin1") : String(pdfBytes);
  const m = text.match(/\/MediaBox\s*\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\]/);
  if (!m) {
    throw new SilentPrintError("PDF_FAILED", "تعذّر قراءة مقاس صفحة الإيصال من PDF");
  }
  const widthPt = Number(m[3]) - Number(m[1]);
  const heightPt = Number(m[4]) - Number(m[2]);
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt) || widthPt <= 0 || heightPt <= 0) {
    throw new SilentPrintError("PDF_FAILED", "مقاس صفحة الإيصال غير صالح");
  }
  return {
    widthMm: Math.round(widthPt * PT_TO_MM * 100) / 100,
    heightMm: Math.round(heightPt * PT_TO_MM * 100) / 100,
  };
}

export async function persistReceiptTestPdf(srcPdfPath) {
  const dir = receiptTestOutputDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `receipt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.pdf`);
  await fs.promises.copyFile(srcPdfPath, dest);
  const buf = await fs.promises.readFile(dest);
  const { widthMm, heightMm } = measurePdfPageSizeMm(buf);
  return { pdfPath: dest, widthMm, heightMm };
}

export class SilentPrintError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function findChromium() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function run(cmd, args, { timeoutMs = 45000, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (captureStdout) {
      child.stdout?.on("data", (buf) => {
        stdout += String(buf);
      });
    }
    child.stderr?.on("data", (buf) => {
      stderr += String(buf);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new SilentPrintError("PRINT_TIMEOUT", "انتهت مهلة تجهيز الإيصال للطباعة"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(captureStdout ? stdout : undefined);
      else reject(new SilentPrintError("PRINT_FAILED", stderr.trim() || `print helper exited ${code}`));
    });
  });
}

function powershellJson(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (buf) => {
      out += String(buf);
    });
    child.stderr.on("data", (buf) => {
      err += String(buf);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new SilentPrintError("PRINTER_QUERY_FAILED", err.trim() || "تعذّر قراءة الطابعة الافتراضية"));
        return;
      }
      try {
        resolve(JSON.parse(out.trim() || "null"));
      } catch {
        resolve(null);
      }
    });
  });
}

const RECEIPT_PRINTER_NAME_RE = /^[\w \-\.\(\)\\]+$/;

export function receiptPrintAgentToken(env = process.env) {
  return String(env.RECEIPT_PRINT_AGENT_TOKEN || "").trim();
}

export function receiptPrintAgentHeaders(env = process.env) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const token = receiptPrintAgentToken(env);
  if (token) headers["X-Receipt-Print-Token"] = token;
  return headers;
}

async function listInstalledPrinterNames() {
  try {
    const { getPrinters } = loadPdfToPrinter();
    if (typeof getPrinters === "function") {
      const all = await getPrinters();
      return (all || []).map((p) => p?.name).filter(Boolean);
    }
  } catch {
    /* fall through */
  }
  const row = await powershellJson(
    `@(Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress`
  );
  if (Array.isArray(row)) return row.map(String);
  if (typeof row === "string" && row.trim()) return [row.trim()];
  return [];
}

/**
 * Startup check: named RECEIPT_PRINTER must exist and must not be Print to PDF.
 * If unset, Windows default must be a real thermal printer.
 */
export async function assertReceiptPrinterReady() {
  if (isReceiptPrintTestSave()) {
    return { printer: null, testMode: true, printerOk: true };
  }
  const named = process.env.RECEIPT_PRINTER && String(process.env.RECEIPT_PRINTER).trim();
  if (named) {
    if (!RECEIPT_PRINTER_NAME_RE.test(named)) {
      throw new SilentPrintError("INVALID_PRINTER", "اسم الطابعة غير صالح");
    }
    if (VIRTUAL_PRINTER.test(named)) {
      throw new SilentPrintError(
        "VIRTUAL_PRINTER",
        `الطابعة "${named}" ليست طابعة إيصالات (Print to PDF / XPS). عيّن RECEIPT_PRINTER للطابعة الحرارية.`
      );
    }
    const names = await listInstalledPrinterNames().catch(() => []);
    if (names.length > 0 && !names.includes(named)) {
      throw new SilentPrintError("NO_PRINTER", `الطابعة "${named}" غير مثبتة على ويندوز`);
    }
    return { printer: named, testMode: false, printerOk: true };
  }
  const printer = await resolveReceiptPrinterName();
  return { printer, testMode: false, printerOk: true };
}

export async function resolveReceiptPrinterName() {
  const named = process.env.RECEIPT_PRINTER && String(process.env.RECEIPT_PRINTER).trim();
  if (named) {
    if (!RECEIPT_PRINTER_NAME_RE.test(named)) {
      throw new SilentPrintError("INVALID_PRINTER", "اسم الطابعة غير صالح");
    }
    if (VIRTUAL_PRINTER.test(named)) {
      throw new SilentPrintError(
        "VIRTUAL_PRINTER",
        `الطابعة "${named}" ليست طابعة إيصالات (Print to PDF / XPS). عيّن RECEIPT_PRINTER للطابعة الحرارية.`
      );
    }
    return named;
  }

  try {
    const { getDefaultPrinter, getPrinters } = loadPdfToPrinter();
    const def = await getDefaultPrinter();
    if (def?.name && !VIRTUAL_PRINTER.test(def.name)) return def.name;
    const all = typeof getPrinters === "function" ? await getPrinters() : [];
    const real = (all || []).find((p) => p?.name && !VIRTUAL_PRINTER.test(p.name));
    if (real?.name) return real.name;
    if (def?.name) {
      throw new SilentPrintError(
        "VIRTUAL_PRINTER",
        `الطابعة الافتراضية هي "${def.name}". عيّن طابعة الإيصالات كافتراضية (ليست Print to PDF).`
      );
    }
  } catch (e) {
    if (e instanceof SilentPrintError) throw e;
  }

  const row = await powershellJson(
    `($p = Get-CimInstance -ClassName Win32_Printer -Filter "Default=True" | Select-Object -First 1).Name | ConvertTo-Json -Compress`
  );
  const fallback = typeof row === "string" && row.trim() ? row.trim() : null;
  if (!fallback) {
    throw new SilentPrintError("NO_PRINTER", "لا توجد طابعة افتراضية في ويندوز");
  }
  if (VIRTUAL_PRINTER.test(fallback)) {
    throw new SilentPrintError(
      "VIRTUAL_PRINTER",
      `الطابعة الافتراضية هي "${fallback}". عيّن طابعة الإيصالات كافتراضية (ليست Print to PDF).`
    );
  }
  return fallback;
}

function includeReceiptMeasureDiagnostics() {
  return isReceiptPrintTestSave() || process.env.NODE_ENV === "development";
}

function throwMeasureFailed(diag) {
  const details = diag || assembleReceiptHeightMeasure({});
  const suffix = includeReceiptMeasureDiagnostics() ? ` ${JSON.stringify(details)}` : "";
  throw new SilentPrintError("PDF_FAILED", `تعذّر قياس ارتفاع محتوى الإيصال${suffix}`, details);
}

function fallbackReason(err) {
  if (err?.code) return String(err.code);
  const msg = String(err?.message || "cdp_failed").replace(/\s+/g, " ").trim();
  return msg.length > 80 ? `${msg.slice(0, 80)}…` : msg || "cdp_failed";
}

function browserLabel(browserPath) {
  const base = path.basename(String(browserPath || ""));
  if (/msedge/i.test(base)) return "msedge";
  if (/chrome/i.test(base)) return "chrome";
  return base || "unknown";
}

async function measureReceiptViaDumpDom(browser, measureHtmlPath, profileDir) {
  const measureHtml = injectReceiptMeasureHook(await fs.promises.readFile(measureHtmlPath, "utf8"));
  await fs.promises.writeFile(measureHtmlPath, measureHtml, "utf8");
  const dom = await run(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--virtual-time-budget=8000",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      pathToFileURL(measureHtmlPath).href,
    ],
    { timeoutMs: 45000, captureStdout: true }
  );
  return parseReceiptMeasureFromDom(dom);
}

function pdfFileOk(pdfPath) {
  try {
    const stat = fs.statSync(pdfPath);
    return Boolean(stat && stat.size >= 100);
  } catch {
    return false;
  }
}

async function printPdfViaChromiumCli(browser, printHtmlPath, pdfPath, profileDir) {
  await fs.promises.mkdir(profileDir, { recursive: true });
  await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pdf-header-footer",
    "--virtual-time-budget=3000",
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(printHtmlPath).href,
  ]);
  if (!pdfFileOk(pdfPath)) {
    throw new SilentPrintError("PDF_FAILED", "فشل تحويل الإيصال إلى PDF");
  }
}

async function htmlToPdf(html, attempt) {
  const t = attemptOrNoop(attempt);
  const browser = findChromium();
  if (!browser) {
    const err = new SilentPrintError(
      "NO_BROWSER",
      "لم يُعثر على Edge أو Chrome لتحويل الإيصال. ثبّت Microsoft Edge."
    );
    t.fail("measure_browser_ready", err);
    throw err;
  }
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-"));
  const measurePath = path.join(tmp, "measure.html");
  const printPath = path.join(tmp, "receipt.html");
  const pdfPath = path.join(tmp, "receipt.pdf");
  const measureProfile = path.join(tmp, "profile-measure");
  const printProfile = path.join(tmp, "profile-print");
  await fs.promises.mkdir(measureProfile);
  await fs.promises.writeFile(measurePath, html, "utf8");

  let diag = null;
  const widthMm = receiptPrintWidthMm();
  let heightMm = null;

  const pdfExtra = (pdfMode, extra = {}) => ({
    browser: browserLabel(browser),
    pdfMode,
    pageWidthMm: widthMm,
    pageHeightMm: heightMm,
    calculatedHeightPx: diag?.calculatedHeightPx ?? null,
    receiptSelectorFound: Boolean(diag?.receiptSelectorFound),
    ...extra,
  });

  try {
    await withHeadlessCdpPage(
      browser,
      measureProfile,
      { attempt: t, startUrl: pathToFileURL(measurePath).href },
      async (session) => {
        const raw = await t.time("measure_fonts_height", () =>
          session.evaluate(receiptMeasurePageSource())
        );
        diag = assembleReceiptHeightMeasure(raw);
        if (isReceiptPrintTestSave()) {
          console.log({
            receiptSelectorFound: diag.receiptSelectorFound,
            rectHeight: diag.rectHeight,
            receiptScrollHeight: diag.receiptScrollHeight,
            bodyScrollHeight: diag.bodyScrollHeight,
            calculatedHeightPx: diag.calculatedHeightPx,
            calculatedHeightMm: diag.calculatedHeightMm,
          });
        }
        if (diag.calculatedHeightPx == null || diag.calculatedHeightMm == null) {
          throwMeasureFailed(diag);
        }
        heightMm = diag.calculatedHeightMm;
        await fs.promises.writeFile(printPath, applyReceiptPageSize(html, widthMm, heightMm), "utf8");
        await t.time(
          "pdf_generation",
          async () => {
            const navExtra = { loadTimedOut: false };
            await session.goto(pathToFileURL(printPath).href, navExtra);
            await session.evaluate(receiptPrintReadySource());
            const pdfBuf = await session.printToPdf({ widthMm, heightMm });
            await fs.promises.writeFile(pdfPath, pdfBuf);
            if (!pdfFileOk(pdfPath)) {
              throw new SilentPrintError("PDF_FAILED", "فشل تحويل الإيصال إلى PDF");
            }
          },
          pdfExtra("cdp")
        );
      }
    );
  } catch (err) {
    if (pdfFileOk(pdfPath) && heightMm != null) {
      return { pdfPath, tmp, widthMm, heightMm };
    }
    const reason = fallbackReason(err);
    if (!diag || diag.calculatedHeightMm == null) {
      const dumpProfile = path.join(tmp, "profile-dump");
      await fs.promises.mkdir(dumpProfile, { recursive: true });
      diag = await t.time(
        "measure_fallback_dumpdom",
        () => measureReceiptViaDumpDom(browser, measurePath, dumpProfile),
        {
          reason,
          timeout:
            Boolean(err?.code && /timeout/i.test(String(err.code))) ||
            /timeout/i.test(String(err?.message || "")),
          virtualTimeBudgetMs: 8000,
        }
      );
    }
    if (diag.calculatedHeightPx == null || diag.calculatedHeightMm == null) {
      if (err instanceof SilentPrintError) throw err;
      throwMeasureFailed(diag);
    }
    heightMm = diag.calculatedHeightMm;
    await fs.promises.writeFile(printPath, applyReceiptPageSize(html, widthMm, heightMm), "utf8");
    await t.time(
      "pdf_generation",
      () => printPdfViaChromiumCli(browser, printPath, pdfPath, printProfile),
      pdfExtra("cli", { virtualTimeBudgetMs: 3000 })
    );
  }

  return { pdfPath, tmp, widthMm, heightMm };
}

function loadPdfToPrinter() {
  try {
    return require("pdf-to-printer");
  } catch {
    throw new SilentPrintError(
      "NO_PRINT_HELPER",
      "حزمة الطباعة غير مثبتة على الخادم (pdf-to-printer)"
    );
  }
}

function receiptPaperSizeOption() {
  const named = process.env.RECEIPT_PAPER_SIZE && String(process.env.RECEIPT_PAPER_SIZE).trim();
  return named || undefined;
}

async function printPdfFile(pdfPath, printerName) {
  const mod = loadPdfToPrinter();
  const print = typeof mod.print === "function" ? mod.print : mod.default;
  if (typeof print !== "function") {
    throw new SilentPrintError("NO_PRINT_HELPER", "تعذّر استدعاء مكتبة الطباعة");
  }
  const options = {
    printer: printerName,
    silent: true,
    scale: "noscale",
  };
  const paperSize = receiptPaperSizeOption();
  if (paperSize) options.paperSize = paperSize;
  await print(pdfPath, options);
}

const printPipeline = {
  htmlToPdf,
  printPdfFile,
  resolvePrinter: resolveReceiptPrinterName,
  platform: null,
};

/** Test-only: swap HTML→PDF / printer steps without Windows hardware. */
export function setPrintPipelineForTests(partial = null) {
  if (process.env.NODE_ENV !== "test") return;
  printPipeline.htmlToPdf = htmlToPdf;
  printPipeline.printPdfFile = printPdfFile;
  printPipeline.resolvePrinter = resolveReceiptPrinterName;
  printPipeline.platform = null;
  if (partial && typeof partial === "object") {
    if (partial.htmlToPdf) printPipeline.htmlToPdf = partial.htmlToPdf;
    if (partial.printPdfFile) printPipeline.printPdfFile = partial.printPdfFile;
    if (partial.resolvePrinter) printPipeline.resolvePrinter = partial.resolvePrinter;
    if (partial.platform) printPipeline.platform = partial.platform;
  }
}

const AGENT_UNAVAILABLE_AR =
  "تعذر الاتصال بطابعة الإيصالات. تأكد من تشغيل خدمة الطباعة ثم حاول مرة أخرى.";

export function receiptPrintAgentUrl() {
  const raw = process.env.RECEIPT_PRINT_AGENT_URL;
  const base = (raw && String(raw).trim()) || "http://host.docker.internal:17891";
  return base.replace(/\/$/, "");
}

/**
 * Forward receipt HTML to the Windows host print agent (Docker/Linux API).
 * @param {string} html
 * @param {typeof fetch} [fetchImpl]
 */
export async function forwardToPrintAgent(html, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new SilentPrintError("AGENT_UNAVAILABLE", AGENT_UNAVAILABLE_AR);
  }
  const url = `${receiptPrintAgentUrl()}/print`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: receiptPrintAgentHeaders(),
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new SilentPrintError("AGENT_UNAVAILABLE", AGENT_UNAVAILABLE_AR);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message = (body && body.error) || AGENT_UNAVAILABLE_AR;
    const code = (body && body.code) || "AGENT_UNAVAILABLE";
    const details = body && body.details ? body.details : null;
    if (res.status === 409) {
      throw new SilentPrintError(code, message, details);
    }
    if (res.status === 400) {
      throw new SilentPrintError(code === "AGENT_UNAVAILABLE" ? "NO_HTML" : code, message, details);
    }
    throw new SilentPrintError("AGENT_UNAVAILABLE", message, details);
  }

  const result = {
    printed: true,
    printer: (body && body.printer) || null,
    viaAgent: true,
  };
  if (body && body.testMode) {
    result.testMode = true;
    result.pdfPath = body.pdfPath || null;
    result.widthMm = body.widthMm != null ? Number(body.widthMm) : null;
    result.heightMm = body.heightMm != null ? Number(body.heightMm) : null;
  }
  return result;
}

/**
 * Print on this Windows process (Edge PDF → pdf-to-printer). Used by the host agent
 * and by a native Windows API. Never forwards to the agent.
 * RECEIPT_PRINT_TEST_MODE=save writes that same PDF to tmp/receipt-test/ and skips the printer.
 * @param {string} html
 */
export async function printReceiptHtmlLocally(html, attempt) {
  const t = attemptOrNoop(attempt);
  if (!html || typeof html !== "string") {
    throw new SilentPrintError("NO_HTML", "لا يوجد إيصال للطباعة");
  }

  const saveOnly = isReceiptPrintTestSave();
  if (!saveOnly) {
    const platform = printPipeline.platform || process.platform;
    if (platform !== "win32") {
      throw new SilentPrintError(
        "SILENT_PRINT_UNSUPPORTED",
        "الطباعة المباشرة تعمل عندما يعمل الخادم على ويندوز (جهاز الكاشير)، وليس من Docker/Linux."
      );
    }
  }

  let tmpDir = null;
  try {
    const { pdfPath, tmp } = await printPipeline.htmlToPdf(html, t);
    tmpDir = tmp;
    if (saveOnly) {
      t.mark("pdf_to_printer", { skipped: true, reason: "test_save" });
      const saved = await persistReceiptTestPdf(pdfPath);
      return {
        printed: true,
        testMode: true,
        pdfPath: saved.pdfPath,
        widthMm: saved.widthMm,
        heightMm: saved.heightMm,
      };
    }
    let printerName = null;
    await t.time("pdf_to_printer", async () => {
      printerName = await printPipeline.resolvePrinter();
      await printPipeline.printPdfFile(pdfPath, printerName);
    });
    return { printed: true, printer: printerName };
  } finally {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** @type {null | ((html: string) => Promise<{ printed: boolean, printer?: string, dryRun?: boolean }>)} */
let testAdapter = null;

/** Test-only hook to simulate printer success/failure without Windows hardware. */
export function setSilentPrintTestAdapter(fn) {
  if (process.env.NODE_ENV !== "test") return;
  testAdapter = typeof fn === "function" ? fn : null;
}

/**
 * Print receipt HTML with no browser dialog.
 * On Windows this process talks to the printer. On Linux/Docker it forwards to the
 * Windows host print agent at RECEIPT_PRINT_AGENT_URL.
 * @param {string} html
 * @returns {Promise<{ printed: boolean, printer?: string, dryRun?: boolean, viaAgent?: boolean }>}
 */
export async function silentPrintReceiptHtml(html) {
  if (!html || typeof html !== "string") {
    throw new SilentPrintError("NO_HTML", "لا يوجد إيصال للطباعة");
  }
  if (process.env.NODE_ENV === "test") {
    if (testAdapter) return testAdapter(html);
    if (isReceiptPrintTestSave()) {
      return printReceiptHtmlLocally(html);
    }
    return { printed: true, dryRun: true };
  }
  if (process.platform === "win32") {
    return printReceiptHtmlLocally(html);
  }
  return forwardToPrintAgent(html);
}

export { htmlToPdf as renderReceiptHtmlToPdf, printPdfViaChromiumCli, findChromium as findReceiptChromium };
