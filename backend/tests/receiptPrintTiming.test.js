import {
  RECEIPT_PRINT_TIMING_PREFIX,
  createReceiptPrintAttempt,
} from "../utils/receiptPrintTiming.js";
import { createReceiptPrintDialogHelper } from "../services/receiptPrintDialogHelper.js";

function parseTimingLines(lines) {
  return lines.map((line) => {
    expect(line.startsWith(`${RECEIPT_PRINT_TIMING_PREFIX} `)).toBe(true);
    return JSON.parse(line.slice(RECEIPT_PRINT_TIMING_PREFIX.length + 1));
  });
}

describe("receipt print timing", () => {
  test("records stage durationMs and cumulative elapsedMs on a monotonic clock", async () => {
    const lines = [];
    const attempt = createReceiptPrintAttempt({ write: (line) => lines.push(line) });
    attempt.markSinceStart("receipt_received", { ok: true, htmlBytes: 120, transactionId: 9 });
    await attempt.time("measure_browser_ready", async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    await attempt.time("pdf_generation", async () => {
      await new Promise((r) => setTimeout(r, 15));
    }, { virtualTimeBudgetMs: 3000 });
    const done = attempt.finish({ ok: true });
    const events = parseTimingLines(lines);
    expect(events.map((e) => e.stage)).toEqual([
      "receipt_received",
      "measure_browser_ready",
      "pdf_generation",
      "helper_request_done",
    ]);
    expect(new Set(events.map((e) => e.printAttemptId)).size).toBe(1);
    expect(attempt.printAttemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(events[1].durationMs).toBeGreaterThanOrEqual(20);
    expect(events[2].durationMs).toBeGreaterThanOrEqual(10);
    expect(events[0].elapsedMs).toBeLessThanOrEqual(events[1].elapsedMs);
    expect(events[1].elapsedMs).toBeLessThanOrEqual(events[2].elapsedMs);
    expect(events[2].elapsedMs).toBeLessThanOrEqual(events[3].elapsedMs);
    expect(done.durationMs).toBe(done.elapsedMs);
    expect(events[2].virtualTimeBudgetMs).toBe(3000);
  });

  test("marks timeouts and strips HTML, customer fields, and secrets", async () => {
    const lines = [];
    const attempt = createReceiptPrintAttempt({ write: (line) => lines.push(line) });
    const err = new Error("انتهت مهلة تجهيز الإيصال للطباعة");
    err.code = "PRINT_TIMEOUT";
    try {
      await attempt.time(
        "pdf_to_printer",
        async () => {
          throw err;
        },
        {
          html: "<div class='receipt'>علي محمد</div>",
          customer: "علي محمد",
          token: "secret-token",
          password: "x",
        }
      );
    } catch (e) {
      expect(e.code).toBe("PRINT_TIMEOUT");
    }
    const blob = lines.join("\n");
    expect(blob).not.toContain("<div");
    expect(blob).not.toContain("علي محمد");
    expect(blob).not.toContain("secret-token");
    const events = parseTimingLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: "pdf_to_printer",
      ok: false,
      timeout: true,
      errorCode: "PRINT_TIMEOUT",
    });
    expect(events[0].html).toBeUndefined();
    expect(events[0].customer).toBeUndefined();
    expect(events[0].token).toBeUndefined();
    expect(events[0]).not.toHaveProperty("htmlBytes");
  });

  test("printDirect times one attempt, does not retry, and does not log HTML", async () => {
    const lines = [];
    const attempt = createReceiptPrintAttempt({ write: (line) => lines.push(line) });
    let calls = 0;
    const helper = createReceiptPrintDialogHelper({
      printerName: "RONGTA 80mm Series Printer",
      printHtml: async (html) => {
        calls += 1;
        expect(html).toContain("فاطمة");
        throw Object.assign(new Error("spooler"), { code: "PRINT_FAILED" });
      },
    });
    const result = await helper.printDirect(
      { html: "<p>فاطمة الزبون</p>", transactionId: 44 },
      attempt
    );
    expect(result).toMatchObject({ ok: false, code: "PRINT_FAILED" });
    expect(calls).toBe(1);
    const blob = lines.join("\n");
    expect(blob).not.toContain("فاطمة");
    expect(blob).not.toContain("<p>");
    const events = parseTimingLines(lines);
    expect(events[0]).toMatchObject({
      stage: "receipt_received",
      ok: true,
      transactionId: 44,
    });
    expect(events[0].htmlBytes).toBeGreaterThan(0);
    expect(events.some((e) => e.stage === "print_failed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ stage: "helper_request_done", ok: false });
  });
});
