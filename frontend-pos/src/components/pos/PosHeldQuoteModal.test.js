import { act } from "react";
import { createRoot } from "react-dom/client";
import PosHeldQuoteModal from "./PosHeldQuoteModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

describe("held quote review", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test("shows the saved 50 and the current 10 before payment", async () => {
    const onConfirm = jest.fn();
    await act(async () => {
      root.render(
        <PosHeldQuoteModal
          open
          savedDiscount={50}
          savedPayable={170}
          currentDiscount={10}
          currentPayable={210}
          onConfirm={onConfirm}
          onDismiss={jest.fn()}
        />
      );
    });
    expect(container.textContent).toContain("₪50.00");
    expect(container.textContent).toContain("₪170.00");
    expect(container.textContent).toContain("₪10.00");
    expect(container.textContent).toContain("₪210.00");
    const button = [...container.querySelectorAll("button")].find((el) =>
      el.textContent.includes("اعتماد المبلغ الحالي")
    );
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
