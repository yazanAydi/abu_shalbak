import { focusEditableOnTap } from "./focusEditableOnTap";

test("tapping editable search, quantity and expiry text focuses synchronously", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "virtualKeyboard");
  const show = jest.fn();
  Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: { show } });
  const root = document.createElement("div");
  root.innerHTML = '<input type="text"><input type="number" inputmode="decimal"><input type="text" inputmode="numeric"><input type="date"><input readonly><input disabled>';
  document.body.appendChild(root);
  root.addEventListener("click", focusEditableOnTap);
  try {
    const inputs = [...root.querySelectorAll("input")];
    for (const input of inputs.slice(0, 3)) {
      input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("");
    }
    expect(show).toHaveBeenCalledTimes(3);
    for (const input of inputs.slice(3)) input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(show).toHaveBeenCalledTimes(3);
    expect(inputs[4].readOnly).toBe(true);
    expect(inputs[5].disabled).toBe(true);
  } finally {
    root.remove();
    if (original) Object.defineProperty(navigator, "virtualKeyboard", original);
    else delete navigator.virtualKeyboard;
  }
});

test("focus works without a virtual keyboard API and ignores cancelled taps", () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  try {
    focusEditableOnTap({ target: input, defaultPrevented: true });
    expect(document.activeElement).not.toBe(input);
    focusEditableOnTap({ target: input });
    expect(document.activeElement).toBe(input);
  } finally { input.remove(); }
});
