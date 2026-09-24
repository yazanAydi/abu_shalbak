import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import CashCountFields, { countedNisTotal } from "./CashCountFields";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const rows = [
  { currency_id: 1, code: "ILS", name: "شيكل", symbol: "₪", rate: 1, is_base: true, expected_original: 0 },
  { currency_id: 2, code: "JOD", name: "دينار", symbol: "د.أ", rate: 5, is_base: false, expected_original: 0 },
  { currency_id: 3, code: "USD", name: "دولار", symbol: "$", rate: 3.7, is_base: false, expected_original: 0 },
];

function Harness() {
  const [values, setValues] = useState({});
  return (
    <div>
      <CashCountFields
        countRows={rows}
        values={values}
        onChange={(code, value) => setValues((prev) => ({ ...prev, [code]: value }))}
      />
      <output data-testid="total">{countedNisTotal(rows, values)}</output>
      <output data-testid="ils">{values.ILS ?? ""}</output>
      <output data-testid="jod">{values.JOD ?? ""}</output>
      <output data-testid="usd">{values.USD ?? ""}</output>
    </div>
  );
}

function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CashCountFields focus", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("keeps the same input focused while typing 77.50 and updates the shekel total", () => {
    const input = container.querySelectorAll("input")[0];
    const node = input;
    input.focus();
    let typed = "";
    for (const ch of "77.50") {
      typed += ch;
      act(() => setNativeValue(input, typed));
      expect(document.activeElement).toBe(node);
      expect(container.querySelectorAll("input")[0]).toBe(node);
    }
    expect(container.querySelector('[data-testid="ils"]').textContent).toBe("77.50");
    expect(container.querySelector('[data-testid="total"]').textContent).toBe("77.5");
    expect(container.textContent).toContain("بالشيكل");
  });

  test("allows empty and trailing dot, then edits the middle of each currency", () => {
    const inputs = () => [...container.querySelectorAll("input")];
    inputs().forEach((input, index) => {
      const node = input;
      input.focus();
      act(() => setNativeValue(input, "77."));
      expect(document.activeElement).toBe(node);
      expect(inputs()[index]).toBe(node);
      expect(inputs()[index].value).toBe("77.");

      act(() => setNativeValue(input, ""));
      expect(document.activeElement).toBe(node);
      expect(inputs()[index].value).toBe("");

      act(() => setNativeValue(input, "7750"));
      input.setSelectionRange(2, 4);
      const next = `77${"8"}`;
      act(() => setNativeValue(input, next));
      expect(document.activeElement).toBe(node);
      expect(inputs()[index].value).toBe("778");
    });
  });
});
