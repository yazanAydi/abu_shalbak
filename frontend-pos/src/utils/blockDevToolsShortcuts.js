/**
 * Hardware scanners often send a suffix (F12, Ctrl+Shift+J, F1) after the
 * digits. Chromium handles those as DevTools before the page. JavaScript
 * cannot reliably block browser-reserved shortcuts — configure the scanner
 * terminator to Enter (docs/BARCODE_SCANNER.md).
 */

const DEVTOOLS_KEYS = new Set(["f1", "f12"]);
const DEVTOOLS_CTRL_SHIFT = new Set(["i", "j", "c"]);
const SCANNER_CTRL = new Set(["j", "p", "n", "t", "s"]);

const SCANNER_WINDOW_MS = 400;
const SCANNER_MIN_CHARS = 6;

export const SCANNER_SUBMIT_EVENT = "abo-scanner-submit";
export const SCANNER_RESERVED_KEY_EVENT = "abo-scanner-reserved-key";

let burstCount = 0;
let burstStarted = 0;

export function resetScannerBurstForTests() {
  burstCount = 0;
  burstStarted = 0;
}

export function noteScannerKey(e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey) return;
  if (typeof e.key !== "string" || e.key.length !== 1) return;
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

export function isDevToolsShortcut(e) {
  const key = keyName(e);
  if (DEVTOOLS_KEYS.has(key)) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && DEVTOOLS_CTRL_SHIFT.has(key)) return true;
  if (ctrl && !e.shiftKey && !e.altKey && key === "j") return true;
  return false;
}

export function isScannerStolenBrowserShortcut(e) {
  if (isDevToolsShortcut(e)) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl || e.altKey) return false;
  return SCANNER_CTRL.has(keyName(e));
}

export function shouldBlockBrowserShortcut(e) {
  if (!isRecentScannerBurst()) return false;
  return isScannerStolenBrowserShortcut(e);
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") {
    e.stopImmediatePropagation();
  }
  e.returnValue = false;
}

function notifyFocusedFieldToSubmit() {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el) return;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") return;
  el.dispatchEvent(new CustomEvent(SCANNER_SUBMIT_EVENT, { bubbles: true }));
}

function onKeyDown(e) {
  noteScannerKey(e);
  if (!shouldBlockBrowserShortcut(e)) return;
  swallow(e);
  notifyFocusedFieldToSubmit();
  if (isDevToolsShortcut(e) && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SCANNER_RESERVED_KEY_EVENT, { detail: { key: keyName(e) } })
    );
  }
}

function onKeyUp(e) {
  if (shouldBlockBrowserShortcut(e)) swallow(e);
}

export function installBlockDevToolsShortcuts() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const opts = { capture: true };
  window.addEventListener("keydown", onKeyDown, opts);
  window.addEventListener("keyup", onKeyUp, opts);
  return () => {
    window.removeEventListener("keydown", onKeyDown, opts);
    window.removeEventListener("keyup", onKeyUp, opts);
  };
}
