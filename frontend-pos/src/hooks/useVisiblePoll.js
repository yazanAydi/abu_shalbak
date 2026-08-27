import { useEffect, useRef } from "react";

/**
 * Polls on an interval, but only while the tab is visible, and refreshes once
 * immediately when the user comes back to it.
 *
 * A background tab polling every few seconds is pure waste, and it is expensive
 * when the app is reached over the Tailscale tunnel from a phone, where every
 * request pays the round trip twice and keeps the radio awake.
 *
 * @param {() => void} callback — invoked on each tick; always the latest closure.
 * @param {number} intervalMs — interval to use while visible.
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] — set false to stop polling entirely.
 * @param {number} [options.hiddenIntervalMs] — when set, keep polling this slowly
 *   while hidden instead of pausing. Use for screens where a missed update
 *   matters, such as the approval queues.
 */
export function useVisiblePoll(callback, intervalMs, options = {}) {
  const { enabled = true, hiddenIntervalMs } = options;

  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return undefined;

    let timer = null;

    const clear = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clear();
      const ms = document.visibilityState === "hidden" ? hiddenIntervalMs : intervalMs;
      if (ms == null) return;
      timer = window.setInterval(() => callbackRef.current(), ms);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") callbackRef.current();
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, hiddenIntervalMs]);
}

export default useVisiblePoll;
