/**
 * Hardware scanners often send a suffix (F12, Ctrl+Shift+J, F1) after the
 * digits. Chromium treats those as "open DevTools / Help", so the Console
 * docks over the admin page on every scan.
 */

const DEVTOOLS_KEYS = new Set(["f1", "f12"]);
const DEVTOOLS_CTRL_SHIFT = new Set(["i", "j", "c"]);
const SCANNER_CTRL = new Set(["j", "p", "n", "t", "s"]);

const SCANNER_WINDOW_MS = 400;
const SCANNER_MIN_CHARS = 6;

let burstCount = 0;
let burstStarted = 0;

export function resetScannerBurstForTests() {
  burstCount = 0;
  burstStarted = 0;
}

export function noteScannerKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key.length !== 1) return;
  const now = Date.now();
  if (now - burstStarted > SCANNER_WINDOW_MS) {
    burstCount = 0;
    burstStarted = now;
  }
  burstCount += 1;
}

export function isRecentScannerBurst(now = Date.now()) {
  return burstCount >= SCANNER_MIN_CHARS && now - burstStarted <= SCANNER_WINDOW_MS + 80;
}

function keyName(e) {
  if (e.key === "F12" || e.code === "F12" || e.keyCode === 123) return "f12";
  if (e.key === "F1" || e.code === "F1" || e.keyCode === 112) return "f1";
  return String(e.key || "").toLowerCase();
}

/** F12 / F1 / Ctrl+Shift+I|J|C / Ctrl+J — these open DevTools, Console, or Help. */
export function isDevToolsShortcut(e) {
  const key = keyName(e);
  if (DEVTOOLS_KEYS.has(key)) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && DEVTOOLS_CTRL_SHIFT.has(key)) return true;
  if (ctrl && !e.shiftKey && !e.altKey && key === "j") return true;
  return false;
}

/** Extra browser chrome (print / new tab) that a scanner suffix can trigger. */
export function isScannerStolenBrowserShortcut(e) {
  if (isDevToolsShortcut(e)) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl || e.altKey) return false;
  return SCANNER_CTRL.has(keyName(e));
}

export function shouldBlockBrowserShortcut(e) {
  if (isDevToolsShortcut(e)) return true;
  return isRecentScannerBurst() && isScannerStolenBrowserShortcut(e);
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") {
    e.stopImmediatePropagation();
  }
  e.returnValue = false;
}

function onKeyDown(e) {
  noteScannerKey(e);
  if (shouldBlockBrowserShortcut(e)) swallow(e);
}

function onKeyUp(e) {
  if (shouldBlockBrowserShortcut(e)) swallow(e);
}

function tryKeyboardLock() {
  const lock = navigator.keyboard?.lock;
  if (typeof lock !== "function") return;
  lock.call(navigator.keyboard, ["F12", "F1"]).catch(() => {});
}

/** Install once at app boot. Returns a disposer for tests. */
export function installBlockDevToolsShortcuts() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const opts = { capture: true };
  window.addEventListener("keydown", onKeyDown, opts);
  window.addEventListener("keyup", onKeyUp, opts);
  document.addEventListener("pointerdown", tryKeyboardLock, { once: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, opts);
    window.removeEventListener("keyup", onKeyUp, opts);
  };
}
