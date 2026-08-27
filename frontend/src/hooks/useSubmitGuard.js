import { useCallback, useRef } from "react";

/** Ignore overlapping clicks while an async submit is still in flight. */
export function useSubmitGuard() {
  const inflight = useRef(false);
  return useCallback(async (fn) => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      return await fn();
    } finally {
      inflight.current = false;
    }
  }, []);
}
