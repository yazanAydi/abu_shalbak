/**
 * Windows-only silent receipt printer. Runs on the shop PC next to Docker.
 * The Linux API forwards HTML here via host.docker.internal.
 *
 *   node backend/scripts/receipt-print-agent.mjs
 */
import http from "http";
import {
  isReceiptPrintTestSave,
  printReceiptHtmlLocally,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";

process.env.ABO_ENV = process.env.ABO_ENV || "store";
await import("../loadEnv.js");

const HOST = "127.0.0.1";
const PORT = Number(process.env.RECEIPT_PRINT_AGENT_PORT) || 17891;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

if (process.platform !== "win32") {
  console.error("Receipt print agent must run on Windows (not inside Docker).");
  process.exit(1);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

function agentHttpStatus(code) {
  if (code === "VIRTUAL_PRINTER" || code === "NO_PRINTER") return 409;
  if (code === "NO_HTML" || code === "INVALID_PRINTER") return 400;
  return 500;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ? req.url.split("?")[0] : "/";

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    sendJson(res, 200, { ok: true, service: "receipt-print-agent" });
    return;
  }

  if (req.method === "POST" && url === "/print") {
    try {
      const body = await readJsonBody(req);
      const html = body && body.html;
      const result = await printReceiptHtmlLocally(html);
      const payload = { printed: true, printer: result.printer || null };
      if (result.testMode) {
        payload.testMode = true;
        payload.pdfPath = result.pdfPath;
        payload.widthMm = result.widthMm;
        payload.heightMm = result.heightMm;
      }
      sendJson(res, 200, payload);
    } catch (e) {
      if (e instanceof SilentPrintError) {
        const payload = { error: e.message, code: e.code };
        if (e.details && (isReceiptPrintTestSave() || process.env.NODE_ENV === "development")) {
          payload.details = e.details;
        }
        sendJson(res, agentHttpStatus(e.code), payload);
        return;
      }
      if (e.code === "BAD_JSON" || e.code === "BODY_TOO_LARGE") {
        sendJson(res, 400, { error: "طلب الطباعة غير صالح", code: "NO_HTML" });
        return;
      }
      sendJson(res, 500, {
        error: e.message || "فشلت طباعة الإيصال",
        code: "PRINT_FAILED",
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
});

server.listen(PORT, HOST, () => {
  console.log(`[receipt-print-agent] listening on http://${HOST}:${PORT}`);
  if (isReceiptPrintTestSave()) {
    console.log("[receipt-print-agent] RECEIPT_PRINT_TEST_MODE=save — PDFs go to tmp/receipt-test/");
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
