import {
  isDevToolsShortcut,
  shouldBlockBrowserShortcut,
} from "./blockDevToolsShortcuts";

describe("blockDevToolsShortcuts", () => {
  test("F12 is always treated as a DevTools shortcut", () => {
    expect(isDevToolsShortcut({ key: "F12", code: "F12", keyCode: 123 })).toBe(true);
    expect(shouldBlockBrowserShortcut({ key: "F12", code: "F12" })).toBe(true);
  });
});
