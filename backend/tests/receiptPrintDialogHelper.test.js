import {
  createReceiptPrintDialogHelper,
} from "../services/receiptPrintDialogHelper.js";
import { shouldConfirmPrintDialog } from "../utils/receiptPrintDialogMatch.js";

describe("shouldConfirmPrintDialog", () => {
  const base = {
    armed: true,
    requestId: "job-1",
    dialogName: "Print",
    printerName: "RONGTA 80mm Series Printer",
    dialogPrinterName: "RONGTA 80mm Series Printer",
    ownerPids: [100, 200],
    dialogProcessId: 100,
    printButtonEnabled: true,
  };

  test("confirms only an armed matching dialog", () => {
    expect(shouldConfirmPrintDialog(base)).toEqual({ confirm: true, reason: "ok" });
  });

  test("rejects unarmed, wrong printer, other owner, or disabled Print", () => {
    expect(shouldConfirmPrintDialog({ ...base, armed: false }).confirm).toBe(false);
    expect(shouldConfirmPrintDialog({ ...base, dialogPrinterName: "Microsoft Print to PDF" }).reason).toBe(
      "printer-mismatch"
    );
    expect(shouldConfirmPrintDialog({ ...base, dialogProcessId: 999 }).reason).toBe("owner-mismatch");
    expect(shouldConfirmPrintDialog({ ...base, printButtonEnabled: false }).reason).toBe("print-disabled");
  });
});

describe("createReceiptPrintDialogHelper", () => {
  function makeHelper(overrides = {}) {
    return createReceiptPrintDialogHelper({
      printerName: "RONGTA 80mm Series Printer",
      findOwnerPids: async () => [42],
      printHtml: async () => ({ printed: true, printer: "RONGTA 80mm Series Printer" }),
      confirmDialog: async () => ({ confirm: true, reason: "ok" }),
      ...overrides,
    });
  }

  test("arm requires the POS window and exact printer", async () => {
    const helper = makeHelper();
    const badPrinter = await helper.arm({
      requestId: "a",
      ownerTitle: "أبو شلبك — نقطة البيع · a",
      printerName: "Other",
      transactionId: 1,
    });
    expect(badPrinter.ok).toBe(false);
    expect(badPrinter.code).toBe("PRINTER_MISMATCH");

    const noWindow = makeHelper({ findOwnerPids: async () => [] });
    const missing = await noWindow.arm({
      requestId: "a",
      ownerTitle: "أبو شلبك — نقطة البيع · a",
      printerName: "RONGTA 80mm Series Printer",
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("NO_POS_WINDOW");
  });

  test("print runs only after arm and then disarms", async () => {
    const helper = makeHelper();
    await helper.arm({
      requestId: "job-2",
      ownerTitle: "أبو شلبك — نقطة البيع · job-2",
      printerName: "RONGTA 80mm Series Printer",
      transactionId: 88,
    });
    const skipped = await helper.printArmed({ requestId: "other", html: "<p>x</p>" });
    expect(skipped.ok).toBe(false);
    expect(skipped.code).toBe("NOT_ARMED");

    const printed = await helper.printArmed({ requestId: "job-2", html: "<p>إيصال</p>" });
    expect(printed.ok).toBe(true);
    expect(printed.printed).toBe(true);
    expect(helper.getArmed()).toBeNull();
  });

  test("printDirect prints without window lookup or arm", async () => {
    const calls = { find: 0, confirm: 0, print: 0 };
    const helper = makeHelper({
      findOwnerPids: async () => {
        calls.find += 1;
        return [];
      },
      confirmDialog: async () => {
        calls.confirm += 1;
        return { confirm: true };
      },
      printHtml: async () => {
        calls.print += 1;
        return { printed: true, printer: "RONGTA 80mm Series Printer" };
      },
    });
    const printed = await helper.printDirect({ html: "<p>إيصال</p>", transactionId: 37 });
    expect(printed).toEqual({
      ok: true,
      printed: true,
      printer: "RONGTA 80mm Series Printer",
      transactionId: 37,
    });
    expect(calls).toEqual({ find: 0, confirm: 0, print: 1 });
  });

  test("printDirect requires printer and HTML", async () => {
    const noPrinter = createReceiptPrintDialogHelper({
      printerName: "",
      printHtml: async () => ({ printed: true }),
    });
    expect(await noPrinter.printDirect({ html: "<p>x</p>" })).toMatchObject({
      ok: false,
      code: "NO_PRINTER",
    });
    const helper = makeHelper();
    expect(await helper.printDirect({ html: "  " })).toMatchObject({ ok: false, code: "NO_HTML" });
  });

  test("printDirect allows a missing printer only in explicit testSave", async () => {
    const helper = createReceiptPrintDialogHelper({
      printerName: "",
      testSave: true,
      printHtml: async () => ({ printed: true, testMode: true, pdfPath: "tmp/receipt-test/x.pdf" }),
    });
    expect(await helper.printDirect({ html: "<p>x</p>", transactionId: 9 })).toMatchObject({
      ok: true,
      printed: true,
      testMode: true,
      pdfPath: "tmp/receipt-test/x.pdf",
      transactionId: 9,
    });
  });

  test("printDirect testMode is not treated as hardware proof", async () => {
    const helper = makeHelper({
      printHtml: async () => ({ printed: true, testMode: true, pdfPath: "tmp/receipt-test/x.pdf" }),
    });
    const printed = await helper.printDirect({ html: "<p>x</p>", transactionId: 1 });
    expect(printed.ok).toBe(true);
    expect(printed.testMode).toBe(true);
    expect(printed.pdfPath).toBe("tmp/receipt-test/x.pdf");
  });

  test("print failure clears the arm so the sale is not retried here", async () => {
    const helper = makeHelper({
      printHtml: async () => {
        const err = new Error("spooler");
        err.code = "PRINT_FAILED";
        throw err;
      },
    });
    await helper.arm({
      requestId: "job-3",
      ownerTitle: "أبو شلبك — نقطة البيع · job-3",
      printerName: "RONGTA 80mm Series Printer",
    });
    const failed = await helper.printArmed({ requestId: "job-3", html: "<p>x</p>" });
    expect(failed.ok).toBe(false);
    expect(helper.getArmed()).toBeNull();
  });
});
