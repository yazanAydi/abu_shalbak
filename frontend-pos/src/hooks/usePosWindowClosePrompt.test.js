import { act } from "react";
import { createRoot } from "react-dom/client";
import { usePosWindowClosePrompt } from "./usePosWindowClosePrompt";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function Probe({ enabled, onPrompt }) {
  usePosWindowClosePrompt(enabled, onPrompt);
  return null;
}

describe("POS window close prompt", () => {
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

  test("closing the window opens the leave choice while a shift is open", () => {
    const onPrompt = jest.fn();
    act(() => {
      root.render(<Probe enabled onPrompt={onPrompt} />);
    });

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onPrompt).toHaveBeenCalled();
  });

  test("does not ask after the shift is already closed", () => {
    const onPrompt = jest.fn();
    act(() => {
      root.render(<Probe enabled={false} onPrompt={onPrompt} />);
    });

    act(() => {
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true })
      );
    });

    expect(onPrompt).not.toHaveBeenCalled();
  });
});
