/**
 * Cashier-PC helper (outside Docker). Prints one POS receipt via
 * printReceiptHtmlLocally. No window lookup and no Print-dialog click.
 *
 *   node backend/scripts/receipt-print-dialog-helper.mjs
 *
 * Loads only .env.cashier-print (not .env.store). Bind 127.0.0.1:17892.
 */
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  isReceiptPrintTestSave,
  printReceiptHtmlLocally,
  receiptTestOutputDir,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";
import { createReceiptPrintDialogHelper } from "../services/receiptPrintDialogHelper.js";
import {
  decideReceiptPrintAccess,
  parseReceiptPrintAllowedOrigins,
  receiptPrintCorsHeaders,
} from "../utils/receiptPrintHelperAccess.js";
import {
  CASHIER_PRINT_HELPER_SERVICE,
  CASHIER_PRINT_HELPER_VERSION,
} from "../utils/cashierPrintHelperVersion.js";
import {
  configureHelperStdio,
  createReceiptPrintAttempt,
} from "../utils/receiptPrintTiming.js";

configureHelperStdio();

const REPO_ROOT =
  process.env.CASHIER_PRINT_ROOT ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASHIER_ENV = process.env.CASHIER_PRINT_ENV || path.join(REPO_ROOT, ".env.cashier-print");

if (!fs.existsSync(CASHIER_ENV)) {
  console.error("[receipt-print-dialog-helper] Missing .env.cashier-print. Copy .env.cashier-print.example.");
  process.exit(1);
}
dotenv.config({ path: CASHIER_ENV });

const TIMING_LOG = path.join(REPO_ROOT, "data", "receipt-print-dialog-helper.out.log");
const TIMING_ERR = path.join(REPO_ROOT, "data", "receipt-print-dialog-helper.err.log");
const HOST = "127.0.0.1";
const PORT = Number(process.env.RECEIPT_PRINT_DIALOG_HELPER_PORT) || 17892;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const allowedOrigins = parseReceiptPrintAllowedOrigins();

if (process.platform !== "win32") {
  console.error("Receipt print helper must run on the cashier Windows PC.");
  process.exit(1);
}

const helper = createReceiptPrintDialogHelper({
  printerName: String(process.env.RECEIPT_PRINTER || "").trim(),
  printHtml: (html, attempt) => printReceiptHtmlLocally(html, attempt),
  testSave: isReceiptPrintTestSave(),
});

function corsFor(req) {
  return receiptPrintCorsHeaders(req.headers.origin, allowedOrigins);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body ?? {});
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = Buffer.byteLength(payload);
  res.writeHead(status, headers);
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
  const access = decideReceiptPrintAccess(
    {
      method: req.method,
      path: url,
      origin: req.headers.origin,
      loopback: isLoopback(req),
    },
    allowedOrigins
  );
  const cors = access.cors ? corsFor(req) : {};

  if (!access.ok) {
    sendJson(res, access.status, { ok: false, error: access.error, code: access.code }, cors);
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, cors);
    return;
  }

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    sendJson(
      res,
      200,
      {
        ok: true,
        service: CASHIER_PRINT_HELPER_SERVICE,
        version: CASHIER_PRINT_HELPER_VERSION,
        printer: helper.configuredPrinter || null,
        allowedOrigins,
        testMode: isReceiptPrintTestSave(),
        pdfDir: isReceiptPrintTestSave() ? receiptTestOutputDir() : null,
        timingLog: TIMING_LOG,
      },
      cors
    );
    return;
  }

  if (req.method === "POST" && url === "/print") {
    const attempt = createReceiptPrintAttempt();
    let finishedByPrint = false;
    try {
      const body = await readJsonBody(req);
      const result = await helper.printDirect(body, attempt);
      finishedByPrint = true;
      await attempt.flush();
      sendJson(res, result.ok ? 200 : 409, result, cors);
      return;
    } catch (e) {
      if (!finishedByPrint) {
        attempt.fail("print_request", e);
        attempt.finish({ ok: false, errorCode: e.code || "PRINT_FAILED" });
      }
      await attempt.flush();
      if (e instanceof SilentPrintError) {
        sendJson(res, 409, { ok: false, error: e.message, code: e.code }, cors);
        return;
      }
      if (e.code === "BAD_JSON" || e.code === "BODY_TOO_LARGE") {
        sendJson(res, 400, { ok: false, error: "طلب الطباعة غير صالح", code: "NO_HTML" }, cors);
        return;
      }
      sendJson(res, 500, { ok: false, error: e.message || "فشلت طباعة الإيصال", code: "PRINT_FAILED" }, cors);
      return;
    }
  }

  sendJson(res, 404, { error: "not found", code: "NOT_FOUND" }, cors);
});

if (!helper.configuredPrinter && !isReceiptPrintTestSave()) {
  console.error("[receipt-print-dialog-helper] Set RECEIPT_PRINTER in .env.cashier-print to the exact Windows printer name.");
  process.exit(1);
}
if (!allowedOrigins.length) {
  console.error("[receipt-print-dialog-helper] Set RECEIPT_PRINT_ALLOWED_ORIGINS in .env.cashier-print.");
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const testSave = isReceiptPrintTestSave();
  const extra = testSave ? ` pdfDir=${receiptTestOutputDir()}` : "";
  console.log(
    `[receipt-print-dialog-helper] http://${HOST}:${PORT} version=${CASHIER_PRINT_HELPER_VERSION} printer=${helper.configuredPrinter || (testSave ? "test-save" : "?")} origins=${allowedOrigins.join(",") || "?"} testMode=${testSave}${extra}`
  );
  console.log(`[receipt-print-dialog-helper] timing stdout=${TIMING_LOG} stderr=${TIMING_ERR}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
