import { shouldHandleEnterOnField } from "./focusNavigation";

describe("POS focus navigation", () => {
  test("Enter in the ذمة notes textarea does not move focus or submit", () => {
    const el = document.createElement("textarea");
    expect(shouldHandleEnterOnField(el, { key: "Enter" })).toBe(false);
  });
});
