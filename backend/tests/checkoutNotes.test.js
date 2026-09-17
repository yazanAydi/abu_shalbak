import {
  CHECKOUT_NOTES_MAX,
  checkoutPayloadHasOnAccount,
  normalizeCheckoutNotes,
  parseCheckoutNotes,
  resolveCheckoutNotes,
} from "../utils/checkoutNotes.js";

describe("checkout ذمة notes", () => {
  test("empty and whitespace notes are valid null", () => {
    expect(normalizeCheckoutNotes(null)).toBeNull();
    expect(normalizeCheckoutNotes("")).toBeNull();
    expect(normalizeCheckoutNotes("   \n  ")).toBeNull();
  });

  test("keeps Arabic text and internal newlines after trimming ends", () => {
    const notes = "  ملاحظة ذمة\nسطر ثاني  ";
    expect(normalizeCheckoutNotes(notes)).toBe("ملاحظة ذمة\nسطر ثاني");
  });

  test("rejects more than 500 characters", () => {
    expect(() => parseCheckoutNotes("م".repeat(CHECKOUT_NOTES_MAX + 1))).toThrow("500");
    expect(parseCheckoutNotes("م".repeat(CHECKOUT_NOTES_MAX))).toHaveLength(CHECKOUT_NOTES_MAX);
  });

  test("cash payloads ignore notes", () => {
    expect(checkoutPayloadHasOnAccount({ payment_method: "cash", notes: "x" })).toBe(false);
    expect(resolveCheckoutNotes({ payment_method: "cash", notes: "لا تحفظ" })).toBeNull();
    expect(
      resolveCheckoutNotes({ payment_method: "on_account", notes: "  احفظ  " })
    ).toBe("احفظ");
  });
});
