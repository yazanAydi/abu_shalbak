global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import TimeField from "../components/ui/TimeField";
import DateField from "../components/ui/DateField";

function render(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function TimeHarness({ onValue }) {
  const [value, setValue] = useState("");
  return (
    <TimeField
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onValue?.(e.target.value);
      }}
    />
  );
}

describe("attendance time and date fields", () => {
  test("keeps an intermediate time and caret until blur", () => {
    const { container, unmount } = render(<TimeHarness />);
    const input = container.querySelector("input");
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      input.focus();
      setValue.call(input, "0830");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.setSelectionRange(2, 2);
    expect(input.value).toBe("0830");
    expect(input.selectionStart).toBe(2);
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("0830");
    expect(input.selectionStart).toBe(2);
    act(() => {
      input.blur();
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    expect(input.value).toBe("08:30");
    unmount();
  });

  test("a four-digit date stays as typed until the year is complete", () => {
    let iso = "";
    const { container, unmount } = render(
      <DateField
        yearDigits={4}
        keepInvalid
        value={iso}
        onChange={(e) => {
          iso = e.target.value;
        }}
      />
    );
    const input = container.querySelector('input[type="text"]');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      input.focus();
      setValue.call(input, "24/09/20");
      input.setSelectionRange(8, 8);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("24/09/20");
    expect(input.selectionStart).toBe(8);
    expect(iso).toBe("");
    expect(input.getAttribute("dir")).toBe("ltr");
    unmount();
  });
});
