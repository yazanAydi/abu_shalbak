import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { attemptOrNoop } from "../utils/receiptPrintTiming.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal ws:// client (Node 18 has no global WebSocket). WHATWG-shaped enough for CDP.
 */
class NetWebSocket {
  /**
   * @param {string} url
   */
  constructor(url) {
    this._listeners = { open: [], message: [], error: [], close: [] };
    this._buf = Buffer.alloc(0);
    this._opened = false;
    this._fragments = [];
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    this._socket = net.connect({ host: u.hostname, port: Number(u.port) || 80 }, () => {
      this._socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`
      );
    });
    this._socket.on("data", (chunk) => this._onData(chunk));
    this._socket.on("error", (err) => this._emit("error", err));
    this._socket.on("close", () => this._emit("close"));
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  send(data) {
    this._socket.write(encodeClientFrame(1, Buffer.from(String(data), "utf8")));
  }

  close() {
    try {
      this._socket.end();
    } catch {
      /* ignore */
    }
  }

  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) fn(ev);
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._opened) {
      const idx = this._buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const header = this._buf.subarray(0, idx).toString("utf8");
      this._buf = this._buf.subarray(idx + 4);
      if (!/HTTP\/1\.[01] 101/i.test(header)) {
        this._emit("error", new Error("websocket upgrade failed"));
        this._socket.destroy();
        return;
      }
      this._opened = true;
      this._emit("open");
    }
    this._readFrames();
  }

  _readFrames() {
    while (true) {
      const frame = decodeServerFrame(this._buf);
      if (!frame) break;
      this._buf = frame.rest;
      if (frame.opcode === 8) {
        this.close();
        return;
      }
      if (frame.opcode === 9) {
        this._socket.write(encodeClientFrame(10, frame.payload));
        continue;
      }
      if (frame.opcode === 1 || frame.opcode === 0) {
        this._fragments.push(frame.payload);
        if (frame.fin) {
          const data = Buffer.concat(this._fragments).toString("utf8");
          this._fragments = [];
          this._emit("message", { data });
        }
      }
    }
  }
}

function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const n = Number(buf.readBigUInt64BE(2));
    if (!Number.isSafeInteger(n)) return null;
    len = n;
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + len) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { fin, opcode, payload, rest: buf.subarray(offset + len) };
  }
  if (buf.length < offset + len) return null;
  return { fin, opcode, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) };
}

async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    const undici = await import("undici");
    if (undici.WebSocket) return undici.WebSocket;
  } catch {
    /* ignore */
  }
  return NetWebSocket;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw || "null"));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("devtools http timeout"));
    });
  });
}

async function waitForDevToolsPort(profileDir, timeoutMs = 15000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await fs.promises.readFile(file, "utf8");
      const port = Number(String(text).split(/\r?\n/)[0]);
      if (port > 0) return port;
    } catch {
      /* not ready */
    }
    await sleep(50);
  }
  const err = new Error("devtools port timeout");
  err.code = "DEVTOOLS_PORT_TIMEOUT";
  throw err;
}

async function waitForPageWs(port) {
  for (let i = 0; i < 40; i += 1) {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const page = (Array.isArray(list) ? list : []).find(
      (t) => t && t.webSocketDebuggerUrl && (t.type === "page" || t.type === "webview")
    );
    if (page) return page.webSocketDebuggerUrl;
    await sleep(100);
  }
  const err = new Error("no page target");
  err.code = "NO_PAGE_TARGET";
  throw err;
}

function connectCdp(WebSocketCtor, wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const once = new Map();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = (nextId += 1);
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        waitFor(method) {
          return new Promise((res) => {
            const list = once.get(method) || [];
            list.push(res);
            once.set(method, list);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    });

    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "cdp error"));
        else res(msg.result);
      }
      if (msg.method && once.has(msg.method)) {
        const fns = once.get(msg.method) || [];
        once.delete(msg.method);
        fns.forEach((fn) => fn(msg.params));
      }
    });

    ws.addEventListener("error", () => {
      const err = new Error("cdp websocket error");
      err.code = "CDP_WEBSOCKET_ERROR";
      reject(err);
    });
  });
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    const timer = setTimeout(done, 2000);
    if (typeof timer.unref === "function") timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref?.();
      killer.once("close", () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });
}

async function navigateAndWait(cdp, url, extra = {}) {
  const loaded = cdp.waitFor("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  const loadResult = await Promise.race([
    loaded.then(() => "loaded"),
    sleep(8000).then(() => "timeout"),
  ]);
  extra.loadTimedOut = loadResult === "timeout";
  extra.timeout = extra.loadTimedOut;
  for (let i = 0; i < 40; i += 1) {
    const ready = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    extra.readyState = ready?.result?.value || null;
    if (extra.readyState === "complete") break;
    await sleep(50);
  }
}

async function evaluateExpression(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    const err = new Error(result.exceptionDetails.text || "evaluate failed");
    err.code = "MEASURE_EVAL_FAILED";
    throw err;
  }
  return result?.result?.value;
}

/** CDP Page.printToPDF params matching CLI --no-pdf-header-footer and CSS @page size. */
export function receiptPdfPrintParams(widthMm, heightMm) {
  const w = Number(widthMm);
  const h = Number(heightMm);
  return {
    landscape: false,
    displayHeaderFooter: false,
    printBackground: true,
    preferCSSPageSize: true,
    paperWidth: Math.round((w / 25.4) * 10000) / 10000,
    paperHeight: Math.round((h / 25.4) * 10000) / 10000,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    scale: 1,
  };
}

function createCdpSession(cdp) {
  return {
    async goto(url, extra = {}) {
      await navigateAndWait(cdp, url, extra);
    },
    async evaluate(expression) {
      return evaluateExpression(cdp, expression);
    },
    async printToPdf({ widthMm, heightMm }) {
      await cdp.send("Emulation.setEmulatedMedia", { media: "print" }).catch(() => {});
      const result = await cdp.send("Page.printToPDF", receiptPdfPrintParams(widthMm, heightMm));
      if (!result?.data) {
        const err = new Error("printToPDF returned no data");
        err.code = "PDF_FAILED";
        throw err;
      }
      return Buffer.from(result.data, "base64");
    },
    async capturePng() {
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      if (!result?.data) {
        const err = new Error("captureScreenshot returned no data");
        err.code = "PDF_FAILED";
        throw err;
      }
      return Buffer.from(result.data, "base64");
    },
  };
}

/**
 * One headless Edge/Chrome process for this job. Caller must finish before return;
 * the process is always killed (success or failure). Not a persistent pool.
 */
export async function withHeadlessCdpPage(browserExe, profileDir, { attempt, startUrl } = {}, fn) {
  const t = attemptOrNoop(attempt);
  const WebSocketCtor = await resolveWebSocket();
  if (!WebSocketCtor) {
    const err = new Error("NO_WEBSOCKET");
    err.code = "NO_WEBSOCKET";
    throw err;
  }

  const child = spawn(
    browserExe,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { windowsHide: true }
  );

  let cdp = null;
  try {
    const launchExtra = { loadTimedOut: false };
    await t.time(
      "measure_browser_ready",
      async () => {
        const port = await waitForDevToolsPort(profileDir);
        const wsUrl = await waitForPageWs(port);
        cdp = await connectCdp(WebSocketCtor, wsUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        if (startUrl) await navigateAndWait(cdp, startUrl, launchExtra);
      },
      launchExtra
    );
    return await fn(createCdpSession(cdp));
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    await killProcessTree(child);
  }
}

/**
 * Open headless Chromium, navigate to url, evaluate an expression (may return a Promise).
 * @param {string} browserExe
 * @param {string} profileDir
 * @param {string} url
 * @param {string} expression
 * @param {object|null} [attempt]
 */
export async function cdpEvaluateOnUrl(browserExe, profileDir, url, expression, attempt) {
  const t = attemptOrNoop(attempt);
  return withHeadlessCdpPage(browserExe, profileDir, { attempt: t, startUrl: url }, async (session) =>
    t.time("measure_fonts_height", () => session.evaluate(expression))
  );
}

export { resolveWebSocket, NetWebSocket };
