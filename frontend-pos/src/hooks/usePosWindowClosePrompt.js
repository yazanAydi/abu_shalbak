import { useEffect } from "react";
import { flushSync } from "react-dom";

function isWindowCloseKey(event) {
  const altF4 = event.altKey && (event.key === "F4" || event.code === "F4");
  const ctrlW = (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "w";
  return altF4 || ctrlW;
}

/**
 * Ask before the cashier leaves an open shift. The browser still shows its own
 * leave warning on the window X; this opens our logout / end-shift choice as well.
 * @param {boolean} enabled
 * @param {() => void} onPrompt
 */
export function usePosWindowClosePrompt(enabled, onPrompt) {
  useEffect(() => {
    if (!enabled) return undefined;

    let timer = 0;
    function showPrompt() {
      try {
        flushSync(() => onPrompt());
      } catch {
        onPrompt();
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(onPrompt, 0);
    }

    function onBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = true;
      showPrompt();
    }

    function onKeyDown(event) {
      if (!isWindowCloseKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      showPrompt();
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled, onPrompt]);
}
