import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { spawn } from "child_process";

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
  throw new Error("devtools port timeout");
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
  throw new Error("no page target");
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
      reject(new Error("cdp websocket error"));
    });
  });
}

/**
 * Print the navigated document with CSS @page.
 * Does not pass paperWidth/paperHeight — preferCSSPageSize uses the document's @page box.
 * @returns {Promise<Buffer>}
 */
export async function cdpPrintToPdfOnUrl(
  browserExe,
  profileDir,
  url,
  { displayHeaderFooter = false } = {}
) {
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

  try {
    const port = await waitForDevToolsPort(profileDir);
    const wsUrl = await waitForPageWs(port);
    const cdp = await connectCdp(WebSocketCtor, wsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      const loaded = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url });
      await Promise.race([loaded, sleep(8000)]);
      for (let i = 0; i < 40; i += 1) {
        const ready = await cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (ready?.result?.value === "complete") break;
        await sleep(50);
      }
      await cdp
        .send("Runtime.evaluate", {
          expression:
            "document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()",
          awaitPromise: true,
          returnByValue: true,
        })
        .catch(() => {});
      const pdf = await cdp.send("Page.printToPDF", {
        printBackground: true,
        displayHeaderFooter,
        preferCSSPageSize: true,
      });
      if (!pdf?.data) {
        throw new Error("printToPDF returned no data");
      }
      return Buffer.from(pdf.data, "base64");
    } finally {
      cdp.close();
    }
  } finally {
    child.kill();
  }
}

/**
 * Open headless Chromium, navigate to url, evaluate an expression (may return a Promise).
 * @param {string} browserExe
 * @param {string} profileDir
 * @param {string} url
 * @param {string} expression
 */
export async function cdpEvaluateOnUrl(browserExe, profileDir, url, expression) {
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

  try {
    const port = await waitForDevToolsPort(profileDir);
    const wsUrl = await waitForPageWs(port);
    const cdp = await connectCdp(WebSocketCtor, wsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      const loaded = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url });
      await Promise.race([loaded, sleep(8000)]);
      for (let i = 0; i < 40; i += 1) {
        const ready = await cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (ready?.result?.value === "complete") break;
        await sleep(50);
      }
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "evaluate failed");
      }
      return result?.result?.value;
    } finally {
      cdp.close();
    }
  } finally {
    child.kill();
  }
}

export { resolveWebSocket, NetWebSocket };
