import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import WeighedProductFields from "./WeighedProductFields";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const empty = {
  barcode: "",
  scale_code: "",
  is_weighed: false,
  scale_only: false,
  unit: "حبة",
  package_conversion: "1",
  package_price: "5",
};

function Harness() {
  const [form, setForm] = useState(empty);
  return (
    <div>
      <WeighedProductFields form={form} onChange={setForm} />
      <output data-testid="scale">{form.scale_code}</output>
      <output data-testid="unit">{form.unit}</output>
    </div>
  );
}

describe("WeighedProductFields", () => {
  test("scale-only hides piece sale, requires the PLU, and keeps zeros", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });

    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(container.textContent).toContain("يباع بالميزان فقط");
    expect(container.textContent).toContain("وزن الحبة");

    act(() => {
      boxes[0].click();
    });

    expect(container.textContent).toContain("كود الميزان / PLU");
    expect(container.textContent).not.toContain("وزن الحبة");
    expect(container.textContent).not.toContain("سعر الحبة");
    expect(container.querySelector('[data-testid="unit"]').textContent).toBe("كغم");
    const after = container.querySelectorAll('input[type="checkbox"]');
    expect(after[1].disabled).toBe(true);

    const input = container.querySelector('input[placeholder="2100003"]');
    expect(input.required).toBe(true);
    expect(input.type).not.toBe("number");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(input, "0210003");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="scale"]').textContent).toBe("0210003");

    act(() => {
      setter.call(input, "2100100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="scale"]').textContent).toBe("2100100");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
