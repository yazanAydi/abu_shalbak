import {
  isDevToolsShortcut,
  isRecentScannerBurst,
  noteScannerKey,
  resetScannerBurstForTests,
  shouldBlockBrowserShortcut,
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

  test("F12 is always blocked even without a scan burst", () => {
    expect(shouldBlockBrowserShortcut(keyEvent({ key: "F12", code: "F12" }))).toBe(
      true
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
  });
});
