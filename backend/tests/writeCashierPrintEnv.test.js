import { buildCashierPrintEnv } from "../scripts/write-cashier-print-env.mjs";

describe("buildCashierPrintEnv", () => {
  test("writes printer and derived origin and keeps test-save off", () => {
    const { text, origin } = buildCashierPrintEnv({
      printer: "RONGTA 80mm Series Printer",
      posUrl: "http://192.168.1.10:3000/pos",
    });
    expect(origin).toBe("http://192.168.1.10:3000");
    expect(text).toContain("RECEIPT_PRINTER=RONGTA 80mm Series Printer");
    expect(text).toContain("RECEIPT_PRINT_ALLOWED_ORIGINS=http://192.168.1.10:3000");
    expect(text).toContain("RECEIPT_PRINT_POS_URL=http://192.168.1.10:3000/pos");
    expect(text).not.toMatch(/RECEIPT_PRINT_TEST_MODE=/);
  });

  test("preserves extra keys and strips test-save on update", () => {
    const { text } = buildCashierPrintEnv({
      existingText: "RECEIPT_PRINTER=Old\nRECEIPT_PRINT_TEST_MODE=save\nRECEIPT_PAPER_SIZE=80mm\n",
      printer: "RONGTA 80mm Series Printer",
      posUrl: "http://10.0.0.5:3000/pos",
    });
    expect(text).toContain("RECEIPT_PAPER_SIZE=80mm");
    expect(text).toContain("RECEIPT_PRINTER=RONGTA 80mm Series Printer");
    expect(text).not.toMatch(/RECEIPT_PRINT_TEST_MODE=/);
  });

  test("rejects a bad POS URL", () => {
    expect(() => buildCashierPrintEnv({ printer: "RONGTA", posUrl: "ftp://x" })).toThrow();
  });

  test("test-save allows no printer and writes RECEIPT_PRINT_TEST_MODE=save", () => {
    const { text, printer, testSave } = buildCashierPrintEnv({
      posUrl: "http://127.0.0.1:3002/pos",
      testSave: true,
    });
    expect(testSave).toBe(true);
    expect(printer).toBeNull();
    expect(text).toContain("RECEIPT_PRINT_TEST_MODE=save");
    expect(text).not.toMatch(/RECEIPT_PRINTER=/);
  });

  test("rejects a missing printer unless test-save is on", () => {
    expect(() => buildCashierPrintEnv({ posUrl: "http://127.0.0.1:3002/pos" })).toThrow(/اختر طابعة/);
  });
});
