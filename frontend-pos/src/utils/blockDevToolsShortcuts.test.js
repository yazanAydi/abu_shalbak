import {
  isDevToolsShortcut,
  noteScannerKey,
  resetScannerBurstForTests,
  shouldBlockBrowserShortcut,
} from "./blockDevToolsShortcuts";

describe("blockDevToolsShortcuts", () => {
  beforeEach(() => {
    resetScannerBurstForTests();
  });

  test("F12 is a DevTools shortcut but is not blocked without a scan burst", () => {
    expect(isDevToolsShortcut({ key: "F12", code: "F12", keyCode: 123 })).toBe(true);
    expect(shouldBlockBrowserShortcut({ key: "F12", code: "F12" })).toBe(false);
  });

  test("F12 is best-effort blocked only after a scanner digit burst", () => {
    for (const d of "7290001") {
      noteScannerKey({ key: d, ctrlKey: false, altKey: false, metaKey: false });
    }
    expect(shouldBlockBrowserShortcut({ key: "F12", code: "F12" })).toBe(true);
  });
});
