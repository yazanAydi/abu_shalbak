import crypto from "crypto";

export const RECEIPT_PRINT_TIMING_PREFIX = "[receipt-print-timing]";

const FORBIDDEN_EXTRA_KEYS = new Set([
  "html",
  "receipt_html",
  "receipt_text",
  "customer",
  "customername",
  "customer_name",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
]);

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

function roundMs(ms) {
  return Math.round(Number(ms) * 100) / 100;
}

function isTimeoutError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "").toLowerCase();
  return (
    code === "PRINT_TIMEOUT" ||
    /timeout/i.test(code) ||
    msg.includes("timeout") ||
    msg.includes("انتهت مهلة")
  );
}

function safeErrorMessage(err) {
  const raw = String(err?.message || err || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}

function sanitizeExtra(extra) {
  if (!extra || typeof extra !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (FORBIDDEN_EXTRA_KEYS.has(String(key).toLowerCase())) continue;
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function defaultWrite(line) {
  if (process.env.NODE_ENV === "test") return;
  const text = line.endsWith("\n") ? line : `${line}\n`;
  process.stdout.write(text);
}

/**
 * Make redirected stdout show timing lines without waiting for process exit.
 * Installed helper already pipes stdout to data/receipt-print-dialog-helper.out.log.
 * One-time at startup — not a per-stage disk write.
 */
export function configureHelperStdio() {
  if (process.stdout.isTTY) return;
  try {
    if (process.stdout._handle && typeof process.stdout._handle.setBlocking === "function") {
      process.stdout._handle.setBlocking(true);
    }
  } catch {
    /* ignore */
  }
}

export function flushTimingLog() {
  return new Promise((resolve) => {
    if (!process.stdout.write("")) {
      process.stdout.once("drain", resolve);
      return;
    }
    resolve();
  });
}

export const noopReceiptPrintAttempt = {
  printAttemptId: null,
  mark() {
    return null;
  },
  markSinceStart() {
    return null;
  },
  fail() {
    return null;
  },
  finish() {
    return null;
  },
  async time(_stage, fn) {
    return fn();
  },
  async flush() {},
};

export function attemptOrNoop(attempt) {
  return attempt && typeof attempt.time === "function" ? attempt : noopReceiptPrintAttempt;
}

/**
 * Monotonic print-attempt clock. Logs JSON lines to stdout (the installed
 * helper redirect). Does not write HTML, customer fields, or secrets.
 */
export function createReceiptPrintAttempt({ write = defaultWrite } = {}) {
  const printAttemptId = crypto.randomUUID();
  const t0 = nowNs();

  function emit(entry) {
    write(`${RECEIPT_PRINT_TIMING_PREFIX} ${JSON.stringify(entry)}`);
  }

  function record(stage, startNs, extra = {}) {
    const now = nowNs();
    const durationMs = roundMs(nsToMs(now - startNs));
    const elapsedMs = roundMs(nsToMs(now - t0));
    const entry = {
      printAttemptId,
      stage,
      durationMs,
      elapsedMs,
      ...sanitizeExtra(extra),
    };
    emit(entry);
    return entry;
  }

  function mark(stage, extra = {}) {
    return record(stage, nowNs(), extra);
  }

  function markSinceStart(stage, extra = {}) {
    return record(stage, t0, extra);
  }

  function fail(stage, err, extra = {}) {
    const { startNs, ...rest } = extra;
    return record(stage, startNs != null ? startNs : nowNs(), {
      ok: false,
      timeout: isTimeoutError(err),
      errorCode: err?.code || rest.errorCode || null,
      error: safeErrorMessage(err),
      ...rest,
    });
  }

  async function time(stage, fn, extra = {}) {
    const startNs = nowNs();
    try {
      const result = await fn();
      record(stage, startNs, { ok: true, ...extra });
      return result;
    } catch (err) {
      record(stage, startNs, {
        ok: false,
        timeout: isTimeoutError(err),
        errorCode: err?.code || extra.errorCode || null,
        error: safeErrorMessage(err),
        ...extra,
      });
      throw err;
    }
  }

  function finish(extra = {}) {
    return record("helper_request_done", t0, {
      ok: extra.ok !== false,
      ...extra,
    });
  }

  return {
    printAttemptId,
    mark,
    markSinceStart,
    fail,
    time,
    finish,
    flush: flushTimingLog,
  };
}
