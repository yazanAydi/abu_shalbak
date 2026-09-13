/**
 * Cashier-PC helper (outside Docker). Arms one POS receipt print, prints via
 * the Windows path, and may confirm that job's Print dialog once.
 *
 *   node backend/scripts/receipt-print-dialog-helper.mjs
 */
import http from "http";
import {
  printReceiptHtmlLocally,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";
import {
  confirmArmedPrintDialog,
  createReceiptPrintDialogHelper,
  findOwnerPidsByTitle,
} from "../services/receiptPrintDialogHelper.js";

process.env.ABO_ENV = process.env.ABO_ENV || "store";
await import("../loadEnv.js");

const HOST = "127.0.0.1";
const PORT = Number(process.env.RECEIPT_PRINT_DIALOG_HELPER_PORT) || 17892;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

if (process.platform !== "win32") {
  console.error("Receipt print dialog helper must run on the cashier Windows PC.");
  process.exit(1);
}

const helper = createReceiptPrintDialogHelper({
  printerName: String(process.env.RECEIPT_PRINTER || "").trim(),
  printHtml: (html) => printReceiptHtmlLocally(html),
  findOwnerPids: findOwnerPidsByTitle,
  confirmDialog: confirmArmedPrintDialog,
});

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function clientIp(req) {
  const raw = req.socket?.remoteAddress || "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function isLoopback(req) {
  const ip = clientIp(req);
  return ip === "127.0.0.1" || ip === "::1";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (buf) => {
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid json"), { code: "BAD_JSON" }));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ? req.url.split("?")[0] : "/";
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "local only", code: "FORBIDDEN" });
    return;
  }

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    sendJson(res, 200, {
      ok: true,
      service: "receipt-print-dialog-helper",
      printer: helper.configuredPrinter || null,
      armed: Boolean(helper.getArmed()),
    });
    return;
  }

  try {
    if (req.method === "POST" && url === "/arm") {
      const body = await readJsonBody(req);
      const result = await helper.arm(body);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }
    if (req.method === "POST" && url === "/disarm") {
      const body = await readJsonBody(req);
      sendJson(res, 200, helper.disarm(body.requestId));
      return;
    }
    if (req.method === "POST" && url === "/print") {
      const body = await readJsonBody(req);
      const result = await helper.printArmed(body);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }
  } catch (e) {
    if (e instanceof SilentPrintError) {
      sendJson(res, 409, { ok: false, error: e.message, code: e.code });
      return;
    }
    if (e.code === "BAD_JSON" || e.code === "BODY_TOO_LARGE") {
      sendJson(res, 400, { ok: false, error: "طلب الطباعة غير صالح", code: "NO_HTML" });
      return;
    }
    sendJson(res, 500, { ok: false, error: e.message || "فشلت طباعة الإيصال", code: "PRINT_FAILED" });
    return;
  }

  sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
});

if (!helper.configuredPrinter) {
  console.error("[receipt-print-dialog-helper] Set RECEIPT_PRINTER to the exact Windows printer name.");
}

server.listen(PORT, HOST, () => {
  console.log(`[receipt-print-dialog-helper] http://${HOST}:${PORT} printer=${helper.configuredPrinter || "?"}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
