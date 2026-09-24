import { focusBarcodeInput } from "./focusBarcodeInput";

describe("focusBarcodeInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("focuses the scan field", () => {
    document.body.innerHTML = '<input class="barcode-input" />';
    const input = document.querySelector(".barcode-input");
    const focus = jest.spyOn(input, "focus");
    focusBarcodeInput();
    expect(focus).toHaveBeenCalled();
  });

  test("does not steal focus from a payment dialog or quantity field", () => {
    document.body.innerHTML = `
      <input class="barcode-input" />
      <div class="pos-modal" role="dialog"><input class="pay" /></div>
      <input class="pos-qty-input" />
    `;
    const scan = document.querySelector(".barcode-input");
    const focus = jest.spyOn(scan, "focus");
    document.querySelector(".pay").focus();
    focusBarcodeInput();
    document.querySelector(".pos-qty-input").focus();
    focusBarcodeInput();
    expect(focus).not.toHaveBeenCalled();
  });
});
