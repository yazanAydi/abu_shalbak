import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { shouldConfirmPrintDialog } from "../utils/receiptPrintDialogMatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIRM_SCRIPT = path.join(__dirname, "..", "scripts", "confirm-receipt-print-dialog.ps1");

export const HELPER_UNAVAILABLE_AR =
  "تعذر الاتصال بمساعد طباعة ويندوز. تم حفظ البيع. استخدم إعادة الطباعة.";

function defaultPrinterName(env = process.env) {
  return String(env.RECEIPT_PRINTER || "").trim();
}

function runJson(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("confirm-timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr?.on("data", (buf) => {
      stderr += String(buf);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `confirm-exit-${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch {
        reject(new Error("confirm-bad-json"));
      }
    });
  });
}

export function createReceiptPrintDialogHelper({
  printHtml,
  findOwnerPids,
  confirmDialog,
  printerName,
  testSave = false,
  now = () => Date.now(),
} = {}) {
  const configuredPrinter = printerName || defaultPrinterName();
  const allowMissingPrinter = Boolean(testSave);
  let armed = null;

  function clearArmed() {
    armed = null;
  }

  function getArmed() {
    return armed;
  }

  async function arm(body) {
    const requestId = String(body?.requestId || "").trim();
    const ownerTitle = String(body?.ownerTitle || "").trim();
    const transactionId = Number(body?.transactionId);
    const requestedPrinter = String(body?.printerName || configuredPrinter).trim();
    if (!requestId || !ownerTitle) {
      return { ok: false, error: "طلب تسليح الطباعة غير صالح", code: "BAD_ARM" };
    }
    if (!configuredPrinter) {
      return { ok: false, error: "RECEIPT_PRINTER غير معيّن", code: "NO_PRINTER" };
    }
    if (requestedPrinter !== configuredPrinter) {
      return { ok: false, error: "اسم الطابعة لا يطابق الإعداد", code: "PRINTER_MISMATCH" };
    }
    const ownerPids = await findOwnerPids(ownerTitle);
    if (!ownerPids?.length) {
      return { ok: false, error: "تعذر تحديد نافذة نقطة البيع", code: "NO_POS_WINDOW" };
    }
    armed = {
      requestId,
      ownerTitle,
      transactionId: Number.isFinite(transactionId) ? transactionId : null,
      printerName: configuredPrinter,
      ownerPids: ownerPids.map(Number),
      armedAt: now(),
    };
    return { ok: true, armed: true, requestId, printer: configuredPrinter, ownerPids: armed.ownerPids };
  }

  function disarm(requestId) {
    if (armed && requestId && armed.requestId !== String(requestId)) {
      return { ok: false, code: "REQUEST_MISMATCH" };
    }
    clearArmed();
    return { ok: true, armed: false };
  }

  async function printArmed(body) {
    const requestId = String(body?.requestId || "").trim();
    const html = body?.html;
    if (!armed || armed.requestId !== requestId) {
      return { ok: false, error: "الطلب غير مسلّح للطباعة", code: "NOT_ARMED" };
    }
    if (!html || typeof html !== "string") {
      clearArmed();
      return { ok: false, error: "لا يوجد إيصال للطباعة", code: "NO_HTML" };
    }
    const job = armed;
    const ownerPids = [...job.ownerPids, process.pid];
    const confirmP = confirmDialog({
      requestId: job.requestId,
      printerName: job.printerName,
      ownerPids,
    }).catch((err) => ({ confirm: false, reason: err?.message || "confirm-failed" }));

    try {
      const printed = await printHtml(html);
      if (printed?.printed) {
        return {
          ok: true,
          printed: true,
          printer: printed.printer || job.printerName,
        };
      }
      return {
        ok: false,
        error: "فشلت طباعة الإيصال",
        code: "PRINT_FAILED",
      };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || "فشلت طباعة الإيصال",
        code: err?.code || "PRINT_FAILED",
      };
    } finally {
      clearArmed();
      void confirmP;
    }
  }

  /**
   * Print saved-sale HTML on this PC. No window title, no arm, no dialog click.
   * printed:true means the Windows print API accepted the job, not that paper exited.
   */
  async function printDirect(body) {
    const html = body?.html;
    const transactionId = Number(body?.transactionId);
    if (!configuredPrinter && !allowMissingPrinter) {
      return { ok: false, error: "RECEIPT_PRINTER غير معيّن", code: "NO_PRINTER" };
    }
    if (!html || typeof html !== "string" || !html.trim()) {
      return { ok: false, error: "لا يوجد إيصال للطباعة", code: "NO_HTML" };
    }
    if (typeof printHtml !== "function") {
      return { ok: false, error: "فشلت طباعة الإيصال", code: "PRINT_FAILED" };
    }
    try {
      const printed = await printHtml(html);
      if (printed?.printed) {
        const result = {
          ok: true,
          printed: true,
          printer: printed.printer || configuredPrinter,
          transactionId: Number.isFinite(transactionId) && transactionId > 0 ? transactionId : null,
        };
        if (printed.testMode) {
          result.testMode = true;
          if (printed.pdfPath) result.pdfPath = printed.pdfPath;
        }
        return result;
      }
      return { ok: false, error: "فشلت طباعة الإيصال", code: "PRINT_FAILED" };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || "فشلت طباعة الإيصال",
        code: err?.code || "PRINT_FAILED",
      };
    }
  }

  return {
    configuredPrinter,
    getArmed,
    arm,
    disarm,
    printArmed,
    printDirect,
  };
}

export async function findOwnerPidsByTitle(ownerTitle) {
  if (process.platform !== "win32") return [];
  const title = String(ownerTitle || "").replace(/'/g, "''");
  const script = `
    $title = '${title}'
    Get-Process | Where-Object {
      $_.MainWindowTitle -and $_.MainWindowTitle -eq $title
    } | Select-Object -ExpandProperty Id | ConvertTo-Json
  `;
  try {
    const raw = await runJson("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
    if (Number.isFinite(Number(raw))) return [Number(raw)];
    return [];
  } catch {
    return [];
  }
}

export async function confirmArmedPrintDialog({ requestId, printerName, ownerPids }) {
  if (process.platform !== "win32") {
    return { confirm: false, reason: "not-windows" };
  }
  const snapshot = await runJson(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      CONFIRM_SCRIPT,
      "-PrinterName",
      printerName,
      "-OwnerPids",
      ownerPids.join(","),
      "-RequestId",
      requestId,
    ],
    { timeoutMs: 20000 }
  );
  const decision = shouldConfirmPrintDialog({
    armed: true,
    requestId,
    dialogRequestId: snapshot.requestId || requestId,
    dialogName: snapshot.dialogName,
    printerName,
    dialogPrinterName: snapshot.dialogPrinterName,
    ownerPids,
    dialogProcessId: snapshot.dialogProcessId,
    dialogOwnerProcessId: snapshot.dialogOwnerProcessId,
    printButtonEnabled: Boolean(snapshot.printButtonEnabled),
  });
  if (!decision.confirm) {
    return { confirm: false, reason: decision.reason, snapshot };
  }
  if (snapshot.invoked) {
    return { confirm: true, reason: "ok", snapshot };
  }
  return { confirm: false, reason: "invoke-skipped", snapshot };
}
