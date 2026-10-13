import { act } from "react";
import { createRoot } from "react-dom/client";
import DuplicateProductDialog from "./DuplicateProductDialog";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function renderDialog(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function update(next) {
    act(() => {
      root.render(<DuplicateProductDialog open productName="حليب" {...next} />);
    });
  }
  update(props);
  return {
    host,
    update,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe("duplicate product confirmation", () => {
  test("shows the Arabic prompt and does not confirm from Enter or a second click", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const view = renderDialog({ onConfirm, onCancel });
    expect(document.body.textContent).toContain("منتج مكرر");
    expect(document.body.textContent).toContain("الصنف «حليب» موجود مسبقاً في هذه الفاتورة. هل تريد إضافته مرة أخرى؟");
    expect(document.body.textContent).toContain("إضافة على أي حال");
    expect(document.body.textContent).toContain("إلغاء الإضافة");

    const add = document.querySelector("[data-testid='duplicate-add-anyway']");
    expect(document.activeElement).not.toBe(add);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => { add.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { await wait(400); });
    act(() => {
      add.click();
      add.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    view.cleanup();
  });

  test("cancel leaves confirmation unused", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const view = renderDialog({ onConfirm, onCancel });
    const cancel = document.querySelector("[data-testid='duplicate-cancel']");
    await act(async () => { await wait(400); });
    act(() => {
      cancel.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    view.cleanup();
  });
});
