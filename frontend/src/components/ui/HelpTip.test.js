import { act } from "react";
import { createRoot } from "react-dom/client";
import HelpTip from "./HelpTip";
import { FormField, Input } from "./Field";

function render(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("HelpTip", () => {
  it("toggles by click and closes on Escape", () => {
    const { container, unmount } = render(<HelpTip>شرح الرصيد</HelpTip>);
    const btn = container.querySelector("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[role='note']").textContent).toBe("شرح الرصيد");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    unmount();
  });
});

describe("FormField", () => {
  it("wires label, required, and error", () => {
    const { container, unmount } = render(
      <FormField label="الاسم" required error="الاسم مطلوب">
        <Input />
      </FormField>
    );
    const input = container.querySelector("input");
    const label = container.querySelector("label");
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector("[role='alert']").textContent).toBe("الاسم مطلوب");
    expect(container.textContent).toContain("مطلوب");
    unmount();
  });
});
