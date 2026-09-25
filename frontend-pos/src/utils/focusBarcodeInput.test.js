import {
  focusBarcodeInput,
  isBarcodeFocusSurface,
  registerBarcodeInput,
  shouldKeepCurrentFocus,
} from "./focusBarcodeInput";

describe("focusBarcodeInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    registerBarcodeInput(null);
  });

  test("focuses the registered scan field", () => {
    document.body.innerHTML = '<input class="barcode-input" />';
    const input = document.querySelector(".barcode-input");
    registerBarcodeInput(input);
    const focus = jest.spyOn(input, "focus");
    expect(focusBarcodeInput()).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  test("does not steal focus from a payment dialog, note, or quantity field", () => {
    document.body.innerHTML = `
      <input class="barcode-input" />
      <div class="pos-modal" role="dialog"><textarea class="note"></textarea></div>
      <input class="pos-qty-input" />
    `;
    const scan = document.querySelector(".barcode-input");
    const focus = jest.spyOn(scan, "focus");
    document.querySelector(".note").focus();
    focusBarcodeInput();
    document.querySelector(".pos-qty-input").focus();
    focusBarcodeInput();
    expect(focus).not.toHaveBeenCalled();
  });

  test("returns to the scan field after a finished cart edit", () => {
    document.body.innerHTML = `
      <input class="barcode-input" />
      <input class="pos-qty-input" />
    `;
    const scan = document.querySelector(".barcode-input");
    const qty = document.querySelector(".pos-qty-input");
    qty.focus();
    const focus = jest.spyOn(scan, "focus");
    expect(focusBarcodeInput({ releaseCartEdit: true })).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  test("keeps a dialog even when focus has already left it", () => {
    document.body.innerHTML = `
      <input class="barcode-input" />
      <div role="dialog"><input class="amount" /></div>
    `;
    document.body.focus();
    expect(shouldKeepCurrentFocus(document.activeElement)).toBe(true);
    expect(focusBarcodeInput()).toBe(false);
  });

  test("blank cart space is a scan surface and suggestions are not", () => {
    document.body.innerHTML = `
      <div class="pos-screen">
        <section class="pos-cart-panel"><div class="pad"></div></section>
        <ul class="search-dropdown"><li role="option">حليب</li></ul>
      </div>
    `;
    expect(isBarcodeFocusSurface(document.querySelector(".pad"))).toBe(true);
    expect(isBarcodeFocusSurface(document.querySelector("[role='option']"))).toBe(false);
  });
});