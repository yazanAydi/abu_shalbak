import {
  isDevToolsShortcut,
  isRecentScannerBurst,
  noteScannerKey,
  resetScannerBurstForTests,
  shouldBlockBrowserShortcut,
  SCANNER_SUBMIT_EVENT,
  installBlockDevToolsShortcuts,
} from "./blockDevToolsShortcuts";

function keyEvent(partial) {
  return {
    key: "",
    code: "",
    keyCode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    stopImmediatePropagation: jest.fn(),
    ...partial,
  };
}

describe("blockDevToolsShortcuts", () => {
  beforeEach(() => {
    resetScannerBurstForTests();
  });

  test("F12 and Ctrl+Shift+J are DevTools shortcuts", () => {
    expect(isDevToolsShortcut(keyEvent({ key: "F12", code: "F12", keyCode: 123 }))).toBe(
      true
    );
    expect(
      isDevToolsShortcut(keyEvent({ key: "J", ctrlKey: true, shiftKey: true }))
    ).toBe(true);
    expect(isDevToolsShortcut(keyEvent({ key: "F9" }))).toBe(false);
  });

  test("F12 is not blocked unless a scanner burst just happened", () => {
    expect(shouldBlockBrowserShortcut(keyEvent({ key: "F12", code: "F12" }))).toBe(
      false
    );
  });

  test("noteScannerKey ignores events with a missing key", () => {
    expect(() => noteScannerKey({ ctrlKey: false, altKey: false, metaKey: false })).not.toThrow();
    expect(() => noteScannerKey({ key: undefined, ctrlKey: false })).not.toThrow();
    expect(isRecentScannerBurst()).toBe(false);
  });

  test("Ctrl+P is blocked only after a scanner-like digit burst", () => {
    const print = keyEvent({ key: "p", ctrlKey: true });
    expect(shouldBlockBrowserShortcut(print)).toBe(false);
    for (const d of "7290001") {
      noteScannerKey(keyEvent({ key: d }));
    }
    expect(isRecentScannerBurst()).toBe(true);
    expect(shouldBlockBrowserShortcut(print)).toBe(true);
    expect(shouldBlockBrowserShortcut(keyEvent({ key: "F12", code: "F12" }))).toBe(true);
  });

  test("F12 after a scan burst asks the focused field to submit once", () => {
    const dispose = installBlockDevToolsShortcuts();
    const input = document.createElement("input");
    const submits = [];
    input.addEventListener(SCANNER_SUBMIT_EVENT, () => submits.push("go"));
    document.body.appendChild(input);
    input.focus();
    for (const d of "00012345") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: d, bubbles: true, cancelable: true })
      );
    }
    const f12 = new KeyboardEvent("keydown", {
      key: "F12",
      code: "F12",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(f12);
    expect(submits).toEqual(["go"]);
    input.remove();
    dispose();
  });
});
