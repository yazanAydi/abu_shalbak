import { act } from "react";
import { createRoot } from "react-dom/client";
import PosLeaveChoiceModal from "./PosLeaveChoiceModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function clickButton(container, name) {
  const button = [...container.querySelectorAll("button")].find((el) => el.textContent === name);
  if (!button) throw new Error(`missing button ${name}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("POS leave choice", () => {
  let container;
  let root;

  async function renderModal(props) {
    await act(async () => {
      root.render(<PosLeaveChoiceModal open {...props} />);
    });
  }

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

  test("asks whether to log out or end the shift", async () => {
    const onLogout = jest.fn();
    const onEndShift = jest.fn();
    const onCancel = jest.fn();
    await renderModal({ onLogout, onEndShift, onCancel });

    expect(container.textContent).toContain("هل تريد تسجيل الخروج أم إنهاء الوردية؟");
    expect(container.textContent).not.toContain("يوجد أصناف");

    clickButton(container, "تسجيل الخروج");
    expect(onLogout).toHaveBeenCalledTimes(1);

    clickButton(container, "إنهاء الوردية");
    expect(onEndShift).toHaveBeenCalledTimes(1);

    clickButton(container, "إلغاء");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("warns that an open invoice will be lost", async () => {
    await renderModal({
      cartDirty: true,
      onLogout: jest.fn(),
      onEndShift: jest.fn(),
      onCancel: jest.fn(),
    });
    expect(container.textContent).toContain("يوجد أصناف في الفاتورة الحالية وستُفقد.");
  });

  test("Escape stays on the register", async () => {
    const onCancel = jest.fn();
    await renderModal({
      onLogout: jest.fn(),
      onEndShift: jest.fn(),
      onCancel,
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
