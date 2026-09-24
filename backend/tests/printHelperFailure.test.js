import { printPdfFile, setPdfPrinterForTests, silentPrintErrorFromHelper } from "../services/windowsSilentPrint.js";

describe("print helper failures", () => {
  afterEach(() => {
    setPdfPrinterForTests(null);
  });

  test("a missing printer is a missing resource and hides the helper path", async () => {
    setPdfPrinterForTests(async () => {
      throw new Error(
        'Command failed: SumatraPDF.exe -print-to "Missing Demo Printer" C:\\Users\\secret\\receipt.pdf: The printer doesn\'t exist'
      );
    });
    await expect(printPdfFile("C:\\Users\\secret\\receipt.pdf", "Missing Demo Printer")).rejects.toMatchObject({
      code: "NO_PRINTER",
      message: "تم حفظ البيع وتعذرت الطباعة. الطابعة المحددة غير موجودة.",
    });
  });

  test("any other helper failure stays a print-service error without a stack", async () => {
    const err = silentPrintErrorFromHelper(
      new Error("Error: spawn SumatraPDF.exe ENOENT\n    at ChildProcess.<anonymous> (C:\\app\\print.js:12:5)")
    );
    expect(err.code).toBe("PRINT_FAILED");
    expect(err.message).toBe("تم حفظ البيع وتعذرت الطباعة.");
    expect(err.message).not.toMatch(/Sumatra|secret|at ChildProcess/);
  });
});
