import { spawn } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const require = createRequire(import.meta.url);

const VIRTUAL_PRINTER = /PDF|XPS|OneNote|Fax|Snagit/i;

export class SilentPrintError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
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

function run(cmd, args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
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
      if (code === 0) resolve();
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

export async function resolveReceiptPrinterName() {
  const named = process.env.RECEIPT_PRINTER && String(process.env.RECEIPT_PRINTER).trim();
  if (named) {
    if (!RECEIPT_PRINTER_NAME_RE.test(named)) {
      throw new SilentPrintError("INVALID_PRINTER", "اسم الطابعة غير صالح");
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

async function htmlToPdf(html) {
  const browser = findChromium();
  if (!browser) {
    throw new SilentPrintError(
      "NO_BROWSER",
      "لم يُعثر على Edge أو Chrome لتحويل الإيصال. ثبّت Microsoft Edge."
    );
  }
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "abo-receipt-"));
  const htmlPath = path.join(tmp, "receipt.html");
  const pdfPath = path.join(tmp, "receipt.pdf");
  const profileDir = path.join(tmp, "profile");
  await fs.promises.writeFile(htmlPath, html, "utf8");
  await fs.promises.mkdir(profileDir);
  await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pdf-header-footer",
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ]);
  const stat = await fs.promises.stat(pdfPath).catch(() => null);
  if (!stat || stat.size < 100) {
    throw new SilentPrintError("PDF_FAILED", "فشل تحويل الإيصال إلى PDF");
  }
  return { pdfPath, tmp };
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

async function printPdfFile(pdfPath, printerName) {
  const mod = loadPdfToPrinter();
  const print = typeof mod.print === "function" ? mod.print : mod.default;
  if (typeof print !== "function") {
    throw new SilentPrintError("NO_PRINT_HELPER", "تعذّر استدعاء مكتبة الطباعة");
  }
  await print(pdfPath, {
    printer: printerName,
    silent: true,
    scale: "noscale",
  });
}

/** @type {null | ((html: string) => Promise<{ printed: boolean, printer?: string, dryRun?: boolean }>)} */
let testAdapter = null;

/** Test-only hook to simulate printer success/failure without Windows hardware. */
export function setSilentPrintTestAdapter(fn) {
  if (process.env.NODE_ENV !== "test") return;
  testAdapter = typeof fn === "function" ? fn : null;
}

/**
 * Print receipt HTML on the Windows machine that runs the API, with no browser dialog.
 * @param {string} html
 * @returns {Promise<{ printed: boolean, printer?: string, dryRun?: boolean }>}
 */
export async function silentPrintReceiptHtml(html) {
  if (!html || typeof html !== "string") {
    throw new SilentPrintError("NO_HTML", "لا يوجد إيصال للطباعة");
  }
  if (process.env.NODE_ENV === "test") {
    if (testAdapter) return testAdapter(html);
    return { printed: true, dryRun: true };
  }
  if (process.platform !== "win32") {
    throw new SilentPrintError(
      "SILENT_PRINT_UNSUPPORTED",
      "الطباعة المباشرة تعمل عندما يعمل الخادم على ويندوز (جهاز الكاشير)، وليس من Docker/Linux."
    );
  }

  const printerName = await resolveReceiptPrinterName();

  let tmpDir = null;
  try {
    const { pdfPath, tmp } = await htmlToPdf(html);
    tmpDir = tmp;
    await printPdfFile(pdfPath, printerName);
    return { printed: true, printer: printerName };
  } finally {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
